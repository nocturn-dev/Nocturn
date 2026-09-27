//! Серверный слой прав: PermMode + project roots.
//!
//! Бэкенд отклоняет то, что фронт не может разрешить своей моделью,
//! и применяет path-контроль для fs_* инструментов. Источник истины —
//! фронт (App.tsx): перед первым инструментом прогона он синхронизирует
//! режим и корень проекта командой perm_set (api.ts).
//!
//! Контролируются все мутирующие инструменты (shell_run, fs_write, fs_delete,
//! vault_write, image_generate, mcp__*, действия browser_*/computer_*) —
//! гарантия Plan-режима read-only держится на бэкенде, а не только на фронте.
//! fs_* дополнительно проходит path-контроль корней проекта.

use std::sync::Mutex;

/// Режим разрешений агента — зеркало PermissionMode на фронте (src/types.ts).
/// serde-деривы не нужны: PermState нигде не сериализуется, режим разбирается
/// из строки вручную в perm_set (tooling.rs)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermMode {
    Plan,
    Ask,
    Edit,
    Full,
}

/// Снимок состояния прав: режим + корни проекта (абсолютные пути)
#[derive(Debug, Clone)]
pub struct PermState {
    pub mode: PermMode,
    pub roots: Vec<String>,
    /// Корни, канонизованные ОДИН раз при perm_set (см. canonicalize_roots):
    /// раньше path_allowed канонизовал каждый корень на каждый fs_* вызов.
    /// Параллелен roots. Заполняет вызывающий (perm_set, тесты)
    pub roots_canon: Vec<String>,
    /// true после первого perm_set: фронт синхронизировал режим задачи
    pub synced: bool,
}

/// Глобальное состояние (одно на процесс). None = ещё не синхронизировано
static PERM: Mutex<Option<PermState>> = Mutex::new(None);

/// Текущее состояние; до первого perm_set — Ask без корней и без синхронизации
pub(crate) fn current() -> PermState {
    PERM.lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or(PermState {
            mode: PermMode::Ask,
            roots: Vec::new(),
            roots_canon: Vec::new(),
            synced: false,
        })
}

/// Обновить состояние (вызывается командой perm_set из фронта)
pub(crate) fn set(state: PermState) {
    if let Ok(mut g) = PERM.lock() {
        *g = Some(state);
    }
}

/// Решение по инструменту. Возвращаемое Err — текст для модели.
/// Классификация mutating зеркалит фронт (useAgentRun): shell_run, fs_write,
/// fs_delete, vault_write, image_generate, mcp__*, browser_*/computer_*
/// (кроме скриншота и чтения страницы). Гарантия тира: Plan-режим строго
/// read-only на бэкенде — раньше computer_* (мышь/клавиатура) и vault_write
/// исполнялись в Plan мимо контроля. В Ask/Edit подтверждение делает фронт —
/// бэкенд не ломает уже подтверждённые вызовы, но fs_* всегда проходит
/// path-контроль. roots пуст → path-контроль не применяется. shell_run —
/// без path-контроля: cwd опционален, корневой cwd вебвью неизвестен.
pub(crate) fn decide(state: &PermState, name: &str, path: Option<&str>) -> Result<(), String> {
    let mutating = match name {
        "shell_run" | "fs_write" | "fs_delete" | "vault_write" | "image_generate"
        | "memory_save" => true,
        n if n.starts_with("mcp__") => true,
        // Чтение и скриншот безопасны — mutating только действия
        n if n.starts_with("browser_") => !matches!(n, "browser_read" | "browser_screenshot"),
        n if n.starts_with("computer_") => n != "computer_screenshot",
        _ => false,
    };
    let fs_tool = matches!(name, "fs_read" | "fs_list" | "fs_write" | "fs_delete" | "fs_grep");
    if !mutating && !fs_tool {
        return Ok(());
    }
    // Гонка IPC: perm_set летит fire-and-forget, run_tool может обогнать его.
    // Пока фронт ни разу не синхронизировал режим, мутации под запретом —
    // иначе окно «дефолтного Ask» пропускает shell_run даже в Plan-задаче
    if !state.synced && mutating {
        return Err("permission mode not synchronized yet; retry shortly".to_string());
    }
    match state.mode {
        // План: любые мутации блокируются (включая мышь/клавиатуру и MCP),
        // fs-чтение — с path-контролем, остальное чтение (browser_read,
        // computer_screenshot) — свободно
        PermMode::Plan => {
            if mutating {
                return Err(format!("blocked by permission mode: plan (tool {name})"));
            }
            if fs_tool {
                check_fs_path(state, path)?;
            }
            Ok(())
        }
        // Edit: правки файлов без подтверждения, удаление и шелл — только full/ask
        PermMode::Edit => {
            if name == "fs_delete" || name == "shell_run" {
                return Err(
                    "tool blocked: fs_delete/shell_run require full or ask mode (edit mode allows fs_write only)"
                        .to_string(),
                );
            }
            if fs_tool {
                check_fs_path(state, path)?;
            }
            Ok(())
        }
        // Ask: подтверждение делает фронт; fs_* — всегда с path-контролем
        // (fs_delete раньше проходил без него: контроль корней целиком
        // доверялся фронту)
        PermMode::Ask => {
            if fs_tool {
                check_fs_path(state, path)?;
            }
            Ok(())
        }
        // Full: всё исполняется, fs_* — с path-контролем
        PermMode::Full => {
            if fs_tool {
                check_fs_path(state, path)?;
            }
            Ok(())
        }
    }
}

/// Path-контроль для fs_* инструментов (сюда доходим без ранних Err/Ok).
/// roots пуст → Ok: проект не выбран, текущее поведение не сужаем.
/// Путь отсутствует (или пришёл не строкой — тогда None) → Err для модели.
fn check_fs_path(state: &PermState, path: Option<&str>) -> Result<(), String> {
    if state.roots.is_empty() {
        return Ok(());
    }
    match path {
        Some(p) if path_allowed(&state.roots_canon, p) => Ok(()),
        Some(p) => Err(format!("path outside project roots: {p}")),
        None => Err("fs tool requires a path argument".to_string()),
    }
}

/// Лежит ли path внутри одного из roots_canon. Строковая нормализация
/// дополнена резолвом через fs::canonicalize: он раскрывает `..`,
/// symlink/junction и 8.3-короткие имена, которые чисто строковое сравнение
/// пропускает как «внутри корня». Явные `..`/`.` в компонентах запрещены
/// сразу; пути, которые не удалось резолвить (несуществующее поддерево),
/// сравниваются строково — как и раньше. Относительные пути запрещены.
///
/// roots_canon — УЖЕ канонизованные корни (canonicalize_roots, один раз на
/// perm_set): их резолв в горячем пути не повторяется
fn path_allowed(roots_canon: &[String], path: &str) -> bool {
    let norm = norm_for_compare;
    let p = norm(path);
    // Относительный путь (нет диска/UNC-префикса) — сразу запрещаем
    #[cfg(windows)]
    if !p.contains(':') && !p.starts_with('\\') {
        return false;
    }
    #[cfg(not(windows))]
    if !p.starts_with('/') {
        return false;
    }
    // Подъём по дереву и «текущая папка» — запрещаем до всякого резолва:
    // ОС резолвит их уже после нашей проверки префикса
    #[cfg(windows)]
    let sep = '\\';
    #[cfg(not(windows))]
    let sep = '/';
    if p.split(sep).any(|c| c == ".." || c == ".") {
        return false;
    }
    let resolved = match canonicalize_for_compare(std::path::Path::new(path)) {
        Some(r) => norm(&r.to_string_lossy()),
        None => p.clone(),
    };
    roots_canon
        .iter()
        .any(|nr| resolved == *nr || resolved.starts_with(&format!("{nr}{sep}")))
}

/// Нормализация пути/корня для сравнения. Регистронезависимость — по
/// поведению ФС: на Windows NTFS регистр не учитывается; на macOS дефолтная
/// APFS ТОЖЕ регистронезависима (раньше lowercase был только на Windows, и
/// корень ~/Projects/App отвергал легитимный путь ~/projects/app); на Linux
/// (ext4/btrfs) ФС регистрозависима — lowercase там УБИВАЛ корректность
/// (директория-тёзка в другом регистре проходила как «внутри корня»)
fn norm_for_compare(s: &str) -> String {
    #[cfg(any(windows, target_os = "macos"))]
    {
        let mut s = s.to_lowercase();
        #[cfg(windows)]
        {
            // разделитель `\`; canonicalize на Windows возвращает
            // \\?\C:\... (или \\?\UNC\srv\share) — срезаем префикс
            s = s.replace('/', "\\");
            if let Some(rest) = s.strip_prefix("\\\\?\\unc\\") {
                s = format!("\\\\{rest}");
            } else if let Some(rest) = s.strip_prefix("\\\\?\\") {
                s = rest.to_string();
            }
        }
        s
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        s.replace('\\', "/")
    }
}

/// Канонизация корней ОДИН раз на perm_set (FS-работа — в blocking-пул
/// вызывающего): путь файла канонизуется при каждом вызове как прежде
/// (это security-свойство), корни — больше нет. Корень, который не
/// резолвится, падает в строковую нормализацию — прежнее поведение
pub(crate) fn canonicalize_roots(roots: &[String]) -> Vec<String> {
    roots
        .iter()
        .map(|r| {
            match canonicalize_for_compare(std::path::Path::new(r)) {
                Some(rr) => norm_for_compare(&rr.to_string_lossy()),
                None => norm_for_compare(r),
            }
        })
        .collect()
}

/// Канонизация для сравнения путей: резолвит существующий путь; для ещё не
/// существующего файла — существующего родителя + имя файла. None — резолвить
/// нечего (нет ни пути, ни родителя): вызывающий падает в строковое сравнение.
fn canonicalize_for_compare(path: &std::path::Path) -> Option<std::path::PathBuf> {
    if let Ok(c) = std::fs::canonicalize(path) {
        return Some(c);
    }
    let parent = path.parent()?;
    let real_parent = std::fs::canonicalize(parent).ok()?;
    Some(real_parent.join(path.file_name()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Корень проекта по умолчанию для тестов (windows-flavored)
    #[cfg(windows)]
    const ROOT: &str = "C:\\proj";

    fn state(mode: PermMode, roots: &[&str]) -> PermState {
        let roots: Vec<String> = roots.iter().map(|s| s.to_string()).collect();
        let roots_canon = canonicalize_roots(&roots);
        PermState { mode, roots, roots_canon, synced: true }
    }

    /// Windows-семантика путей: прямые тесты path_allowed с C:\-путями
    /// осмыслены только там; для ubuntu-CI ниже unix-эквиваленты
    #[cfg(windows)]
    fn allowed(path: &str) -> bool {
        path_allowed(&canonicalize_roots(&[ROOT.to_string()]), path)
    }

    // ---------- path_allowed ----------

    #[cfg(windows)]
    #[test]
    fn path_inside_root() {
        assert!(allowed("C:\\proj\\src\\a.rs"));
    }

    #[cfg(windows)]
    #[test]
    fn path_component_boundary_trap() {
        // Граница компонента: "c:\proj" не должен матчить "c:\project"
        assert!(!allowed("C:\\project\\a.rs"));
    }

    #[cfg(windows)]
    #[test]
    fn path_case_insensitive() {
        assert!(allowed("C:\\PROJ\\X.RS"));
    }

    #[cfg(windows)]
    #[test]
    fn relative_path_rejected() {
        assert!(!allowed("src\\a.rs"));
    }

    #[cfg(windows)]
    #[test]
    fn traversal_rejected() {
        // Подъём по дереву: префикс совпадает, но ОС уводит путь за корень
        assert!(!allowed("C:\\proj\\..\\..\\Windows\\system32\\x"));
    }

    #[cfg(windows)]
    #[test]
    fn dot_component_rejected() {
        assert!(!allowed("C:\\proj\\.\\..\\x"));
    }

    #[cfg(windows)]
    #[test]
    fn device_prefix_cannot_escape() {
        // \\?\-путь мимо корня не должен пройти проверку префикса
        assert!(!allowed("\\\\?\\C:\\Windows\\x"));
    }

    #[cfg(not(windows))]
    #[test]
    fn path_allowed_unix() {
        // ubuntu-CI: linux-ветка path_allowed на unix-путях
        let roots = canonicalize_roots(&["/home/u/proj".to_string()]);
        assert!(path_allowed(&roots, "/home/u/proj/src/a.rs"));
        // Граница компонента и подъём — на unix так же запрещены
        assert!(!path_allowed(&roots, "/home/u/project/a.rs"));
        assert!(!path_allowed(&roots, "src/a.rs"));
        assert!(!path_allowed(&roots, "/home/u/proj/../other/x"));
        // Регистр на linux значим: корень в другом регистре не матчится
        assert!(!path_allowed(&roots, "/HOME/u/proj/src/a.rs"));
    }

    #[test]
    fn not_synced_blocks_mutating() {
        let mut st = state(PermMode::Plan, &[]);
        st.synced = false;
        assert!(decide(&st, "shell_run", None).is_err());
        assert!(decide(&st, "fs_write", Some("C:\\proj\\a")).is_err());
        // Чтение до синхронизации не блокируем
        assert!(decide(&st, "fs_read", Some("C:\\proj\\a")).is_ok());
    }

    // ---------- decide ----------

    #[test]
    fn plan_blocks_mutating() {
        assert!(decide(&state(PermMode::Plan, &[]), "fs_write", None).is_err());
    }

    #[test]
    fn plan_allows_readonly_when_roots_empty() {
        // path при этом может быть None: roots пуст — контроль не применяется
        assert!(decide(&state(PermMode::Plan, &[]), "fs_read", None).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn edit_allows_fs_write_inside_root() {
        assert!(decide(
            &state(PermMode::Edit, &["C:\\proj"]),
            "fs_write",
            Some("C:\\proj\\a.txt")
        )
        .is_ok());
    }

    #[test]
    fn edit_blocks_shell_run() {
        assert!(decide(&state(PermMode::Edit, &[]), "shell_run", None).is_err());
    }

    #[test]
    fn ask_defers_shell_run_to_frontend_confirm() {
        assert!(decide(&state(PermMode::Ask, &[]), "shell_run", None).is_ok());
    }

    #[test]
    fn full_rejects_delete_outside_roots() {
        assert!(decide(
            &state(PermMode::Full, &["C:\\proj"]),
            "fs_delete",
            Some("C:\\other\\x")
        )
        .is_err());
    }

    #[test]
    fn full_allows_readonly_when_roots_empty() {
        assert!(decide(&state(PermMode::Full, &[]), "fs_read", Some("C:\\proj\\a")).is_ok());
    }

    #[test]
    fn ask_rejects_relative_read_path() {
        assert!(decide(&state(PermMode::Ask, &["C:\\proj"]), "fs_read", Some("../x")).is_err());
    }

    #[test]
    fn plan_is_read_only_for_all_mutating_tools() {
        // Регресс: computer_* (мышь/клавиатура), vault_write, mcp__* и
        // image_generate раньше проходили Plan мимо контроля
        for name in ["computer_click", "computer_type", "vault_write", "image_generate", "mcp__server__tool", "browser_navigate"] {
            assert!(
                decide(&state(PermMode::Plan, &[]), name, None).is_err(),
                "plan must block {name}"
            );
        }
        // Чтение и скриншот в Plan разрешены
        assert!(decide(&state(PermMode::Plan, &[]), "computer_screenshot", None).is_ok());
        assert!(decide(&state(PermMode::Plan, &[]), "browser_read", None).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn ask_confirms_mutating_but_keeps_fs_path_control() {
        // Регресс: fs_delete в Ask проходил без path-контроля
        assert!(decide(&state(PermMode::Ask, &["C:\\proj"]), "fs_delete", Some("C:\\other\\x")).is_err());
        assert!(decide(&state(PermMode::Ask, &["C:\\proj"]), "fs_delete", Some("C:\\proj\\x")).is_ok());
        // Немутации вне fs_ (shell_run в ask подтверждает фронт)
        assert!(decide(&state(PermMode::Ask, &["C:\\proj"]), "shell_run", None).is_ok());
        assert!(decide(&state(PermMode::Ask, &[]), "vault_write", None).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn plan_fs_read_uses_path_control() {
        assert!(decide(&state(PermMode::Plan, &["C:\\proj"]), "fs_read", Some("C:\\other\\x")).is_err());
        assert!(decide(&state(PermMode::Plan, &["C:\\proj"]), "fs_read", Some("C:\\proj\\x")).is_ok());
    }

    #[test]
    fn non_fs_read_only_tools_skip_path_control() {
        // browser_read/computer_screenshot не имеют args.path — path-контроль
        // к ним неприменим даже при непустых roots
        assert!(decide(&state(PermMode::Full, &["C:\\proj"]), "computer_screenshot", None).is_ok());
        assert!(decide(&state(PermMode::Full, &["C:\\proj"]), "browser_read", None).is_ok());
    }
}
