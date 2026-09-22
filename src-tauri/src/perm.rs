//! Серверный слой прав: PermMode + project roots.
//!
//! Бэкенд отклоняет то, что фронт не может разрешить своей моделью,
//! и применяет path-контроль для fs_* инструментов. Источник истины —
//! фронт (App.tsx): перед первым инструментом прогона он синхронизирует
//! режим и корень проекта командами perm_set / perm_get (api.ts).
//!
//! Контролируются только встроенные инструменты с прямым доступом к ФС/шеллу:
//! fs_read, fs_list, fs_write, fs_delete, shell_run. Остальные (vault_*,
//! browser_*, computer_*, mcp__*, image_generate) — вне контроля в этом тире.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;

/// Режим разрешений агента — зеркало PermissionMode на фронте (src/types.ts)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
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
}

/// Глобальное состояние (одно на процесс). None = ещё не синхронизировано
static PERM: Mutex<Option<PermState>> = Mutex::new(None);

/// Текущее состояние; до первого perm_set — Ask без корней (дефолт фронта)
pub(crate) fn current() -> PermState {
    PERM.lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or(PermState {
            mode: PermMode::Ask,
            roots: Vec::new(),
        })
}

/// Обновить состояние (вызывается командой perm_set из фронта)
pub(crate) fn set(state: PermState) {
    if let Ok(mut g) = PERM.lock() {
        *g = Some(state);
    }
}

/// Решение по инструменту. Возвращаемое Err — текст для модели.
/// Контролируются только встроенные инструменты с прямым доступом к ФС/шеллу:
/// fs_read, fs_list, fs_write, fs_delete, shell_run. Остальные (vault_*,
/// browser_*, computer_*, mcp__*, image_generate) — вне контроля в этом тире.
/// roots пуст → path-контроль не применяется (проект не выбран — не сужаем
/// текущее поведение). shell_run — без path-контроля: cwd опционален,
/// корневой cwd вебвью неизвестен.
pub(crate) fn decide(state: &PermState, name: &str, path: Option<&str>) -> Result<(), String> {
    // Не-контролируемое имя — сразу мимо
    if !matches!(
        name,
        "fs_read" | "fs_list" | "fs_write" | "fs_delete" | "shell_run"
    ) {
        return Ok(());
    }
    let mutating = matches!(name, "fs_write" | "fs_delete" | "shell_run");
    match state.mode {
        // План: запись и команды блокируются, чтение — с path-контролем
        PermMode::Plan => {
            if mutating {
                return Err(format!("blocked by permission mode: plan (tool {name})"));
            }
            check_fs_path(state, path)
        }
        // Edit: правки файлов без подтверждения, удаление и шелл — только full/ask
        PermMode::Edit => {
            if name == "fs_delete" || name == "shell_run" {
                return Err(
                    "tool blocked: fs_delete/shell_run require full or ask mode (edit mode allows fs_write only)"
                        .to_string(),
                );
            }
            check_fs_path(state, path)
        }
        // Ask: подтверждение делает фронт — бэкенд не должен ломать уже
        // подтверждённые вызовы fs_delete/shell_run; fs_write — path-контроль
        PermMode::Ask => {
            if mutating && name != "fs_write" {
                return Ok(());
            }
            check_fs_path(state, path)
        }
        // Full: всё исполняется, fs_* — с path-контролем, shell_run — свободно
        PermMode::Full => {
            if name == "shell_run" {
                return Ok(());
            }
            check_fs_path(state, path)
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
        Some(p) if path_allowed(&state.roots, p) => Ok(()),
        Some(p) => Err(format!("path outside project roots: {p}")),
        None => Err("fs tool requires a path argument".to_string()),
    }
}

/// Лежит ли path внутри одного из roots. Обе стороны нормализуются к нижнему
/// регистру и обратным слэшам (Windows-стиль), префикс сравнивается с учётом
/// границы компонента: "c:\proj" не матчит "c:\project". Относительные пути
/// запрещены — модель должна слать абсолютные (так предсказуемее).
fn path_allowed(roots: &[String], path: &str) -> bool {
    let norm = |s: &str| s.to_lowercase().replace('/', "\\");
    let p = norm(path);
    // Относительный путь (нет диска/UNC-префикса) — сразу запрещаем
    if !p.contains(':') && !p.starts_with('\\') {
        return false;
    }
    roots.iter().any(|r| {
        let root = norm(r);
        p == root || p.starts_with(&format!("{root}\\"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Корень проекта по умолчанию для тестов
    const ROOT: &str = "C:\\proj";

    fn state(mode: PermMode, roots: &[&str]) -> PermState {
        PermState {
            mode,
            roots: roots.iter().map(|s| s.to_string()).collect(),
        }
    }

    // ---------- path_allowed ----------

    #[test]
    fn path_inside_root() {
        assert!(path_allowed(&[ROOT.to_string()], "C:\\proj\\src\\a.rs"));
    }

    #[test]
    fn path_component_boundary_trap() {
        // Граница компонента: "c:\proj" не должен матчить "c:\project"
        assert!(!path_allowed(&[ROOT.to_string()], "C:\\project\\a.rs"));
    }

    #[test]
    fn path_case_insensitive() {
        assert!(path_allowed(&[ROOT.to_string()], "C:\\PROJ\\X.RS"));
    }

    #[test]
    fn relative_path_rejected() {
        assert!(!path_allowed(&[ROOT.to_string()], "src\\a.rs"));
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
    fn non_controlled_tool_passes_regardless_of_mode() {
        // vault_write и прочие вне контроля этого тира (см. шапку модуля)
        assert!(decide(&state(PermMode::Plan, &["C:\\proj"]), "vault_write", None).is_ok());
    }
}
