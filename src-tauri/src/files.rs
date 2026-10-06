//! Файловый менеджер: дерево каталогов, git-статус, чекпоинты проекта.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
/// Запись для дерева файлов (M4.2)
#[derive(Debug, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    /// true только у ПОСЛЕДНЕЙ записи ответа: каталог обрезан лимитом.
    /// Аудит: усечение было молчаливым, UI скрывал часть каталога без
    /// единого намёка (fs_list модели при этом маркер ставил)
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

pub(crate) const LIST_DIR_LIMIT: usize = 500; // максимум записей на папку в ответе
pub(crate) const LIST_DIR_HARD_CAP: usize = 100_000; // защита от патологических каталогов

/// Запись git-статуса (M5.1): относительный путь + двухсимвольный код porcelain
#[derive(Debug, Serialize)]
pub struct GitEntry {
    pub path: String,
    pub code: String,
}

/// Git-статус папки проекта для подсветки дерева файлов.
/// Не-repo или отсутствие git — просто ошибка, фронт молча игнорирует.
/// Тело — в spawn_blocking: подпроцесс git на медленном/сетевом диске
/// блокировал бы воркер tokio.
#[tauri::command(async)]
pub async fn git_status(path: String) -> Result<Vec<GitEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || git_status_impl(path))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

/// Правила проекта (паттерн CLAUDE.md/.cursor/rules): AGENTS.md или CLAUDE.md
/// из корня проекта. None — ни одного файла нет. Имена фиксированы (никаких
/// путей от фронта, traversal исключён), потолок 32 КБ — простыня правил
/// не должна съедать контекст каждой отправки
#[tauri::command(async)]
pub async fn project_rules_read(root: String) -> Result<Option<String>, String> {
    // Корень проекта может быть сетевым: is_dir/чтение правил — в
    // blocking-пул (класс crypto_status)
    tauri::async_runtime::spawn_blocking(move || {
        // Путь с фронтенда — общий гардал системных локаций (модель settings.rs)
        crate::settings::rejects_sensitive_path(&root)?;
        let root = std::path::PathBuf::from(root.trim());
        if !root.is_dir() {
            return Ok(None);
        }
        for name in ["AGENTS.md", "CLAUDE.md"] {
            let p = root.join(name);
            if p.is_file() {
                let text = crate::fsutil::read_capped_string(&p, 32 * 1024)?;
                return Ok(Some(text));
            }
        }
        Ok(None)
    })
    .await
        .map_err(|e| format!("project rules task failed: {e}"))?
}

/// Один вызов git из вебвью: core.quotepath=false (не-ASCII пути (кириллица,
/// CJK) отдаются как есть — раньше октальные эскейпы "\320\277..." показывали
/// мусор), таймаут через proc::run_command_opts (git на сетевом диске/FUSE
/// раньше держал spawn_blocking-поток вечно). Err — stderr git-а
fn git_exec(cwd: &Path, args: &[&str], timeout: std::time::Duration) -> Result<String, String> {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-c").arg("core.quotepath=false").args(args).current_dir(cwd);
    let out = crate::proc::run_command_opts(&mut cmd, timeout, None, None)?;
    if let Some(code) = out.status {
        if code != 0 {
            let err = out.stderr.trim().to_string();
            return Err(if err.is_empty() {
                format!("git exited with {code}")
            } else {
                err
            });
        }
    } else if out.timed_out {
        return Err(format!("git {} timed out", args.first().unwrap_or(&"")));
    } else {
        // Ни кода выхода, ни таймаута: процесс убит сигналом (Unix) или не
        // запустился вовсе (proc пишет причину в stderr) — частичный stdout
        // успехом не является (№17 аудита v5)
        let err = out.stderr.trim().to_string();
        return Err(if err.is_empty() {
            format!(
                "git {} was killed by a signal or failed to start",
                args.first().unwrap_or(&"")
            )
        } else {
            err
        });
    }
    Ok(out.stdout)
}

/// Дифф ветки для кнопки «Review» в шапке чата (PLAN §23): против базовой
/// ветки собирается stat + полный дифф, фронт скармливает его агенту
/// как обычную задачу. Кодировка параметров: base идёт АРГУМЕНТОМ git
/// (без шелла — инъекции нет), но грязные формы отсекаем до вызова
#[derive(Debug, Serialize)]
pub struct BranchDiff {
    pub branch: String,
    pub base: String,
    pub stat: String,
    pub diff: String,
    /// true — дифф срезан по капе (маркер внутри текста не ставим: фронт
    /// сам докладывает модели об усечении)
    pub truncated: bool,
}

const GIT_DIFF_CAP: usize = 256 * 1024;

fn git_branch_diff_impl(root: String, base: String) -> Result<BranchDiff, String> {
    crate::settings::rejects_sensitive_path(&root)?;
    if base.is_empty()
        || base.starts_with('-')
        || !base
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '/' | '.' | '+'))
    {
        return Err(format!("invalid base branch: {base:?}"));
    }
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    // Существование базы: rev-parse даёт честную ошибку git-а наверх
    let base_ref = format!("{base}^{{commit}}");
    git_exec(&root_path, &["rev-parse", "--verify", &base_ref], std::time::Duration::from_secs(15))?;
    let branch = git_exec(
        &root_path,
        &["rev-parse", "--abbrev-ref", "HEAD"],
        std::time::Duration::from_secs(15),
    )?
    .trim()
    .to_string();
    let range = format!("{base}...HEAD");
    let stat = git_exec(&root_path, &["diff", "--stat", &range], std::time::Duration::from_secs(30))?;
    let mut diff = git_exec(&root_path, &["diff", &range], std::time::Duration::from_secs(30))?;
    let mut truncated = false;
    if diff.len() > GIT_DIFF_CAP {
        // Срез по границе UTF-8: паника на середине мультибайта недопустима
        let mut cut = GIT_DIFF_CAP;
        while cut > 0 && !diff.is_char_boundary(cut) {
            cut -= 1;
        }
        diff.truncate(cut);
        truncated = true;
    }
    Ok(BranchDiff {
        branch,
        base,
        stat,
        diff,
        truncated,
    })
}

#[tauri::command(async)]
pub async fn git_branch_diff(root: String, base: String) -> Result<BranchDiff, String> {
    tauri::async_runtime::spawn_blocking(move || git_branch_diff_impl(root, base))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

fn git_status_impl(path: String) -> Result<Vec<GitEntry>, String> {
    // Путь с фронтенда — общий гардал системных локаций (модель settings.rs):
    // git status исполняет core.fsmonitor-хелперы из конфига репозитория,
    // произвольный cwd из вебвью это эксплуатирует
    crate::settings::rejects_sensitive_path(&path)?;
    let text = git_exec(
        std::path::Path::new(&path),
        &["status", "--porcelain", "-z"],
        std::time::Duration::from_secs(15),
    )?;
    Ok(parse_porcelain_z(&text))
}

/// Разбор `git status --porcelain -z` (№14/№15 аудита v5): записи
/// NUL-терминированы, пути отдаются RAW — формат не порождает ни кавычек,
/// ни C-эскейпов (включая octal \NNN), поэтому весь класс «манглился путь
/// с кавычками/эскейпами» отсутствует в принципе; у переименований нет и
/// неоднозначности «a -> b -> c» (текстовый формат склеивает стороны
/// через " -> "). Формат записи: XY SP new\0[old\0] — у переименований и
/// копий исходный путь идёт ВТОРОЙ NUL-записью (проверено живым git),
/// нам он не нужен — берём новое имя
fn parse_porcelain_z(text: &str) -> Vec<GitEntry> {
    let mut out: Vec<GitEntry> = Vec::new();
    let mut records = text.split('\0');
    while let Some(rec) = records.next() {
        if rec.len() < 4 {
            // Хвостовой пустой элемент после последнего \0 и прочий мусор
            continue;
        }
        let code = rec[..2].trim().to_string();
        let path = rec[3..].to_string();
        if code.starts_with('R') || code.starts_with('C') {
            // Исходный путь переименования — следующая запись, пропускаем
            records.next();
        }
        out.push(GitEntry { path, code });
    }
    out
}

// ---------- Чекпоинты проекта (снимки файлов для отката агента) ----------

/// Папки, которые в снимок не попадают (тяжёлые и генерируемые)
const CP_SKIP_DIRS: &[&str] = &[
    ".git", "node_modules", "target", "dist", "build", "out", ".next",
    "__pycache__", ".venv", "venv", ".gradle", ".idea", ".vscode",
];
/// Максимальный размер одного файла в снимке
const CP_MAX_FILE: u64 = 512 * 1024;
/// Общий предел снимка — больше не тащим
const CP_MAX_TOTAL: u64 = 25 * 1024 * 1024;
/// Сколько последних чекпоинтов храним на проект
const CP_KEEP: usize = 20;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct CheckpointFile {
    /// Путь относительно корня проекта, с нативными разделителями ФС
    /// (раньше принудительно «\» — на Unix join делал из «src\main.rs»
    /// файл с литеральным бэкслэшем в имени, и откат на Unix был сломан)
    rel: String,
    /// Содержимое файла в base64 (бинарники тоже пишем без разбора)
    data: String,
}

/// Метаданные чекпоинта для списка
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CheckpointMeta {
    pub id: String,
    pub ts: u64,
    pub label: String,
    pub files: usize,
    pub bytes: u64,
    /// SHA коммита git-журнала (opt-in режим); None — только снапшот
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct CheckpointStore {
    root: String,
    label: String,
    ts: u64,
    files: Vec<CheckpointFile>,
}

/// Каталог снимков проекта: appdata/checkpoints/<sha256(путь)[..16]>
pub(crate) fn checkpoints_dir(app: &tauri::AppHandle, root: &str) -> Result<PathBuf, String> {
    use sha2::Digest;
    use tauri::Manager;
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let mut hasher = sha2::Sha256::new();
    // Единая модель регистра с perm.rs/platform.ts: Windows и macOS
    // (дефолтная APFS) регистронезависимы — Proj и proj это ОДИН каталог,
    // хэш обязан совпадать, иначе два регистра корня давали два каталога
    // чекпоинтов и история снимков «пропадала». Linux — регистрозависим
    #[cfg(windows)]
    hasher.update(root.replace('/', "\\").to_lowercase().as_bytes());
    #[cfg(target_os = "macos")]
    hasher.update(root.replace('\\', "/").to_lowercase().as_bytes());
    #[cfg(not(any(windows, target_os = "macos")))]
    hasher.update(root.replace('\\', "/").as_bytes());
    let hash = format!("{:x}", hasher.finalize());
    let dir = base.join("checkpoints").join(&hash[..16]);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Рекурсивный обход проекта: файлы в base64, с лимитами по размеру и объёму.
/// Junction/symlink-каталоги не открываются (петля = бесконечная рекурсия),
/// глубина ограничена на случай экзотических ФС, где флаг symlink не ставится.
pub(crate) fn collect_files(dir: &Path, root: &Path, files: &mut Vec<CheckpointFile>, total: &mut u64) {
    collect_files_at(dir, root, files, total, 0);
}

const CP_MAX_DEPTH: usize = 32;

/// Чувствительное имя на ЛЮБОМ компоненте rel (аудит A1-4). Тот же класс,
/// что у perm для fs_* — один источник правды, второй список не заводится.
/// Разделители нормализуются к нативному: root с «/» на Windows даёт
/// смешанный rel, который is_sensitive_path иначе не разобрал бы
fn rel_sensitive(rel: &str) -> bool {
    #[cfg(windows)]
    let norm = rel.replace('/', "\\");
    #[cfg(not(windows))]
    let norm = rel.replace('\\', "/");
    crate::perm::is_sensitive_path(&norm)
}

pub(crate) fn collect_files_at(
    dir: &Path,
    root: &Path,
    files: &mut Vec<CheckpointFile>,
    total: &mut u64,
    depth: usize,
) {
    if depth > CP_MAX_DEPTH || *total >= CP_MAX_TOTAL {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return, // недоступная папка — просто пропускаем
    };
    for entry in entries.flatten() {
        if *total >= CP_MAX_TOTAL {
            return;
        }
        let path = entry.path();
        // file_type() берётся из записи каталога и НЕ следует по symlink/junction
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            let name = entry.file_name();
            if CP_SKIP_DIRS.iter().any(|s| name.eq_ignore_ascii_case(s)) {
                continue;
            }
            collect_files_at(&path, root, files, total, depth + 1);
            if *total >= CP_MAX_TOTAL {
                return;
            }
        } else if meta.is_file() && meta.len() <= CP_MAX_FILE {
            let rel = match path.strip_prefix(root) {
                Ok(r) => r.to_string_lossy().to_string(),
                Err(_) => continue,
            };
            // Секрет-гард снимка (аудит A1-4): вложенные .env/.ssh/id_rsa/*.pem
            // раньше уезжали в снапшот base64-ом и читались через
            // checkpoint_files мимо perm-гардов (старый фильтр отсекал
            // только top-level точку)
            if rel_sensitive(&rel) {
                continue;
            }
            let Ok(bytes) = fs::read(&path) else { continue };
            *total += meta.len();
            files.push(CheckpointFile {
                rel,
                data: B64.encode(bytes),
            });
        }
    }
}

/// Проверка id (таймстамп + суффикс) — защита от обхода пути
pub fn cp_id_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 40
        && id
            .chars()
            .all(|c| c.is_ascii_digit() || c.is_ascii_lowercase() || c == '-')
}

/// Мета-сайдкар чекпоинта ({id}.meta.json): список чекпоинтов читает только
/// его — раньше ради ts/label/количества парсился весь снимок (base64 всех
/// файлов, до 25 МБ) на каждый файл
#[derive(Serialize, Deserialize)]
struct CheckpointMetaCar {
    ts: u64,
    label: String,
    files: usize,
    /// SHA коммита git-журнала (opt-in); serde default — старые сайдкары читаются
    #[serde(default, skip_serializing_if = "Option::is_none")]
    git: Option<String>,
}

#[tauri::command(async)]
pub async fn checkpoint_save(
    app: tauri::AppHandle,
    path: String,
    label: String,
    use_git: Option<bool>,
) -> Result<CheckpointMeta, String> {
    tauri::async_runtime::spawn_blocking(move || {
        checkpoint_save_impl(app, path, label, use_git.unwrap_or(false))
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Git-автокоммит перед правками прогона (Aider-паттерн): в git-репо
/// `git add -A` + commit с заданным сообщением. Best-effort: не репо,
/// нет git, нет user identity или нечего коммитить — тихо Ok(false),
/// автокоммит не должен ронять прогон
#[tauri::command(async)]
pub async fn git_autocommit(root: String, message: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || git_autocommit_impl(root, message))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

fn git_autocommit_impl(root: String, message: String) -> Result<bool, String> {
    // Путь с фронтенда — общий гардал системных локаций (модель settings.rs):
    // git add/commit в произвольном cwd из вебвью недопустим
    crate::settings::rejects_sensitive_path(&root)?;
    if !std::path::Path::new(&root).is_dir() {
        return Ok(false);
    }
    let dur = std::time::Duration::from_secs(60);
    // Мы вообще в репо?
    let mut rev = std::process::Command::new("git");
    rev.args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(&root);
    let probe = crate::proc::run_command_opts(&mut rev, dur, None, None)?;
    if probe.timed_out || probe.status != Some(0) || probe.stdout.trim() != "true" {
        return Ok(false);
    }
    // Есть ли изменения — пустое porcelain-состояние не коммитим
    let mut st = std::process::Command::new("git");
    st.args(["status", "--porcelain"]).current_dir(&root);
    let st_out = crate::proc::run_command_opts(&mut st, dur, None, None)?;
    if st_out.timed_out || st_out.status != Some(0) || st_out.stdout.trim().is_empty() {
        return Ok(false);
    }
    let mut add = std::process::Command::new("git");
    add.args(["add", "-A"]).current_dir(&root);
    let add_out = crate::proc::run_command_opts(&mut add, dur, None, None)?;
    if add_out.status != Some(0) {
        return Ok(false);
    }
    let mut commit = std::process::Command::new("git");
    commit.args(["commit", "-m", &message]).current_dir(&root);
    let commit_out =
        crate::proc::run_command_opts(&mut commit, dur, None, None)?;
    // Не-ноль (нет user identity и пр.) — не ошибка фичи: у пользователя
    // остаётся файловый чекпоинт
    Ok(commit_out.status == Some(0))
}

/// Обход дерева + base64 до 25 МБ — секунды работы, только вне tokio-воркера
/// Git в PATH? Режим чекпоинтов опциональный — отсутствие git не ошибка
fn git_available() -> bool {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("--version");
    hide_console_window(&mut cmd);
    cmd.output().map(|o| o.status.success()).unwrap_or(false)
}

/// Консольного окна нет и для служебного git (Windows); на Unix — no-op
fn hide_console_window(cmd: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

/// Один git-вызов с нашим GIT_DIR/GIT_WORK_TREE; возвращает trimmed stdout.
/// Синхронный — вызывается только из spawn_blocking. Таймаут через
/// proc::run_command_opts: зависший git (сетевой HOME, fsmonitor-хелпер,
/// антивирус) раньше вечно держал blocking-поток и checkpoint_save
/// (аудит A1-2 — git_exec был починен, git_run остался)
fn git_run(
    idx_dir: &Path,
    root: &Path,
    args: &[&str],
    envs: &[(&str, &str)],
    stdin: Option<&[u8]>,
) -> Result<String, String> {
    let mut cmd = std::process::Command::new("git");
    cmd.arg(format!("--git-dir={}", idx_dir.display()))
        .arg(format!("--work-tree={}", root.display()))
        .args(args);
    // GIT_* от родительского git (pre-commit хук → cargo test → этот Command)
    // перебивает резолв репозитория: относительный GIT_INDEX_FILE (.git/index)
    // уводит индекс из-под --git-dir, и add падает ENOENT на несуществующем
    // proj/.git. Явные флаги выше должны владеть резолвом — наследованное
    // git-окружение снимаем
    for k in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_COMMON_DIR",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_CEILING_DIRECTORIES",
    ] {
        cmd.env_remove(k);
    }
    for (k, v) in envs {
        cmd.env(k, v);
    }
    // run_command_opts сам ставит stdout/stderr-пайпы (голый spawn наследовал
    // stdio, wait_with_output читал None-хендлы и возвращал ПУСТОЙ stdout —
    // write-tree «успешно» отдавал пустоту), отсоединённо пишет stdin
    // и гасит дерево по таймауту
    let out = crate::proc::run_command_opts(
        &mut cmd,
        std::time::Duration::from_secs(30),
        stdin.map(|d| d.to_vec()),
        None,
    )?;
    if let Some(code) = out.status {
        if code != 0 {
            return Err(format!(
                "git {} failed (code {code}): stderr={} stdout={}",
                args.first().unwrap_or(&"?"),
                out.stderr,
                out.stdout
            ));
        }
    } else if out.timed_out {
        return Err(format!("git {} timed out", args.first().unwrap_or(&"?")));
    } else {
        // Ни кода, ни таймаута — убит сигналом/не запустился: частичный
        // stdout успехом не является (№17 аудита v5)
        return Err(format!(
            "git {} was killed by a signal or failed to start: {}",
            args.first().unwrap_or(&"?"),
            out.stderr
        ));
    }
    Ok(out.stdout.trim().to_string())
}

/// Ботовый автор журнала (ZCode-паттерн, блок 12 шаг 4): личные git-конфиги
/// пользователя не участвуют
const CP_GIT_AUTHOR: &[(&str, &str)] = &[
    ("GIT_AUTHOR_NAME", "Nocturn Checkpoint"),
    ("GIT_AUTHOR_EMAIL", "checkpoint@nocturn.local"),
    ("GIT_COMMITTER_NAME", "Nocturn Checkpoint"),
    ("GIT_COMMITTER_EMAIL", "checkpoint@nocturn.local"),
];

/// Git-журнал чекпоинта: отдельный GIT_DIR (git-index/) РЯДОМ со снапшотами —
/// пользовательский .git проекта не затрагивается. В коммит попадают ровно
/// те относительные пути, что записаны в снапшот (те же исключения и капы).
/// Коммиты сцеплены через HEAD — история проекта в «Контрольной точке».
fn git_checkpoint_journal(
    root: &Path,
    cp_dir: &Path,
    label: &str,
    rels: &[String],
) -> Result<String, String> {
    let idx = cp_dir.join("git-index");
    fs::create_dir_all(&idx).map_err(|e| e.to_string())?;
    git_run(&idx, root, &["init", "--quiet"], &[], None)?;
    // Пути — через stdin NUL-разделителем: командная строка не раздувается,
    // пробелы/юникод в путях не требуют кавычек
    let mut spec = Vec::with_capacity(rels.len() * 32);
    for r in rels {
        spec.extend_from_slice(r.replace('\\', "/").as_bytes());
        spec.push(0);
    }
    if !spec.is_empty() {
        git_run(
            &idx,
            root,
            &["add", "--pathspec-from-file=-", "--pathspec-file-nul", "--"],
            &[],
            Some(&spec),
        )?;
    }
    let tree = git_run(&idx, root, &["write-tree"], &[], None)?;
    let parent = git_run(&idx, root, &["rev-parse", "--verify", "HEAD"], &[], None).ok();
    let mut args: Vec<&str> = vec!["commit-tree", tree.as_str(), "-m", label];
    if let Some(ref p) = parent {
        if !p.is_empty() {
            args.push("-p");
            args.push(p.as_str());
        }
    }
    let sha = git_run(&idx, root, &args, CP_GIT_AUTHOR, None)?;
    let _ = git_run(&idx, root, &["update-ref", "HEAD", sha.as_str()], &[], None);
    Ok(sha)
}

fn checkpoint_save_impl(
    app: tauri::AppHandle,
    path: String,
    label: String,
    use_git: bool,
) -> Result<CheckpointMeta, String> {
    // Путь с фронтенда — общий гардал системных локаций (модель settings.rs)
    crate::settings::rejects_sensitive_path(&path)?;
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    let dir = checkpoints_dir(&app, &path)?;
    let mut files = Vec::new();
    let mut total: u64 = 0;
    collect_files(&root, &root, &mut files, &mut total);
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let id = format!("{ts}-{nanos:08x}");
    let label: String = label.chars().take(120).collect();
    let count = files.len();
    let store = CheckpointStore {
        root: path.clone(),
        label: label.clone(),
        ts,
        files,
    };
    let json = serde_json::to_vec(&store).map_err(|e| e.to_string())?;
    // atomic_write, а не fs::write: на Unix снимок проекта (там бывают и
    // .env) не должен быть читаем всеми, а краш не должен рвать файл
    crate::fsutil::atomic_write(&dir.join(format!("{id}.json")), &json)
        .map_err(|e| e.to_string())?;
    // Git-журнал (opt-in): тихий фолбэк в снапшот-режим — снимок уже записан,
    // журнал является добавкой, провал не критичен
    let mut git_sha: Option<String> = None;
    if use_git && git_available() {
        let rels: Vec<String> = store.files.iter().map(|f| f.rel.clone()).collect();
        git_sha = git_checkpoint_journal(&root, &dir, &label, &rels).ok();
    }
    // Сайдкар — Best-effort: провал не критичен, список упадёт на фолбэк
    // полного парсинга снимка
    let meta = CheckpointMetaCar {
        ts,
        label: label.clone(),
        files: count,
        git: git_sha.clone(),
    };
    let _ = crate::fsutil::atomic_write(
        &dir.join(format!("{id}.meta.json")),
        &serde_json::to_vec(&meta).unwrap_or_default(),
    );
    // Чистим старые сверх CP_KEEP (по метке времени в начале имени);
    // .meta.json — не самостоятельный чекпоинт, а сайдкар своего снимка
    let mut olds: Vec<(u64, PathBuf)> = Vec::new();
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.ends_with(".json") || name.ends_with(".meta.json") {
                continue;
            }
            let ts = name
                .strip_suffix(".json")
                .and_then(|s| s.split('-').next())
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0);
            olds.push((ts, e.path()));
        }
    }
    olds.sort();
    while olds.len() > CP_KEEP {
        let (_, p) = olds.remove(0);
        let _ = fs::remove_file(&p);
        // Сайдкар умирает вместе со снимком
        let stem = p.file_name().unwrap_or_default().to_string_lossy();
        let meta_name = format!("{}.meta.json", stem.trim_end_matches(".json"));
        let _ = fs::remove_file(p.with_file_name(meta_name));
    }
    Ok(CheckpointMeta {
        id,
        ts,
        label,
        files: count,
        bytes: total,
        git: git_sha,
    })
}

#[tauri::command(async)]
pub async fn checkpoint_list(
    app: tauri::AppHandle,
    path: String,
) -> Result<Vec<CheckpointMeta>, String> {
    tauri::async_runtime::spawn_blocking(move || checkpoint_list_impl(app, path))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

fn checkpoint_list_impl(app: tauri::AppHandle, path: String) -> Result<Vec<CheckpointMeta>, String> {
    // Путь с фронтенда — общий гардал системных локаций (модель settings.rs)
    crate::settings::rejects_sensitive_path(&path)?;
    let dir = checkpoints_dir(&app, &path)?;
    let mut out: Vec<CheckpointMeta> = Vec::new();
    let rd = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        // .meta.json — сайдкар, не самостоятельный чекпоинт
        if !name.ends_with(".json") || name.ends_with(".meta.json") {
            continue;
        }
        let id = name.trim_end_matches(".json").to_string();
        // Сайдкар крошечный; полный парс снимка (base64 всех файлов) —
        // только фолбэк для чекпоинтов, сохранённых до его появления
        let meta_path = e.path().with_file_name(format!("{id}.meta.json"));
        let (ts, label, files, bytes, git) = match fs::read(&meta_path)
            .ok()
            .and_then(|b| serde_json::from_slice::<CheckpointMetaCar>(&b).ok())
        {
            // Сайдкар не хранит размер — берём фактический размер снимка
            // с диска (раньше в списке отдавался бессмысленный 0)
            Some(m) => (
                m.ts,
                m.label,
                m.files,
                fs::metadata(e.path()).map(|d| d.len()).unwrap_or(0),
                m.git,
            ),
            None => {
                let Ok(bytes) = fs::read(e.path()) else { continue };
                let size = bytes.len() as u64;
                let Ok(store) = serde_json::from_slice::<CheckpointStore>(&bytes) else {
                    continue;
                };
                (store.ts, store.label, store.files.len(), size, None)
            }
        };
        out.push(CheckpointMeta {
            id,
            ts,
            label,
            files,
            bytes,
            git,
        });
    }
    out.sort_by_key(|c| std::cmp::Reverse(c.ts));
    Ok(out)
}

#[tauri::command(async)]
pub async fn checkpoint_restore(
    app: tauri::AppHandle,
    path: String,
    id: String,
) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || checkpoint_restore_impl(app, path, id))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

/// Ни один существующий компонент пути записи не может быть symlink/junction:
/// fs::write следует по ссылке и уводит файл за пределы корня (junction
/// создаётся без прав администратора и приходит из zip/клонов репозитория;
/// подмена между save и restore — тот же вектор). Чтение чекпоинта
/// (collect_files_at) symlinks пропускает — здесь та же строгость на записи.
fn ensure_no_symlink_ancestors(path: &Path) -> Result<(), String> {
    let mut cur = path;
    while let Some(parent) = cur.parent() {
        if parent == cur {
            break;
        }
        if let Ok(md) = fs::symlink_metadata(parent) {
            if md.file_type().is_symlink() {
                return Err(format!(
                    "refusing to write through symlink: {}",
                    parent.display()
                ));
            }
        }
        cur = parent;
    }
    Ok(())
}

fn checkpoint_restore_impl(
    app: tauri::AppHandle,
    path: String,
    id: String,
) -> Result<usize, String> {
    // Путь с фронтенда — общий гардал системных локаций (модель settings.rs):
    // restore пишет файлы в корень проекта, блок-листа системных путей
    // здесь не было
    crate::settings::rejects_sensitive_path(&path)?;
    if !cp_id_ok(&id) {
        return Err("bad checkpoint id".into());
    }
    let dir = checkpoints_dir(&app, &path)?;
    let file = dir.join(format!("{id}.json"));
    let bytes = fs::read(&file).map_err(|e| e.to_string())?;
    let store: CheckpointStore = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    let mut restored = 0usize;
    for f in &store.files {
        // Легаси-снимок мог содержать секреты до секрет-гарда collect:
        // restore их не переписывает в дерево (аудит A1-4)
        if rel_sensitive(&f.rel) {
            continue;
        }
        // Формат rel — нативные разделители ФС; старые Windows-чекпоинты с
        // «\» восстанавливаются как есть. Разбор по ОБОИМ разделителям:
        // иначе на Unix из «src\main.rs» вырастал плоский файл-мусор
        let parts: Vec<&str> = f
            .rel
            .split(['\\', '/'])
            .filter(|p| !p.is_empty())
            .collect();
        // Абсолютные формы, подъём и «.» — мимо; диск/UNC в «относительном»
        // пути на Windows полностью заменяет базу у join — тоже отказ
        if parts.is_empty()
            || parts.iter().any(|p| *p == ".." || *p == ".")
            || f.rel.starts_with('\\')
            || f.rel.starts_with('/')
            || (cfg!(windows) && f.rel.contains(':'))
        {
            continue;
        }
        // Сборка из отдельных компонентов: компоненты после split сепараторов
        // не содержат, так что join не может «перескочить» на абсолютный путь
        let dest = parts.iter().fold(root.clone(), |acc, p| acc.join(p));
        // Существующий dest-симлинк или symlink/junction среди предков —
        // отказ для этого файла (fail closed), запись через ссылку не идёт
        if fs::symlink_metadata(&dest)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
            || ensure_no_symlink_ancestors(&dest).is_err()
        {
            continue;
        }
        if let Some(parent) = dest.parent() {
            if fs::create_dir_all(parent).is_err() {
                continue;
            }
        }
        let Ok(data) = B64.decode(&f.data) else { continue };
        if fs::write(&dest, data).is_ok() {
            restored += 1;
        }
    }
    Ok(restored)
}

/// Состояние одного файла снимка: «до» из чекпоинта + текущее с диска.
/// Источник живого диффа для Review: правки мимо fs_write (shell и т.п.)
/// в результатах инструментов не видны, чекпоинт покрывает их все.
#[derive(Debug, Serialize)]
pub struct CheckpointFileState {
    pub rel: String,
    /// base64 содержимого из снимка
    pub before: String,
    /// base64 текущего файла; None — удалён после снимка либо крупнее капа
    pub current: Option<String>,
}

const CP_CURRENT_CAP: u64 = 2 * 1024 * 1024;

#[tauri::command(async)]
pub async fn checkpoint_files(
    app: tauri::AppHandle,
    path: String,
    id: String,
) -> Result<Vec<CheckpointFileState>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Путь с фронтенда — общий гардал системных локаций (модель settings.rs)
        crate::settings::rejects_sensitive_path(&path)?;
        if !cp_id_ok(&id) {
            return Err("bad checkpoint id".into());
        }
        let dir = checkpoints_dir(&app, &path)?;
        let file = dir.join(format!("{id}.json"));
        let bytes = fs::read(&file).map_err(|e| e.to_string())?;
        let store: CheckpointStore =
            serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        let root = PathBuf::from(&path);
        if !root.is_dir() {
            return Err(format!("not a directory: {path}"));
        }
        let mut out = Vec::new();
        for f in &store.files {
            // Легаси-снимок мог содержать секреты до секрет-гарда collect:
            // expose их не отдаёт (аудит A1-4)
            if rel_sensitive(&f.rel) {
                continue;
            }
            // Тот же гард пути, что у restore: только относительные без подъёма
            let parts: Vec<&str> = f
                .rel
                .split(['\\', '/'])
                .filter(|p| !p.is_empty())
                .collect();
            if parts.is_empty()
                || parts.iter().any(|p| *p == ".." || *p == ".")
                || f.rel.starts_with('\\')
                || f.rel.starts_with('/')
                || (cfg!(windows) && f.rel.contains(':'))
            {
                continue;
            }
            let dest = parts.iter().fold(root.clone(), |acc, p| acc.join(p));
            let current = fs::read(&dest)
                .ok()
                .filter(|b| (b.len() as u64) <= CP_CURRENT_CAP)
                .map(|b| B64.encode(b));
            out.push(CheckpointFileState {
                rel: f.rel.clone(),
                before: f.data.clone(),
                current,
            });
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

#[tauri::command(async)]
pub async fn checkpoint_delete(app: tauri::AppHandle, path: String, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Путь с фронтенда — общий гардал системных локаций (модель settings.rs)
        crate::settings::rejects_sensitive_path(&path)?;
        if !cp_id_ok(&id) {
            return Err("bad checkpoint id".into());
        }
        let dir = checkpoints_dir(&app, &path)?;
        fs::remove_file(dir.join(format!("{id}.json"))).map_err(|e| e.to_string())?;
        // Сайдкар — Best-effort: осиротевшая мета отфильтровалась бы и так
        let _ = fs::remove_file(dir.join(format!("{id}.meta.json")));
        Ok(())
    })
    .await
    .map_err(|e| format!("checkpoint delete task failed: {e}"))?
}


/// Содержимое папки для дерева файлов: папки первыми, дальше по алфавиту.
/// Важно: read_dir отдаёт записи в произвольном порядке ФС, поэтому
/// сначала собираем и сортируем ВСЁ, и только потом обрезаем до лимита —
/// иначе отсечение было бы произвольным подмножеством (часть папок терялась).
#[tauri::command(async)]
pub async fn list_dir(path: String) -> Result<Vec<FileEntry>, String> {
    // Путь с фронтенда — общий гардал системных локаций (модель settings.rs)
    crate::settings::rejects_sensitive_path(&path)?;
    // read_dir больших каталогов (node_modules, сетевые диски) — в
    // blocking-пул, а не на воркер tokio со стримами (класс crypto_status)
    tauri::async_runtime::spawn_blocking(move || list_dir_impl(path))
        .await
        .map_err(|e| format!("list dir task failed: {e}"))?
}

fn list_dir_impl(path: String) -> Result<Vec<FileEntry>, String> {
    let dir = std::path::Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    let mut dirs: Vec<FileEntry> = Vec::new();
    let mut files: Vec<FileEntry> = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| format!("cannot list {path}: {e}"))?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // file_type() из readdir — без отдельного stat: entry.path().is_dir()
        // ходил в ФС за каждой записью (большие каталоги — двойной syscall)
        let is_dir = entry
            .file_type()
            .map(|t| t.is_dir())
            .unwrap_or_else(|_| entry.path().is_dir());
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        (if is_dir { &mut dirs } else { &mut files })
            .push(FileEntry { name, is_dir, size, truncated: false });
        if dirs.len() + files.len() >= LIST_DIR_HARD_CAP {
            break;
        }
    }
    let by_name = |a: &FileEntry, b: &FileEntry| a.name.to_lowercase().cmp(&b.name.to_lowercase());
    dirs.sort_by(by_name);
    files.sort_by(by_name);
    dirs.extend(files);
    let truncated = dirs.len() > LIST_DIR_LIMIT;
    dirs.truncate(LIST_DIR_LIMIT);
    if truncated {
        if let Some(last) = dirs.last_mut() {
            last.truncated = true;
        }
    }
    Ok(dirs)
}

#[cfg(test)]
mod list_dir_tests {
    use super::*;

    fn tmp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("haloui-ls-{}", name));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn dirs_first_and_sorted() {
        let dir = tmp_dir("order");
        // Создаём в «неудобном» порядке — read_dir может отдать как угодно
        for n in ["zebra.txt", "apple.txt", "mango.txt"] {
            fs::write(dir.join(n), "x").unwrap();
        }
        for n in ["zz_dir", "aa_dir", "mm_dir"] {
            fs::create_dir(dir.join(n)).unwrap();
        }
        let res = list_dir_impl(dir.to_string_lossy().to_string()).unwrap();
        let names: Vec<&str> = res.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["aa_dir", "mm_dir", "zz_dir", "apple.txt", "mango.txt", "zebra.txt"]
        );
        assert!(res.iter().take(3).all(|e| e.is_dir));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn truncation_keeps_all_dirs_and_is_deterministic() {
        let dir = tmp_dir("trunc");
        for n in ["aa_dir", "zz_dir", "mm_dir"] {
            fs::create_dir(dir.join(n)).unwrap();
        }
        // 700 файлов — больше лимита 500
        for i in 0..700 {
            fs::write(dir.join(format!("file{:04}.txt", i)), "x").unwrap();
        }
        let first = list_dir_impl(dir.to_string_lossy().to_string()).unwrap();
        let second = list_dir_impl(dir.to_string_lossy().to_string()).unwrap();
        assert_eq!(first.len(), LIST_DIR_LIMIT);
        // Результат детерминирован независимо от порядка read_dir
        assert_eq!(
            first.iter().map(|e| &e.name).collect::<Vec<_>>(),
            second.iter().map(|e| &e.name).collect::<Vec<_>>()
        );
        // Все папки выжили и стоят впереди
        assert_eq!(&first[0].name, "aa_dir");
        assert_eq!(&first[1].name, "mm_dir");
        assert_eq!(&first[2].name, "zz_dir");
        assert!(first.iter().skip(3).all(|e| !e.is_dir));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn non_directory_rejected() {
        let dir = tmp_dir("rej");
        let file = dir.join("f.txt");
        fs::write(&file, "x").unwrap();
        let res = list_dir_impl(file.to_string_lossy().to_string());
        assert!(res.is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
#[cfg(test)]
mod checkpoint_secret_tests {
    use super::*;

    /// Аудит A1-4: вложенные секреты не попадают в снимок; .gitignore и
    /// прочие несекретные dot-файлы — остаются (класс один с perm)
    #[test]
    fn collect_skips_nested_sensitive_files() {
        let dir = std::env::temp_dir().join(format!("haloui-cp-secret-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("backend")).unwrap();
        fs::create_dir_all(dir.join(".ssh")).unwrap();
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("backend").join(".env"), "SECRET=1").unwrap();
        fs::write(dir.join(".ssh").join("id_rsa"), "key").unwrap();
        fs::write(dir.join("server.pem"), "cert").unwrap();
        fs::write(dir.join("src").join("main.rs"), "fn main() {}").unwrap();
        fs::write(dir.join(".gitignore"), "target").unwrap();
        let mut files = Vec::new();
        let mut total = 0u64;
        collect_files(&dir, &dir, &mut files, &mut total);
        let rels: Vec<&str> = files.iter().map(|f| f.rel.as_str()).collect();
        assert!(
            rels.iter().any(|r| r.ends_with("main.rs")),
            "legit file must be captured: {rels:?}"
        );
        assert!(!rels.iter().any(|r| r.contains(".env")), "rels: {rels:?}");
        assert!(!rels.iter().any(|r| r.contains("id_rsa")), "rels: {rels:?}");
        assert!(!rels.iter().any(|r| r.ends_with(".pem")), "rels: {rels:?}");
        assert!(
            rels.iter().any(|r| r.ends_with(".gitignore")),
            "non-secret dotfile stays: {rels:?}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rel_sensitive_matches_perm_class() {
        // Смешанные разделители и оба направления нормализации
        assert!(rel_sensitive("backend\\.env"));
        assert!(rel_sensitive("backend/.env.local"));
        assert!(rel_sensitive("sub/.ssh/id_rsa"));
        assert!(rel_sensitive("cert.pem"));
        assert!(rel_sensitive("keys/key.ppk"));
        assert!(!rel_sensitive("src/main.rs"));
        assert!(!rel_sensitive(".gitignore"));
    }
}

#[cfg(test)]
mod git_status_tests {
    use super::*;

    #[test]
    fn git_status_parses_added_file() {
        let dir = std::env::temp_dir().join("haloui-git-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        // git может отсутствовать в окружении — тогда тест не имеет смысла
        let init = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&dir)
            .output();
        let Ok(out) = init else { return };
        if !out.status.success() {
            return;
        }
        fs::write(dir.join("hello.txt"), "x").unwrap();
        let _ = std::process::Command::new("git")
            .args(["add", "."])
            .current_dir(&dir)
            .output();

        let res = git_status_impl(dir.to_string_lossy().to_string()).unwrap();
        assert_eq!(res.len(), 1);
        assert_eq!(res[0].path, "hello.txt");
        assert_eq!(res[0].code, "A");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_status_rejects_non_repo() {
        let dir = std::env::temp_dir().join("haloui-git-norepo");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        // если git есть — не-repo должен дать ошибку; если git нет — тоже Err
        assert!(git_status_impl(dir.to_string_lossy().to_string()).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn porcelain_z_rename_takes_new_path_and_consumes_orig() {
        // №15: в -z стороны переименования не склеиваются « -> », разбор не
        // ломается даже на пути, СОДЕРЖАЩЕМ стрелку (возможен на Unix);
        // формат: XY SP new\0old\0 — новый путь первым, old потребляется
        let text = "R  a -> b.txt\0old name.txt\0M  plain.txt\0";
        let entries = parse_porcelain_z(text);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].path, "a -> b.txt");
        assert_eq!(entries[0].code, "R");
        assert_eq!(entries[1].path, "plain.txt");
        assert_eq!(entries[1].code, "M");
    }

    #[test]
    fn porcelain_z_paths_are_raw() {
        // №14: не-ASCII приходит байтами UTF-8 без кавычек и octal-эскейпов;
        // кавычки в имени файла — часть пути, а не git-цитирование
        let text = "?? \u{444}\u{430}\u{439}\u{43b}.txt\0A  \"quoted\".txt\0";
        let entries = parse_porcelain_z(text);
        assert_eq!(entries[0].path, "\u{444}\u{430}\u{439}\u{43b}.txt");
        assert_eq!(entries[0].code, "??");
        assert_eq!(entries[1].path, "\"quoted\".txt");
    }

    #[test]
    fn porcelain_z_trailing_nul_skipped() {
        let entries = parse_porcelain_z("M  x.txt\0\0");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "x.txt");
        assert!(parse_porcelain_z("").is_empty());
    }

    #[test]
    fn git_checkpoint_journal_commits_and_chains() {
        if !git_available() {
            // CI/окружение без git — режим опциональный, тест бессмыслен
            return;
        }
        let tmp = std::env::temp_dir().join(format!("nocturn-cp-git-{}", std::process::id()));
        let root = tmp.join("proj");
        let cp = tmp.join("cps");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("a.txt"), "v1").unwrap();
        let rels = vec!["a.txt".to_string()];
        let sha1 = git_checkpoint_journal(&root, &cp, "первый", &rels).unwrap();
        fs::write(root.join("a.txt"), "v2").unwrap();
        let sha2 = git_checkpoint_journal(&root, &cp, "второй", &rels).unwrap();
        assert_ne!(sha1, sha2);
        // Цепочка: HEAD ведёт к двум коммитам журнала
        let count = git_run(&cp.join("git-index"), &root, &["rev-list", "--count", "HEAD"], &[], None).unwrap();
        assert_eq!(count, "2");
        // Пути с пробелами и юникодом проходят через NUL-spec
        fs::create_dir_all(root.join("sub dir")).unwrap();
        fs::write(root.join("sub dir").join("файл с пробелом.txt"), "юникод").unwrap();
        let rels2 = vec!["a.txt".to_string(), "sub dir/файл с пробелом.txt".to_string()];
        let sha3 = git_checkpoint_journal(&root, &cp, "третий", &rels2).unwrap();
        assert_ne!(sha2, sha3);
        let count = git_run(&cp.join("git-index"), &root, &["rev-list", "--count", "HEAD"], &[], None).unwrap();
        assert_eq!(count, "3");
        let _ = fs::remove_dir_all(&tmp);
    }
}


#[cfg(test)]
mod git_branch_diff_tests {
    use super::*;

    fn git(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@test")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@test")
            .output()
            .expect("git must be available");
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }

    #[test]
    fn git_branch_diff_rejects_bad_base() {
        let dir = std::env::temp_dir().join(format!("haloui-gitdiff-bad-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let err =
            git_branch_diff_impl(dir.to_string_lossy().into_owned(), "bad;rm".into()).unwrap_err();
        assert!(err.contains("invalid base branch"), "{err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_branch_diff_works_on_temp_repo() {
        let dir = std::env::temp_dir().join(format!("haloui-gitdiff-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        // git может отсутствовать в окружении — тест тогда не имеет смысла
        let probe = std::process::Command::new("git").arg("--version").output();
        if probe.map(|o| !o.status.success()).unwrap_or(true) {
            eprintln!("skipped: git unavailable");
            return;
        }
        git(&dir, &["init", "-q"]);
        git(&dir, &["checkout", "-q", "-b", "main"]);
        fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-q", "-m", "one"]);
        git(&dir, &["checkout", "-q", "-b", "dev"]);
        fs::write(dir.join("a.txt"), "two\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-q", "-m", "two"]);

        let d = git_branch_diff_impl(dir.to_string_lossy().into_owned(), "main".into()).unwrap();
        assert_eq!(d.branch, "dev");
        assert_eq!(d.base, "main");
        assert!(d.diff.contains("+two"), "diff: {}", d.diff);
        assert!(d.stat.contains("a.txt"), "stat: {}", d.stat);
        assert!(!d.truncated);
        // Нет такой базы — честная ошибка git-а наверх
        assert!(
            git_branch_diff_impl(dir.to_string_lossy().into_owned(), "nope".into()).is_err()
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
