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
    /// персистентные правила (perm_set валидирует fail-closed)
    pub rules: PermRules,
    /// канонизованный app-config каталог — самозащита конфига
    pub config_dir: Option<String>,
}

/// Глобальный каталог конфигурации приложения, вычисленный при старте
static APP_CONFIG_DIR: Mutex<Option<String>> = Mutex::new(None);

/// Инициализация каталога конфигурации при старте приложения
pub fn init_config_dir(path: &std::path::Path) {
    let norm = norm_canonical_path(&path.to_string_lossy());
    let mut g = APP_CONFIG_DIR.lock().unwrap_or_else(|p| p.into_inner());
    *g = Some(norm);
}

/// Глобальное состояние (одно на процесс). None = ещё не синхронизировано
static PERM: Mutex<Option<PermState>> = Mutex::new(None);

#[cfg(test)]
thread_local! {
    static TEST_PERM: std::cell::RefCell<Option<PermState>> = const { std::cell::RefCell::new(None) };
}

/// Текущее состояние; до первого perm_set — Ask без корней и без синхронизации
pub(crate) fn current() -> PermState {
    #[cfg(test)]
    {
        if let Some(st) = TEST_PERM.with(|c| c.borrow().clone()) {
            return st;
        }
    }
    let default_cfg = APP_CONFIG_DIR
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    PERM.lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
        .unwrap_or_else(|| PermState {
            mode: PermMode::Ask,
            roots: Vec::new(),
            roots_canon: Vec::new(),
            synced: false,
            rules: PermRules::default(),
            config_dir: default_cfg,
        })
}

/// Обновить состояние (вызывается командой perm_set из фронта).
/// into_inner: poison (паника под локом) не имеет права превращать perm_set
/// в no-op — иначе все мутации навсегда отбивались бы «not synchronized yet»
/// при внешне зелёном UI, и ни один лог об этом не сказал бы
pub(crate) fn set(state: PermState) {
    #[cfg(test)]
    {
        TEST_PERM.with(|c| *c.borrow_mut() = Some(state.clone()));
    }
    let mut g = PERM.lock().unwrap_or_else(|p| p.into_inner());
    *g = Some(state);
}

/// Принудительно сбросить состояние в безопасный режим (Plan, без корней, не синхронизирован).
pub fn reset_fail_closed() {
    let default_cfg = APP_CONFIG_DIR
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    set(PermState {
        mode: PermMode::Plan,
        roots: vec![],
        roots_canon: vec![],
        synced: false,
        rules: PermRules::default(),
        config_dir: default_cfg,
    });
}

/// Персистентные правила прав. deny — серверный блок во всех
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
/// «not synchronized» держит мутации, пока пользователь не починит список).
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
        "fs_read" | "fs_write" | "fs_delete" | "fs_list" | "fs_grep" | "diagnostics"
    );
    if for_allow && parsed.prefix.is_none() && (parsed.tool == "shell_run" || fs_tool) {
        return Err(format!(
            "allow rule for {} requires a prefix",
            parsed.tool
        ));
    }
    if for_allow && parsed.tool == "shell_run" {
        if let Some(prefix) = &parsed.prefix {
            let first_token = prefix.split_whitespace().next().unwrap_or("");
            let base_cmd = first_token.rsplit(['/', '\\']).next().unwrap_or(first_token);
            let base_cmd = base_cmd.strip_suffix(".exe").unwrap_or(base_cmd).to_lowercase();
            const INTERPRETERS_AND_WRAPPERS: &[&str] = &[
                "git", "npm", "npx", "node", "python", "python3", "pip", "pip3", "cargo",
                "bash", "sh", "zsh", "env", "ssh", "docker", "sudo", "ruby", "perl", "php",
            ];
            if INTERPRETERS_AND_WRAPPERS.contains(&base_cmd.as_str()) && rule.contains('*') {
                return Err(format!(
                    "wildcard allow rule for interpreter/wrapper '{base_cmd}' is forbidden; specify an exact command without wildcard"
                ));
            }
        }
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

/// Канонизованная нормализованная форма для матчинга правил: 8.3-алиасы, регистр и разделители разворачивает
/// canonicalize, сырой вход в матчинг не попадает никогда
fn canon_norm(path: &str) -> String {
    match canonicalize_for_compare(std::path::Path::new(path)) {
        Some(c) => norm_for_compare(&c.to_string_lossy()),
        None => norm_for_compare(path),
    }
}

/// Обёртка для perm_set: канонизация config-каталога самозащиты
pub(crate) fn norm_canonical_path(path: &str) -> String {
    canon_norm(path)
}

/// Матч списка правил против (tool, arg). arg для fs_* — канонизованная
/// форма (компонентная граница: префикс «C:\proj» не матчит «C:\projects»),
/// для shell_run — сырая команда case-insensitive (Windows: «GIT» = «git»)
/// с границей слова через пробел («git *» не матчит «github-cli»).
/// Битые правила в стейте не матчатся — валидация на perm_set.
fn is_fs_read_family(tool: &str) -> bool {
    matches!(tool, "fs_read" | "fs_list" | "fs_grep" | "diagnostics")
}

fn is_fs_write_family(tool: &str) -> bool {
    matches!(tool, "fs_write" | "fs_delete")
}

/// Строгий список инструментов только для чтения.
/// Все остальные инструменты считаются мутирующими (fail-closed denylist инвертирован).
pub(crate) fn is_read_only_tool(name: &str) -> bool {
    matches!(
        name,
        "fs_read"
            | "fs_list"
            | "fs_grep"
            | "diagnostics"
            | "browser_read"
            | "browser_screenshot"
            | "computer_screenshot"
            | "vault_search"
            | "vault_read"
            | "memory_recall"
            | "web_search"
            | "mcp_tool_discover"
            | "ask_user"
            | "sleep"
            | "plan_update"
            | "subagent_status"
            | "memory_save"
    )
}

/// Разрешённые инструменты в режиме Plan (строго read-only).
/// LSP diagnostics исключён, так как серверы анализируют и могут исполнять код проекта.
pub const PLAN_READ_ONLY: &[&str] = &[
    "browser_read",
    "browser_screenshot",
    "computer_screenshot",
    "vault_search",
    "vault_read",
    "memory_recall",
    "web_search",
    "mcp_tool_discover",
    "ask_user",
    "sleep",
    "plan_update",
    "subagent_status",
];

/// Проверка файлов класса auto-exec, исполняемых инструментами сборки, CI или хуками
pub(crate) fn is_auto_exec_path(path: &str) -> bool {
    let lower = path.to_lowercase();
    let norm = lower.replace('/', "\\");
    let comps: Vec<&str> = norm.split('\\').filter(|c| !c.is_empty()).collect();
    let Some(fname) = comps.last().copied() else {
        return false;
    };
    for w in comps.windows(2) {
        if w[0] == ".cargo" && (w[1] == "config.toml" || w[1] == "config") {
            return true;
        }
        if w[0] == ".vscode" && (w[1] == "tasks.json" || w[1] == "launch.json") {
            return true;
        }
        if w[0] == ".github" && w[1] == "workflows" {
            return true;
        }
    }
    if comps.contains(&".husky") {
        return true;
    }
    matches!(
        fname,
        ".pre-commit-config.yaml"
            | ".pre-commit-config.yml"
            | ".envrc"
            | ".bashrc"
            | ".zshrc"
            | ".profile"
            | "makefile"
            | "gnumakefile"
    )
}

/// Матч списка правил против (tool, arg). arg для fs_* — канонизованная
/// форма (компонентная граница: префикс «C:\proj» не матчит «C:\projects»),
/// для shell_run — сырая команда case-insensitive с границей слова по whitespace.
/// Для fs-правил с путём сопоставление выполняется по семейству (read vs write).
fn rule_matches(rules: &[String], tool: &str, arg: Option<&str>, arg_is_path: bool) -> bool {
    for r in rules {
        let Some(p) = parse_rule(r) else { continue };
        let tool_matches = if arg_is_path && p.prefix.is_some() {
            (is_fs_write_family(&p.tool) && is_fs_write_family(tool))
                || (is_fs_read_family(&p.tool) && is_fs_read_family(tool))
                || p.tool == tool
        } else {
            p.tool == tool
        };
        if !tool_matches {
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
            let prefix_trimmed = prefix.trim_end_matches(['/', '\\']);
            let pn = canon_norm(prefix_trimmed);
            let pn = pn.trim_end_matches(['/', '\\']);
            let an = norm_for_compare(a);
            let an = an.trim_end_matches(['/', '\\']);
            let sep = if cfg!(windows) { '\\' } else { '/' };
            an == pn
                || (an.starts_with(pn) && an[pn.len()..].starts_with(sep))
        } else {
            let pl = prefix.to_lowercase();
            let al = a.to_lowercase();
            let pl_tokens: Vec<&str> = pl.split_whitespace().collect();
            let al_tokens: Vec<&str> = al.split_whitespace().collect();
            if pl_tokens.is_empty() {
                false
            } else if al_tokens.len() >= pl_tokens.len() {
                al_tokens[..pl_tokens.len()] == pl_tokens[..]
            } else {
                false
            }
        };
        if hit {
            return true;
        }
    }
    false
}

/// Раскрытие переменных окружения (%VAR%, $VAR, ${VAR}) и ~ в путях для shell-анализа
fn expand_env_and_tilde(raw: &str) -> String {
    let mut s = raw.to_string();
    if s.starts_with('~') {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_default();
        if !home.is_empty() {
            if s == "~" {
                s = home;
            } else if s.starts_with("~/") || s.starts_with("~\\") {
                s = format!("{}{}", home, &s[1..]);
            }
        }
    }
    while let Some(start) = s.find('%') {
        if let Some(end) = s[start + 1..].find('%') {
            let var_name = &s[start + 1..start + 1 + end];
            if !var_name.is_empty() {
                let val = std::env::var(var_name).unwrap_or_default();
                s.replace_range(start..=start + 1 + end, &val);
                continue;
            }
        }
        break;
    }
    while let Some(start) = s.find('$') {
        let rest = &s[start + 1..];
        if rest.starts_with('{') {
            if let Some(end) = rest.find('}') {
                let var_name = &rest[1..end];
                let val = std::env::var(var_name).unwrap_or_default();
                s.replace_range(start..=start + 1 + end, &val);
                continue;
            }
        } else {
            let var_len = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_').count();
            if var_len > 0 {
                let var_name = &rest[..var_len];
                let val = std::env::var(var_name).unwrap_or_default();
                s.replace_range(start..=start + var_len, &val);
                continue;
            }
        }
        break;
    }
    s
}

/// Извлечение подстановок команд $(...) и `...`
fn extract_substitutions(cmd: &str) -> Vec<String> {
    let mut subs = Vec::new();
    let mut chars = cmd.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        if c == '$' && chars.peek().map(|&(_, next_c)| next_c) == Some('(') {
            chars.next();
            let start = i + 2;
            let mut depth = 1;
            let mut end = None;
            for (j, inner_c) in chars.by_ref() {
                if inner_c == '(' {
                    depth += 1;
                } else if inner_c == ')' {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(j);
                        break;
                    }
                }
            }
            if let Some(e) = end {
                let sub = cmd[start..e].trim();
                if !sub.is_empty() {
                    subs.push(sub.to_string());
                }
            }
        } else if c == '`' {
            let start = i + 1;
            let mut end = None;
            for (j, inner_c) in chars.by_ref() {
                if inner_c == '`' {
                    end = Some(j);
                    break;
                }
            }
            if let Some(e) = end {
                let sub = cmd[start..e].trim();
                if !sub.is_empty() {
                    subs.push(sub.to_string());
                }
            }
        }
    }
    subs
}

/// Снятие стандартных обёрток команд (sudo, env, nohup, timeout, xargs, etc.)
fn unwrap_command_wrappers(seg: &str) -> String {
    let trimmed = seg.trim();
    let tokens: Vec<&str> = trimmed.split_whitespace().collect();
    if tokens.is_empty() {
        return trimmed.to_string();
    }
    let mut idx = 0;
    while idx < tokens.len() {
        let tok = tokens[idx].to_lowercase();
        let tok_fname = tok.rsplit(['/', '\\']).next().unwrap_or(&tok);
        if matches!(
            tok_fname,
            "sudo" | "nohup" | "exec" | "command" | "xargs" | "timeout"
        ) {
            idx += 1;
            while idx < tokens.len() && tokens[idx].starts_with('-') {
                idx += 1;
                if idx < tokens.len()
                    && !tokens[idx].starts_with('-')
                    && (tokens[idx - 1] == "-u" || tokens[idx - 1] == "-t")
                {
                    idx += 1;
                }
            }
            continue;
        }
        if tok_fname == "env" {
            idx += 1;
            while idx < tokens.len() && (tokens[idx].starts_with('-') || tokens[idx].contains('=')) {
                idx += 1;
            }
            continue;
        }
        if tok.contains('=') && !tok.starts_with('-') {
            idx += 1;
            continue;
        }
        if (tok_fname == "sh" || tok_fname == "bash" || tok_fname == "zsh")
            && idx + 2 <= tokens.len()
            && tokens[idx + 1] == "-c"
        {
            let inner = tokens[idx + 2..].join(" ");
            let clean = inner.trim_matches(|c| c == '"' || c == '\'');
            return unwrap_command_wrappers(clean);
        }
        break;
    }
    if idx < tokens.len() {
        let first = tokens[idx];
        let first_base = first.rsplit(['/', '\\']).next().unwrap_or(first);
        let first_clean = first_base.strip_suffix(".exe").unwrap_or(first_base);
        let rest = if idx + 1 < tokens.len() {
            format!(" {}", tokens[idx + 1..].join(" "))
        } else {
            String::new()
        };
        format!("{first_clean}{rest}")
    } else {
        trimmed.to_string()
    }
}

/// Сегменты составной команды: разделение по ;, &&, ||, |, \n,
/// а также разбор подстановок $(...), `...` и нормализация обёрток команд
fn shell_segments(cmd: &str) -> Vec<String> {
    let mut segs: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut chars = cmd.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\n' | ';' => segs.push(std::mem::take(&mut cur)),
            '&' | '|' => {
                if chars.peek() == Some(&c) {
                    chars.next();
                }
                segs.push(std::mem::take(&mut cur));
            }
            _ => cur.push(c),
        }
    }
    segs.push(cur);

    let mut all_segs: Vec<String> = Vec::new();
    for s in segs {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            continue;
        }
        for sub in extract_substitutions(trimmed) {
            all_segs.extend(shell_segments(&sub));
        }
        let unwrapped = unwrap_command_wrappers(trimmed);
        if unwrapped != trimmed {
            all_segs.push(unwrapped);
        }
        all_segs.push(trimmed.to_string());
    }
    all_segs
}

/// Матчинг правил по составной команде:
/// deny = совпадение любого сегмента,
/// allow = совпадение всех сегментов, при этом подстановки ($(), `, (, >, <) запрещены в allow
fn rule_matches_shell(rules: &[String], cmd: &str, require_all: bool) -> bool {
    if require_all
        && (cmd.contains("$(")
            || cmd.contains('`')
            || cmd.contains('(')
            || cmd.contains('>')
            || cmd.contains('<'))
    {
        return false;
    }
    let segs = shell_segments(cmd);
    if segs.is_empty() {
        return false;
    }
    let hit = |seg: &str| rule_matches(rules, "shell_run", Some(seg), false);
    if require_all {
        segs.iter().all(|s| hit(s))
    } else {
        segs.iter().any(|s| hit(s))
    }
}

/// Проверка попадания shell-команды в защищённый каталог конфигурации приложения
fn shell_command_hits_config_dir(cmd: &str, config_dir: Option<&str>) -> bool {
    let Some(cfg) = config_dir else {
        return false;
    };
    let cfg_norm = norm_canonical_path(cfg);
    let sep = if cfg!(windows) { '\\' } else { '/' };

    shell_segments(cmd).iter().any(|seg| {
        seg.split_whitespace().any(|raw| {
            let clean: String = raw.chars().filter(|c| *c != '"' && *c != '\'').collect();
            if clean.is_empty() {
                return false;
            }
            let expanded = expand_env_and_tilde(&clean);
            let norm = norm_canonical_path(&expanded);
            norm == cfg_norm || norm.starts_with(&format!("{cfg_norm}{sep}"))
        })
    })
}

/// Проверка токенов shell-команды на попадание в чувствительные пути
fn shell_command_hits_sensitive(cmd: &str) -> bool {
    shell_segments(cmd).iter().any(|seg| {
        seg.split_whitespace().any(|raw| {
            let clean: String = raw.chars().filter(|c| *c != '"' && *c != '\'').collect();
            if clean.starts_with('-') || clean.len() < 2 || clean == "~" {
                return false;
            }
            let expanded = expand_env_and_tilde(&clean);
            let norm = norm_for_compare(&expanded);
            let comps: Vec<&str> = norm.split(['/', '\\']).filter(|c| !c.is_empty()).collect();
            let fname = comps.last().copied().unwrap_or(&norm);

            let has_sensitive_glob = comps.iter().any(|c| {
                (c.contains('*') || c.contains('?'))
                    && (c.starts_with(".s")
                        || c.starts_with(".a")
                        || c.starts_with(".k")
                        || c.starts_with(".d")
                        || c.starts_with(".g")
                        || c.starts_with("id_"))
            });

            is_sensitive_path(&norm)
                || has_sensitive_glob
                || fname == ".env"
                || fname.starts_with(".env.")
                || fname == ".git-credentials"
                || fname == ".netrc"
                || fname == ".npmrc"
                || fname.starts_with("id_rsa")
                || fname.starts_with("id_ed25519")
                || fname.ends_with(".pem")
                || fname.ends_with(".ppk")
                || (comps.contains(&".aws") && (fname == "credentials" || fname == "config"))
                || (comps.contains(&".kube") && fname == "config")
                || (comps.contains(&".docker") && fname == "config.json")
        })
    })
}

/// Решение по инструменту. Возвращаемое Err — текст для модели.
fn decide_shell(state: &PermState, cmd: Option<&str>) -> Result<(), String> {
    let Some(raw_cmd) = cmd else {
        return Err("shell_run requires a non-empty command argument".to_string());
    };
    let trimmed = raw_cmd.trim();
    if trimmed.is_empty() {
        return Err("shell_run requires a non-empty command argument".to_string());
    }
    if rule_matches_shell(&state.rules.deny, trimmed, false) {
        return Err("blocked by deny rule (shell_run)".to_string());
    }
    if shell_command_hits_config_dir(trimmed, state.config_dir.as_deref()) {
        return Err(
            "access to the app config directory is denied unconditionally".to_string(),
        );
    }
    if shell_command_hits_sensitive(trimmed)
        && !rule_matches_shell(&state.rules.allow, trimmed, true)
    {
        return Err(
            "command references a protected path (secrets are denied by default; the owner can allow it explicitly)"
                .to_string(),
        );
    }
    Ok(())
}

pub(crate) fn decide(state: &PermState, name: &str, arg: Option<&str>) -> Result<(), String> {
    let mutating = !is_read_only_tool(name);
    let fs_tool = matches!(
        name,
        "fs_read" | "fs_list" | "fs_write" | "fs_delete" | "fs_grep" | "diagnostics"
    );

    if name == "shell_run" {
        decide_shell(state, arg)?;
    } else {
        if name.starts_with("vault_") {
            if let Some(p) = arg {
                if p.contains("..") || p.contains('/') || p.contains('\\') || p.contains(':') {
                    return Err(format!("blocked: invalid note path '{p}' (traversal characters are forbidden)"));
                }
                if is_sensitive_path(p) {
                    return Err(format!("blocked: note path '{p}' hits sensitive pattern"));
                }
            }
        }
        let rule_arg: Option<String> = if fs_tool {
            arg.map(canon_norm)
        } else {
            arg.map(|p| p.to_string())
        };
        let denied = rule_matches(&state.rules.deny, name, rule_arg.as_deref(), fs_tool);
        if denied {
            return Err(format!("blocked by deny rule ({name})"));
        }
    }

    if !state.synced && (mutating || fs_tool || name == "shell_run") {
        return Err("permission mode not synchronized yet; retry shortly".to_string());
    }

    match state.mode {
        PermMode::Plan => {
            if name == "diagnostics" {
                return Err("blocked by permission mode: plan (diagnostics executes workspace code and is not allowed in plan mode)".to_string());
            }
            if mutating {
                return Err(format!("blocked by permission mode: plan (tool {name})"));
            }
            if fs_tool {
                check_fs_path(state, name, arg)?;
                return Ok(());
            }
            if !PLAN_READ_ONLY.contains(&name) {
                return Err(format!(
                    "blocked by permission mode: plan (tool {name} is not a known read-only tool)"
                ));
            }
            Ok(())
        }
        PermMode::Edit => {
            if mutating && name != "fs_write" {
                return Err(format!(
                    "tool blocked: {name} requires full or ask mode (edit mode allows fs_write only)"
                ));
            }
            if name == "fs_write" {
                if let Some(p) = arg {
                    if is_auto_exec_path(p) {
                        return Err(format!(
                            "tool blocked: modifying auto-exec file requires full or ask mode: {p}"
                        ));
                    }
                }
            }
            if fs_tool {
                check_fs_path(state, name, arg)?;
            }
            Ok(())
        }
        PermMode::Ask => {
            if fs_tool {
                check_fs_path(state, name, arg)?;
            }
            Ok(())
        }
        PermMode::Full => {
            if fs_tool {
                check_fs_path(state, name, arg)?;
            }
            Ok(())
        }
    }
}

/// Path-контроль для fs_* инструментов.
pub(crate) fn check_fs_path(state: &PermState, name: &str, path: Option<&str>) -> Result<(), String> {
    let Some(p) = path else {
        return Err("fs tool requires a path argument".to_string());
    };
    let canon = canon_norm(p);
    let sep = if cfg!(windows) { '\\' } else { '/' };

    let Some(cfg) = &state.config_dir else {
        return Err("app config directory is not initialized (access denied)".to_string());
    };

    // 1) Самозащита конфига: БЕЗУСЛОВНО и ДО любых правил
    if matches!(
        name,
        "fs_read" | "fs_write" | "fs_delete" | "fs_grep" | "fs_list" | "diagnostics"
    ) && (canon == *cfg || canon.starts_with(&format!("{cfg}{sep}")))
    {
        return Err(
            "access to the app config directory is denied unconditionally".to_string(),
        );
    }

    // 2) .env-бэкстоп: raw-подстрока case-insensitive
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
        if matches!(name, "fs_write" | "fs_delete") {
            return Err("file modifications require project roots to be configured".to_string());
        }
        return Ok(());
    }
    if !path_allowed(&state.roots_canon, p) {
        return Err(format!("path outside project roots: {p}"));
    }
    Ok(())
}

/// Повторная проверка финального расположения после верифицированного открытия файла
pub fn recheck_location(name: &str, verified: &std::path::Path) -> Result<(), String> {
    let state = current();
    check_fs_path(&state, name, Some(&verified.to_string_lossy()))
}

/// Чувствительный класс путей (по канонизованной нормализованной форме)
pub(crate) fn is_sensitive_path(canon: &str) -> bool {
    let lower = canon.to_lowercase();
    let norm = lower.replace('/', "\\");
    let comps: Vec<&str> = norm.split('\\').filter(|c| !c.is_empty()).collect();
    let Some(name) = comps.last().copied() else {
        return false;
    };
    if comps.iter().any(|c| matches!(*c, ".ssh" | ".aws" | ".kube" | ".docker" | ".gnupg")) {
        return true;
    }
    for w in comps.windows(2) {
        if w[0] == ".git" && w[1] == "config" {
            return true;
        }
        if w[0] == ".aws" && (w[1] == "credentials" || w[1] == "config") {
            return true;
        }
        if w[0] == ".kube" && w[1] == "config" {
            return true;
        }
        if w[0] == ".docker" && w[1] == "config.json" {
            return true;
        }
    }
    if comps.contains(&".git") && comps.contains(&"hooks") {
        return true;
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
    #[cfg(windows)]
    {
        let mut s = s.to_lowercase().replace('/', "\\");
        if let Some(rest) = s.strip_prefix("\\\\?\\unc\\") {
            s = format!("\\\\{rest}");
        } else if let Some(rest) = s.strip_prefix("\\\\?\\") {
            s = rest.to_string();
        }
        s
    }
    #[cfg(target_os = "macos")]
    {
        s.to_lowercase().replace('\\', "/")
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
/// существующего файла — поднимается до первого существующего предка,
/// канонизирует его и присоединяет накопленный остаток.
fn canonicalize_for_compare(path: &std::path::Path) -> Option<std::path::PathBuf> {
    if let Ok(c) = dunce::canonicalize(path) {
        return Some(c);
    }
    // Собираем компоненты с конца, пока предок не станет существующим
    let mut curr = path;
    let mut suffix = Vec::new();
    while !curr.exists() {
        if let Some(name) = curr.file_name() {
            suffix.push(name);
        } else {
            break;
        }
        match curr.parent() {
            Some(p) if !p.as_os_str().is_empty() => curr = p,
            _ => break,
        }
    }
    let real_ancestor = dunce::canonicalize(curr).ok()?;
    let mut res = real_ancestor;
    for part in suffix.into_iter().rev() {
        res.push(part);
    }
    Some(res)
}

#[cfg(test)]
mod tests {

    #[test]
    fn shell_rules_match_by_segments() {
        let deny = vec!["shell_run(rm *)".to_string()];
        assert!(rule_matches_shell(&deny, "rm x", false));
        assert!(rule_matches_shell(&deny, "cd /tmp && rm -rf x", false));
        assert!(rule_matches_shell(&deny, "sudo rm -rf x", false));
        assert!(rule_matches_shell(&deny, "/bin/rm -rf x", false));
        assert!(rule_matches_shell(&deny, "echo $(rm -rf x)", false));
        assert!(!rule_matches_shell(&deny, "git status", false));

        let allow = vec!["shell_run(git status)".to_string()];
        assert!(rule_matches_shell(&allow, "git status", true));
        assert!(!rule_matches_shell(&allow, "git status $(cat ~/.ssh/id_rsa)", true));
        assert!(!rule_matches_shell(&allow, "git status > out.txt", true));
    }

    #[test]
    fn shell_sensitive_path_tokens_detected() {
        assert!(shell_command_hits_sensitive("cat ~/.ssh/id_rsa"));
        assert!(shell_command_hits_sensitive("type C:\\proj\\.env"));
        assert!(shell_command_hits_sensitive("cat .env"));
        assert!(shell_command_hits_sensitive("cat ~/.s*/id*"));
        assert!(shell_command_hits_sensitive("cat ~/.s\"\"sh/id_rsa"));
        assert!(shell_command_hits_sensitive("cat C:/Users/me/.ssh/config"));
        assert!(shell_command_hits_sensitive("cat ~/.kube/config"));
        assert!(shell_command_hits_sensitive("cat ~/.docker/config.json"));
        assert!(shell_command_hits_sensitive("openssl genrsa -out server.pem 2048"));
        // Обычные команды не трогаем
        assert!(!shell_command_hits_sensitive("git status && npm test"));
        assert!(!shell_command_hits_sensitive("cargo clippy --all-targets"));
    }

    #[test]
    fn shell_hits_config_dir_detected() {
        let cfg = "C:\\Users\\me\\AppData\\Roaming\\com.haloui.app";
        assert!(shell_command_hits_config_dir(
            "type C:\\Users\\me\\AppData\\Roaming\\com.haloui.app\\settings.json",
            Some(cfg)
        ));
        assert!(shell_command_hits_config_dir(
            "echo test > C:\\Users\\me\\AppData\\Roaming\\com.haloui.app\\hooks.json",
            Some(cfg)
        ));
        let cfg_unix = "/home/me/.config/com.haloui.app";
        assert!(shell_command_hits_config_dir(
            "cat /home/me/.config/com.haloui.app/settings.json",
            Some(cfg_unix)
        ));
        assert!(shell_command_hits_config_dir(
            "echo test > /home/me/.config/com.haloui.app/hooks.json",
            Some(cfg_unix)
        ));
    }

    #[test]
    fn shell_run_requires_command_argument() {
        let st = state(PermMode::Full, &["C:\\proj"]);
        assert!(decide(&st, "shell_run", None).is_err());
        assert!(decide(&st, "shell_run", Some("")).is_err());
        assert!(decide(&st, "shell_run", Some("   ")).is_err());
        assert!(decide(&st, "shell_run", Some("cargo test")).is_ok());
    }

    #[test]
    fn unix_sensitive_paths_detected() {
        assert!(is_sensitive_path("/home/user/.ssh/id_rsa"));
        assert!(is_sensitive_path("/home/user/.aws/credentials"));
        assert!(is_sensitive_path("/home/user/.kube/config"));
        assert!(is_sensitive_path("/home/user/.docker/config.json"));
        assert!(is_sensitive_path("/home/user/proj/.env"));
        assert!(is_sensitive_path("/home/user/proj/.git/config"));
        assert!(is_sensitive_path("/home/user/proj/.git/hooks/pre-commit"));
        assert!(!is_sensitive_path("/home/user/proj/src/main.rs"));
    }

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
            config_dir: Some(norm_canonical_path(if cfg!(windows) {
                "C:\\Users\\me\\AppData\\Roaming\\com.haloui.app"
            } else {
                "/home/me/.config/com.haloui.app"
            })),
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
        // Регистр: на linux значим (регистрозависимая ФС), на macOS — нет
        #[cfg(target_os = "linux")]
        assert!(!path_allowed(&roots, "/HOME/u/proj/src/a.rs"));
        #[cfg(target_os = "macos")]
        assert!(path_allowed(&roots, "/HOME/u/proj/src/a.rs"));
    }

    #[test]
    fn not_synced_blocks_mutating() {
        let mut st = state(PermMode::Plan, &[]);
        st.synced = false;
        assert!(decide(&st, "shell_run", None).is_err());
        assert!(decide(&st, "fs_write", Some("C:\\proj\\a")).is_err());
        assert!(decide(&st, "fs_read", Some("C:\\proj\\a")).is_err());
    }

    // ---------- decide ----------

    #[test]
    fn plan_blocks_mutating() {
        assert!(decide(&state(PermMode::Plan, &[]), "fs_write", None).is_err());
    }

    #[test]
    fn plan_allows_readonly_when_roots_empty() {
        assert!(decide(&state(PermMode::Plan, &[]), "fs_read", None).is_err());
        assert!(decide(&state(PermMode::Plan, &[]), "fs_read", Some("C:\\proj\\a.rs")).is_ok());
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
        // Auto-exec блокируется в Edit
        assert!(decide(
            &state(PermMode::Edit, &["C:\\proj"]),
            "fs_write",
            Some("C:\\proj\\.cargo\\config.toml")
        )
        .is_err());
        assert!(decide(
            &state(PermMode::Edit, &["C:\\proj"]),
            "fs_write",
            Some("C:\\proj\\.husky\\pre-commit")
        )
        .is_err());
        // Прочие мутации блокируются
        assert!(decide(&state(PermMode::Edit, &["C:\\proj"]), "computer_click", None).is_err());
        assert!(decide(&state(PermMode::Edit, &["C:\\proj"]), "browser_navigate", None).is_err());
        assert!(decide(&state(PermMode::Edit, &["C:\\proj"]), "mcp__server__tool", None).is_err());
        assert!(decide(&state(PermMode::Edit, &["C:\\proj"]), "vault_write", None).is_err());
        assert!(decide(&state(PermMode::Edit, &["C:\\proj"]), "image_generate", None).is_err());
        assert!(decide(&state(PermMode::Edit, &["C:\\proj"]), "gguf_cut", None).is_err());
        assert!(decide(&state(PermMode::Edit, &["C:\\proj"]), "gguf_test", None).is_err());
    }

    #[test]
    fn edit_blocks_shell_run() {
        assert!(decide(&state(PermMode::Edit, &[]), "shell_run", None).is_err());
    }

    #[test]
    fn ask_defers_shell_run_to_frontend_confirm() {
        assert!(decide(&state(PermMode::Ask, &[]), "shell_run", Some("echo hi")).is_ok());
        assert!(decide(&state(PermMode::Ask, &[]), "shell_run", None).is_err());
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
        assert!(decide(&state(PermMode::Full, &[]), "fs_write", Some("C:\\proj\\a")).is_err());
        assert!(decide(&state(PermMode::Full, &[]), "fs_delete", Some("C:\\proj\\a")).is_err());
    }

    #[test]
    fn ask_rejects_relative_read_path() {
        assert!(decide(&state(PermMode::Ask, &["C:\\proj"]), "fs_read", Some("../x")).is_err());
    }

    #[test]
    fn plan_is_read_only_for_all_mutating_tools() {
        for name in [
            "computer_click",
            "computer_type",
            "vault_write",
            "image_generate",
            "mcp__server__tool",
            "browser_navigate",
        ] {
            assert!(
                decide(&state(PermMode::Plan, &[]), name, None).is_err(),
                "plan must block {name}"
            );
        }
        assert!(decide(&state(PermMode::Plan, &[]), "computer_screenshot", None).is_ok());
        assert!(decide(&state(PermMode::Plan, &[]), "browser_read", None).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn ask_confirms_mutating_but_keeps_fs_path_control() {
        assert!(decide(&state(PermMode::Ask, &["C:\\proj"]), "fs_delete", Some("C:\\other\\x")).is_err());
        assert!(decide(&state(PermMode::Ask, &["C:\\proj"]), "fs_delete", Some("C:\\proj\\x")).is_ok());
        assert!(decide(&state(PermMode::Ask, &["C:\\proj"]), "shell_run", Some("dir")).is_ok());
        assert!(decide(&state(PermMode::Ask, &["C:\\proj"]), "shell_run", None).is_err());
        assert!(decide(&state(PermMode::Ask, &[]), "vault_write", None).is_ok());
    }

    #[test]
    fn vault_write_rejects_traversal_and_sensitive() {
        assert!(decide(&state(PermMode::Ask, &[]), "vault_write", Some("../../x.md")).is_err());
        assert!(decide(&state(PermMode::Ask, &[]), "vault_write", Some("a/b.md")).is_err());
        assert!(decide(&state(PermMode::Ask, &[]), "vault_write", Some("C:\\proj\\x.md")).is_err());
        assert!(decide(&state(PermMode::Ask, &[]), "vault_write", Some(".env.md")).is_err());
        assert!(decide(&state(PermMode::Ask, &[]), "vault_write", Some("note.md")).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn plan_fs_read_uses_path_control() {
        assert!(decide(&state(PermMode::Plan, &["C:\\proj"]), "fs_read", Some("C:\\other\\x")).is_err());
        assert!(decide(&state(PermMode::Plan, &["C:\\proj"]), "fs_read", Some("C:\\proj\\x")).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn diagnostics_is_read_only_with_fs_path_control() {
        // diagnostics блокируется в Plan
        assert!(decide(&state(PermMode::Plan, &[]), "diagnostics", None).is_err());
        assert!(decide(&state(PermMode::Plan, &["C:\\proj"]), "diagnostics", Some("C:\\proj\\a.rs")).is_err());
        // diagnostics разрешён в Ask и Full с path-контролем
        assert!(decide(&state(PermMode::Ask, &["C:\\proj"]), "diagnostics", Some("C:\\proj\\a.rs")).is_ok());
        assert!(decide(&state(PermMode::Plan, &["C:\\proj"]), "diagnostics", Some("C:\\other\\a.rs")).is_err());
        assert!(decide(&state(PermMode::Full, &["C:\\proj"]), "diagnostics", Some("C:\\proj\\.env")).is_err());
    }

    #[test]
    fn non_fs_read_only_tools_skip_path_control() {
        assert!(decide(&state(PermMode::Full, &["C:\\proj"]), "computer_screenshot", None).is_ok());
        assert!(decide(&state(PermMode::Full, &["C:\\proj"]), "browser_read", None).is_ok());
    }

    // ---------- правила ----------

    #[test]
    fn deny_rule_blocks_all_modes_and_reads() {
        let st = state_with_rules(
            PermMode::Full,
            &["C:\\proj"],
            rules_with(&["shell_run(rm *)", "web_search"], &[], &[]),
        );
        assert!(decide(&st, "shell_run", Some("rm -rf C:\\tmp\\x")).is_err());
        assert!(decide(&st, "shell_run", Some("RM -RF C:\\tmp")).is_err());
        assert!(decide(&st, "web_search", None).is_err());
        assert!(decide(&st, "shell_run", Some("git status")).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn deny_prefix_word_boundary_and_canonical_fs() {
        let st = state_with_rules(
            PermMode::Full,
            &["C:\\proj"],
            rules_with(&["shell_run(git *)", "fs_read(C:\\proj\\secrets)"], &[], &[]),
        );
        assert!(decide(&st, "shell_run", Some("github-cli auth")).is_ok());
        assert!(decide(&st, "shell_run", Some("git push")).is_err());
        assert!(decide(&st, "shell_run", Some("git\tpush")).is_err());
        assert!(decide(&st, "shell_run", Some("git\u{a0}push")).is_err());
        assert!(decide(&st, "fs_read", Some("C:\\proj\\secrets2\\a.txt")).is_ok());
        assert!(decide(&st, "fs_read", Some("C:\\proj\\secrets\\k.txt")).is_err());
        // Семейство: fs_read deny блокирует и fs_grep
        assert!(decide(&st, "fs_grep", Some("C:\\proj\\secrets\\k.txt")).is_err());
    }

    #[test]
    fn allow_rule_does_not_bypass_plan_or_edit_bounds() {
        let st = state_with_rules(
            PermMode::Plan,
            &["C:\\proj"],
            rules_with(&[], &["shell_run(git status)"], &[]),
        );
        assert!(decide(&st, "shell_run", Some("git status")).is_err());
        let edit = state_with_rules(
            PermMode::Edit,
            &["C:\\proj"],
            rules_with(&[], &["shell_run(git status)"], &[]),
        );
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
        assert_eq!(
            parse_rule("shell_run(git *)"),
            Some(ParsedRule { tool: "shell_run".into(), prefix: Some("git".into()) })
        );
        assert_eq!(parse_rule("web_search"), Some(ParsedRule { tool: "web_search".into(), prefix: None }));
        assert_eq!(parse_rule("tool(a*b)"), None);
        assert_eq!(parse_rule("tool("), None);
        assert_eq!(parse_rule("mcp__bad"), None);
        assert!(parse_rule("mcp__srv__tool").is_some());

        // Валидация: allow на интерпретаторы с wildcard запрещён
        assert!(validate_rule("shell_run(git *)", true, &known).is_err());
        assert!(validate_rule("shell_run(git status)", true, &known).is_ok());
        assert!(validate_rule("shell_run(echo *)", true, &known).is_ok());
        assert!(validate_rule("shell_run(git *)", false, &known).is_ok());
        assert!(validate_rule("shell_run", true, &known).is_err());
        assert!(validate_rule("shell_run", false, &known).is_ok());
        assert!(validate_rule("fs_read", true, &known).is_err());
        assert!(validate_rule("future_tool", false, &known).is_err());
        assert!(validate_rule("mcp__srv__tool", true, &known).is_ok());
        assert!(validate_rule("fs_read(proj/.env)", true, &known).is_err());
        assert!(validate_rule("web_search(x*y)", false, &known).is_err());
    }

    // ---------- чувствительные пути и самозащита ----------

    #[cfg(windows)]
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
            assert!(decide(&st, "fs_read", Some("C:\\proj\\src\\main.rs")).is_ok(), "{mode:?}");
            assert!(decide(&st, "fs_read", Some("C:\\proj\\environment.ts")).is_ok(), "{mode:?}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn env_substring_backstop_and_allow_escape() {
        let st = state(PermMode::Full, &["C:\\proj"]);
        assert!(decide(&st, "fs_read", Some("C:\\proj\\.ENV")).is_err());
        assert!(decide(&st, "fs_grep", Some("C:\\proj\\.env.local")).is_err());
        let mut st2 = state(PermMode::Full, &["C:\\proj"]);
        st2.rules.allow = vec!["fs_read(C:\\proj\\app.env.backup)".into()];
        assert!(decide(&st2, "fs_read", Some("C:\\proj\\app.env.backup")).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn sensitive_escape_via_exact_allow_rule() {
        let mut st = state(PermMode::Full, &["C:\\proj"]);
        st.rules.allow = vec!["fs_read(C:\\proj\\.env)".into()];
        assert!(decide(&st, "fs_read", Some("C:\\proj\\.env")).is_ok());
        assert!(decide(&st, "fs_read", Some("C:\\proj\\.env.production")).is_err());
        assert!(decide(&st, "fs_write", Some("C:\\proj\\.env")).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn config_dir_gate_unconditional_and_first() {
        let mut st = state(PermMode::Full, &["C:\\Users\\me\\AppData\\Roaming"]);
        st.config_dir = Some("c:\\users\\me\\appdata\\roaming\\com.haloui.app".to_string());
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
        assert!(decide(
            &st,
            "fs_write",
            Some("C:\\Users\\me\\AppData\\Roaming\\com.haloui.app-backup\\x.json")
        )
        .is_ok());
    }

    #[test]
    fn sensitive_gates_work_without_roots() {
        let st = state(PermMode::Full, &[]);
        assert!(decide(&st, "fs_read", Some("C:\\proj\\.env")).is_err());
        assert!(decide(&st, "fs_read", Some("C:\\proj\\src\\a.rs")).is_ok());
    }
}
