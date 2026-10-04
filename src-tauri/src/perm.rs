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
    /// Волна E1: персистентные правила (perm_set валидирует fail-closed)
    pub rules: PermRules,
    /// Волна E3: канонизованный app-config каталог — самозащита конфига
    pub config_dir: Option<String>,
}

/// Глобальное состояние (одно на процесс). None = ещё не синхронизировано
static PERM: Mutex<Option<PermState>> = Mutex::new(None);

/// Текущее состояние; до первого perm_set — Ask без корней и без синхронизации
pub(crate) fn current() -> PermState {
    PERM.lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
        .unwrap_or_else(|| PermState {
            mode: PermMode::Ask,
            roots: Vec::new(),
            roots_canon: Vec::new(),
            synced: false,
            rules: PermRules::default(),
            config_dir: None,
        })
}

/// Обновить состояние (вызывается командой perm_set из фронта).
/// into_inner: poison (паника под локом) не имеет права превращать perm_set
/// в no-op — иначе все мутации навсегда отбивались бы «not synchronized yet»
/// при внешне зелёном UI, и ни один лог об этом не сказал бы
pub(crate) fn set(state: PermState) {
    let mut g = PERM.lock().unwrap_or_else(|p| p.into_inner());
    *g = Some(state);
}

/// Персистентные правила прав (волна E1). deny — серверный блок во всех
/// режимах; allow/always_ask — политика ПОДТВЕРЖДЕНИЙ фронта: бекенд их
/// не исполняет (он не может отличить «юзер подтвердил» от «фронт забыл
/// спросить» — как и в Ask-режиме), и правила не пробивают жёсткие границы
/// режима (Plan read-only, Edit shell/delete — выше allow, fail-closed).
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct PermRules {
    #[serde(default)]
    pub allow: Vec<String>,
    #[serde(default)]
    pub deny: Vec<String>,
    #[serde(default)]
    pub always_ask: Vec<String>,
}

/// Разобранное правило: `tool` | `tool(prefix*)` (звёздочка — только
/// замыкающая: «git *» = команда начинается с «git»; внутри префикса
/// звёздочка отвергается валидатором)
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedRule {
    pub tool: String,
    pub prefix: Option<String>,
}

pub fn parse_rule(rule: &str) -> Option<ParsedRule> {
    let rule = rule.trim();
    if rule.is_empty() {
        return None;
    }
    let (tool, prefix) = if let Some(i) = rule.find('(') {
        if !rule.ends_with(')') {
            return None;
        }
        let tool = rule[..i].trim();
        let mut inner = &rule[i + 1..rule.len() - 1];
        if let Some(stripped) = inner.strip_suffix('*') {
            inner = stripped;
        }
        if inner.contains('*') {
            return None;
        }
        (tool, Some(inner.trim().to_string()))
    } else {
        (rule, None)
    };
    if tool.is_empty() {
        return None;
    }
    // mcp-имена: mcp__server__tool (двойное подчёркивание — разделитель,
    // контракт mcp::split_prefixed_name); существование сервера не проверяем —
    // он может быть ещё не подключён. Прочие — [a-z0-9_]
    let ok_name = if let Some(rest) = tool.strip_prefix("mcp__") {
        !rest.is_empty()
            && rest.contains("__")
            && rest.split("__").all(|s| !s.is_empty())
    } else {
        tool.chars()
            .all(|c| c.is_ascii_lowercase() || c == '_' || c.is_ascii_digit())
    };
    if !ok_name {
        return None;
    }
    Some(ParsedRule {
        tool: tool.to_string(),
        prefix,
    })
}

/// Валидация правила (fail-closed: perm_set отвергает битое — защита
/// «not synchronized» держит мутации, пока владелец не починит список).
/// known — реестр builtin-имён (tooling::known_tool_names).
/// for_allow — правило попадает в allow-список: там bare-форма на
/// shell_run/fs_* запрещена («allow shell_run» = Full через боковую дверь,
/// «allow fs_read» снял бы sensitive-deny везде).
pub fn validate_rule(
    rule: &str,
    for_allow: bool,
    known: &std::collections::HashSet<String>,
) -> Result<(), String> {
    let parsed = parse_rule(rule).ok_or_else(|| format!("invalid rule format: {rule:?}"))?;
    let is_mcp = parsed.tool.starts_with("mcp__");
    if !is_mcp && !known.contains(&parsed.tool) {
        return Err(format!("unknown tool in rule: {}", parsed.tool));
    }
    let fs_tool = matches!(
        parsed.tool.as_str(),
        "fs_read" | "fs_write" | "fs_delete" | "fs_list" | "fs_grep"
    );
    if for_allow && parsed.prefix.is_none() && (parsed.tool == "shell_run" || fs_tool) {
        return Err(format!(
            "allow rule for {} requires a prefix",
            parsed.tool
        ));
    }
    if let Some(prefix) = &parsed.prefix {
        if prefix.is_empty() {
            return Err(format!("empty prefix in rule: {rule:?}"));
        }
        if fs_tool && !(prefix.contains(':') || prefix.starts_with('/')) {
            return Err(format!(
                "fs prefix must be an absolute path: {prefix}"
            ));
        }
    }
    Ok(())
}

/// Канонизованная нормализованная форма для матчинга правил (заметка
/// владельца №1): 8.3-алиасы, регистр и разделители разворачивает
/// canonicalize, сырой вход в матчинг не попадает никогда
fn canon_norm(path: &str) -> String {
    match canonicalize_for_compare(std::path::Path::new(path)) {
        Some(c) => norm_for_compare(&c.to_string_lossy()),
        None => norm_for_compare(path),
    }
}

/// Обёртка для perm_set: канонизация config-каталога самозащиты (волна E3)
pub(crate) fn norm_canonical_path(path: &str) -> String {
    canon_norm(path)
}

/// Матч списка правил против (tool, arg). arg для fs_* — канонизованная
/// форма (компонентная граница: префикс «C:\proj» не матчит «C:\projects»),
/// для shell_run — сырая команда case-insensitive (Windows: «GIT» = «git»)
/// с границей слова через пробел («git *» не матчит «github-cli»).
/// Битые правила в стейте не матчатся — валидация на perm_set.
fn rule_matches(rules: &[String], tool: &str, arg: Option<&str>, arg_is_path: bool) -> bool {
    for r in rules {
        let Some(p) = parse_rule(r) else { continue };
        if p.tool != tool {
            continue;
        }
        let Some(prefix) = &p.prefix else {
            return true; // bare: весь инструмент
        };
        if prefix.is_empty() {
            continue;
        }
        let Some(a) = arg else { continue };
        let hit = if arg_is_path {
            let pn = norm_for_compare(prefix);
            let an = norm_for_compare(a);
            let sep = if cfg!(windows) { '\\' } else { '/' };
            an == pn
                || (an.starts_with(&pn) && an[pn.len()..].starts_with(sep))
        } else {
            let pl = prefix.to_lowercase();
            let al = a.to_lowercase();
            al == pl || al.starts_with(&format!("{pl} "))
        };
        if hit {
            return true;
        }
    }
    false
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
    // Волна E1: deny-правило — серверный блок во всех режимах, на любой
    // инструмент (включая чтения), до остальных гейтов. fs-аргумент матчится
    // ТОЛЬКО по канонизованной форме (заметка владельца №1)
    let rule_arg: Option<String> = if fs_tool {
        path.map(canon_norm)
    } else {
        path.map(|p| p.to_string())
    };
    if rule_matches(&state.rules.deny, name, rule_arg.as_deref(), fs_tool) {
        return Err(format!("blocked by deny rule ({name})"));
    }
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
                check_fs_path(state, name, path)?;
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
                check_fs_path(state, name, path)?;
            }
            Ok(())
        }
        // Ask: подтверждение делает фронт; fs_* — всегда с path-контролем
        // (fs_delete раньше проходил без него: контроль корней целиком
        // доверялся фронту)
        PermMode::Ask => {
            if fs_tool {
                check_fs_path(state, name, path)?;
            }
            Ok(())
        }
        // Full: всё исполняется, fs_* — с path-контролем
        PermMode::Full => {
            if fs_tool {
                check_fs_path(state, name, path)?;
            }
            Ok(())
        }
    }
}

/// Path-контроль для fs_* инструментов (сюда доходим без ранних Err/Ok).
/// Волна E3: БЕЗУСЛОВНЫЕ гейты (config-каталог, .env-бэкстоп, sensitive-класс)
/// стоят ДО корней и правил — config вообще без escape (заметка владельца
/// №2), sensitive/.env — escape только явным allow-правилом владельца; и
/// работают при пустых roots тоже (path-контроль корней при этом off)
fn check_fs_path(state: &PermState, name: &str, path: Option<&str>) -> Result<(), String> {
    let Some(p) = path else {
        if state.roots.is_empty() {
            return Ok(());
        }
        return Err("fs tool requires a path argument".to_string());
    };
    let canon = canon_norm(p);
    let sep = if cfg!(windows) { '\\' } else { '/' };

    // 1) Самозащита конфига: БЕЗУСЛОВНО и ДО любых правил — settings.json
    // несёт ключи, hooks.json/mcp.json executable-by-nature; запись, удаление
    // и ЧТЕНИЕ (ключи в настройках) закрыты, сиблинги каталога не задеваются
    if matches!(name, "fs_read" | "fs_write" | "fs_delete") {
        if let Some(cfg) = &state.config_dir {
            if canon == *cfg || canon.starts_with(&format!("{cfg}{sep}")) {
                return Err(
                    "access to the app config directory is denied unconditionally".to_string(),
                );
            }
        }
    }

    // 2) .env-бэкстоп (заметка владельца №3): raw-подстрока case-insensitive —
    // грубая сеть поверх канонического матчинга, ловит .env.local/.ENV/…
    // False positive (app.env.backup) уводится явным allow-правилом
    if matches!(name, "fs_read" | "fs_write" | "fs_delete" | "fs_grep")
        && p.to_lowercase().contains(".env")
        && !rule_matches(&state.rules.allow, name, Some(&canon), true)
    {
        return Err(
            "sensitive path (.env) denied by default; the owner can allow it explicitly in Settings"
                .to_string(),
        );
    }

    // 3) Sensitive-класс по канонической форме; escape — allow-правило
    if is_sensitive_path(&canon)
        && !rule_matches(&state.rules.allow, name, Some(&canon), true)
    {
        return Err(
            "sensitive path denied by default; the owner can allow it explicitly in Settings"
                .to_string(),
        );
    }

    if state.roots.is_empty() {
        return Ok(());
    }
    if !path_allowed(&state.roots_canon, p) {
        return Err(format!("path outside project roots: {p}"));
    }
    Ok(())
}

/// Повторная проверка ФИНАЛЬНОГО расположения после верифицированного
/// открытия файла (symlink TOCTOU, SECURITY.md): между decide() и записью
/// компонент пути могли подменить симлинком, и настоящий адрес записи видит
/// только открытый дескриптор. Все path-гейты (самозащита конфига,
/// .env-бэкстоп, sensitive-класс, корни) повторяются по адресу, который ОС
/// показала для дескриптора — подмена видна здесь как другой location
pub fn recheck_location(name: &str, verified: &std::path::Path) -> Result<(), String> {
    let state = current();
    check_fs_path(&state, name, Some(&verified.to_string_lossy()))
}

/// Чувствительный класс путей (по канонизованной нормализованной форме):
/// чтение = утечка секретов, запись = подмена — класс один для fs_*.
/// Вердикт владельца: DENY по умолчанию, escape — явное allow-правило
fn is_sensitive_path(canon: &str) -> bool {
    let sep = if cfg!(windows) { '\\' } else { '/' };
    let comps: Vec<&str> = canon.split(sep).filter(|c| !c.is_empty()).collect();
    let Some(name) = comps.last().copied() else {
        return false;
    };
    // каталоги секретов целиком
    if comps.iter().any(|c| *c == ".ssh" || *c == ".aws") {
        return true;
    }
    // .git/config на любой глубине (включая сабмодули)
    for w in comps.windows(2) {
        if w[0] == ".git" && w[1] == "config" {
            return true;
        }
    }
    name == ".env"
        || name.starts_with(".env.")
        || name == ".git-credentials"
        || name == ".netrc"
        || name == ".npmrc"
        || name.starts_with("id_rsa")
        || name.starts_with("id_ed25519")
        || name.ends_with(".pem")
        || name.ends_with(".ppk")
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
    // NTFS-альтернативные потоки (file.txt:ads, file.txt:$DATA) — вне модели
    // проекта: поверхность мимо расширений и будущих deny-листов. Легальное
    // двоеточие одно — диск в первом компоненте («c:»); drive-relative
    // («c:file») тоже отсекается — он резолвится в per-drive cwd, классический
    // обходной козырь. Заодно закрывает дыру relative-гейта выше: «file.txt:ads»
    // содержит ':' и проходил его как «абсолютный». На Unix ':' в имени файла
    // легален — проверка windows-only
    #[cfg(windows)]
    if p.split(sep).enumerate().any(|(i, c)| {
        c.contains(':') && !(i == 0 && c.len() == 2 && c.ends_with(':'))
    }) {
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
        PermState {
            mode,
            roots,
            roots_canon,
            synced: true,
            rules: PermRules::default(),
            config_dir: None,
        }
    }

    fn state_with_rules(mode: PermMode, roots: &[&str], rules: PermRules) -> PermState {
        let mut st = state(mode, roots);
        st.rules = rules;
        st
    }

    fn rules_with(deny: &[&str], allow: &[&str], always_ask: &[&str]) -> PermRules {
        PermRules {
            allow: allow.iter().map(|s| s.to_string()).collect(),
            deny: deny.iter().map(|s| s.to_string()).collect(),
            always_ask: always_ask.iter().map(|s| s.to_string()).collect(),
        }
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

    #[cfg(windows)]
    #[test]
    fn ntfs_stream_paths_rejected() {
        // Обычные пути с диском не задеваем
        assert!(allowed("C:\\proj\\file.txt"));
        // Альтернативные потоки — вне модели проекта
        assert!(!allowed("C:\\proj\\file.txt:ads"));
        assert!(!allowed("C:\\proj\\file.txt:$DATA"));
        assert!(!allowed("C:\\proj\\dir:stream\\x"));
        // Drive-relative («c:file») резолвится в per-drive cwd — fail closed
        assert!(!allowed("c:file.txt"));
        // Дыра relative-гейта: путь с двоеточием проходил его как «абсолютный»
        assert!(!allowed("file.txt:ads"));
    }

    #[cfg(not(windows))]
    #[test]
    fn path_allowed_unix_colon_in_name_stays_legal() {
        // На Unix ':' в имени файла легален — windows-only стрим-чек его
        // задевать не должен (регресс на cfg-гейтинг)
        let roots = canonicalize_roots(&["/home/u/proj".to_string()]);
        assert!(path_allowed(&roots, "/home/u/proj/file:name.txt"));
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

    // ---------- правила (волна E1) ----------

    #[test]
    fn deny_rule_blocks_all_modes_and_reads() {
        let st = state_with_rules(
            PermMode::Full,
            &["C:\\proj"],
            rules_with(&["shell_run(rm *)", "web_search"], &[], &[]),
        );
        // Мутирующий по префиксу
        assert!(decide(&st, "shell_run", Some("rm -rf C:\\tmp\\x")).is_err());
        // Case-insensitive (Windows: «GIT» = «git»)
        assert!(decide(&st, "shell_run", Some("RM -RF C:\\tmp")).is_err());
        // Bare deny — весь инструмент, включая чтения
        assert!(decide(&st, "web_search", None).is_err());
        // Не матчит — Full исполняет
        assert!(decide(&st, "shell_run", Some("git status")).is_ok());
    }

    #[test]
    fn deny_prefix_word_boundary_and_canonical_fs() {
        let st = state_with_rules(
            PermMode::Full,
            &["C:\\proj"],
            rules_with(&["shell_run(git *)", "fs_read(C:\\proj\\secrets)"], &[], &[]),
        );
        // «git *» не матчит «github-cli» (граница слова)
        assert!(decide(&st, "shell_run", Some("github-cli auth")).is_ok());
        assert!(decide(&st, "shell_run", Some("git push")).is_err());
        // fs-матчинг по компонентной границе: secrets не матчит secrets2
        assert!(decide(&st, "fs_read", Some("C:\\proj\\secrets2\\a.txt")).is_ok());
        assert!(decide(&st, "fs_read", Some("C:\\proj\\secrets\\k.txt")).is_err());
    }

    #[test]
    fn allow_rule_does_not_bypass_plan_or_edit_bounds() {
        let st = state_with_rules(
            PermMode::Plan,
            &["C:\\proj"],
            rules_with(&[], &["shell_run(git *)"], &[]),
        );
        // Plan read-only — allow не пробивает (fail-closed)
        assert!(decide(&st, "shell_run", Some("git status")).is_err());
        let edit = state_with_rules(
            PermMode::Edit,
            &["C:\\proj"],
            rules_with(&[], &["shell_run(git *)"], &[]),
        );
        // Edit-запрет shell_run — тоже выше allow
        assert!(decide(&edit, "shell_run", Some("git status")).is_err());
    }

    #[test]
    fn parse_and_validate_rules() {
        let known: std::collections::HashSet<String> = [
            "shell_run", "fs_read", "fs_write", "web_search", "plan_update",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        // Формы
        assert_eq!(
            parse_rule("shell_run(git *)"),
            Some(ParsedRule { tool: "shell_run".into(), prefix: Some("git".into()) })
        );
        assert_eq!(parse_rule("web_search"), Some(ParsedRule { tool: "web_search".into(), prefix: None }));
        assert_eq!(parse_rule("tool(a*b)"), None); // звёздочка не замыкающая
        assert_eq!(parse_rule("tool("), None);
        assert_eq!(parse_rule("mcp__bad"), None); // нет второго сегмента
        assert!(parse_rule("mcp__srv__tool").is_some());
        // Валидация
        assert!(validate_rule("shell_run(git *)", true, &known).is_ok());
        assert!(validate_rule("shell_run", true, &known).is_err()); // bare allow
        assert!(validate_rule("shell_run", false, &known).is_ok()); // bare deny
        assert!(validate_rule("fs_read", true, &known).is_err()); // bare allow fs_*
        assert!(validate_rule("future_tool", false, &known).is_err()); // неизвестное
        assert!(validate_rule("mcp__srv__tool", true, &known).is_ok()); // mcp по форме
        assert!(validate_rule("fs_read(proj/.env)", true, &known).is_err()); // относительный путь
        assert!(validate_rule("web_search(x*y)", false, &known).is_err());
    }

    // ---------- чувствительные пути и самозащита (волна E3) ----------

    #[test]
    fn sensitive_paths_denied_by_default_in_all_modes() {
        for mode in [PermMode::Plan, PermMode::Ask, PermMode::Edit, PermMode::Full] {
            let st = state(mode, &["C:\\proj"]);
            assert!(decide(&st, "fs_read", Some("C:\\proj\\.env")).is_err(), "{mode:?}");
            assert!(decide(&st, "fs_write", Some("C:\\proj\\.env.local")).is_err(), "{mode:?}");
            assert!(decide(&st, "fs_read", Some("C:\\proj\\.git\\config")).is_err(), "{mode:?}");
            assert!(decide(&st, "fs_read", Some("C:\\proj\\.ssh\\id_rsa")).is_err(), "{mode:?}");
            assert!(decide(&st, "fs_read", Some("C:\\proj\\.aws\\credentials")).is_err(), "{mode:?}");
            assert!(decide(&st, "fs_read", Some("C:\\proj\\cert.pem")).is_err(), "{mode:?}");
            assert!(decide(&st, "fs_delete", Some("C:\\proj\\.npmrc")).is_err(), "{mode:?}");
            // не-чувствительные проходят
            assert!(decide(&st, "fs_read", Some("C:\\proj\\src\\main.rs")).is_ok(), "{mode:?}");
            // «environment.ts» содержит «env», но не «.env» и не sensitive
            assert!(decide(&st, "fs_read", Some("C:\\proj\\environment.ts")).is_ok(), "{mode:?}");
        }
    }

    #[test]
    fn env_substring_backstop_and_allow_escape() {
        let st = state(PermMode::Full, &["C:\\proj"]);
        // raw-подстрока .env ловит регистр и вариации без канонизации
        assert!(decide(&st, "fs_read", Some("C:\\proj\\.ENV")).is_err());
        assert!(decide(&st, "fs_grep", Some("C:\\proj\\.env.local")).is_err());
        // false positive уводится явным allow-правилом владельца
        let mut st2 = state(PermMode::Full, &["C:\\proj"]);
        st2.rules.allow = vec!["fs_read(C:\\proj\\app.env.backup)".into()];
        assert!(decide(&st2, "fs_read", Some("C:\\proj\\app.env.backup")).is_ok());
    }

    #[test]
    fn sensitive_escape_via_exact_allow_rule() {
        let mut st = state(PermMode::Full, &["C:\\proj"]);
        st.rules.allow = vec!["fs_read(C:\\proj\\.env)".into()];
        assert!(decide(&st, "fs_read", Some("C:\\proj\\.env")).is_ok());
        // allow точечный: соседний .env.production всё ещё deny (граница
        // компонента в матчинге правил + бэкстоп)
        assert!(decide(&st, "fs_read", Some("C:\\proj\\.env.production")).is_err());
        // allow на чтение не даёт запись
        assert!(decide(&st, "fs_write", Some("C:\\proj\\.env")).is_err());
    }

    #[test]
    fn config_dir_gate_unconditional_and_first() {
        let mut st = state(PermMode::Full, &["C:\\Users\\me\\AppData\\Roaming"]);
        st.config_dir = Some("c:\\users\\me\\appdata\\roaming\\com.haloui.app".to_string());
        // даже allow-правило владельца НЕ перекрывает самозащиту конфига
        st.rules.allow = vec![
            "fs_write(C:\\Users\\me\\AppData\\Roaming\\com.haloui.app\\hooks.json)".into(),
        ];
        assert!(decide(
            &st,
            "fs_write",
            Some("C:\\Users\\me\\AppData\\Roaming\\com.haloui.app\\hooks.json")
        )
        .is_err());
        assert!(decide(
            &st,
            "fs_read",
            Some("C:\\Users\\me\\AppData\\Roaming\\com.haloui.app\\settings.json")
        )
        .is_err());
        assert!(decide(
            &st,
            "fs_delete",
            Some("C:\\Users\\me\\AppData\\Roaming\\com.haloui.app\\mcp.json")
        )
        .is_err());
        // сиблинг конфиг-каталога — не конфиг (граница компонента)
        assert!(decide(
            &st,
            "fs_write",
            Some("C:\\Users\\me\\AppData\\Roaming\\com.haloui.app-backup\\x.json")
        )
        .is_ok());
    }

    #[test]
    fn sensitive_gates_work_without_roots() {
        // Без проекта path-контроль корней off, безусловные гейты — on
        let st = state(PermMode::Full, &[]);
        assert!(decide(&st, "fs_read", Some("C:\\proj\\.env")).is_err());
        assert!(decide(&st, "fs_read", Some("C:\\proj\\src\\a.rs")).is_ok());
    }
}
