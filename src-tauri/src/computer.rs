//! Computer Use: скриншоты экрана и управление мышью/клавиатурой.
//!
//! Работает с основным монитором: xcap снимает экран в физических пикселях,
//! enigo двигает мышь в тех же координатах (Tauri-процесс DPI-aware, так что
//! виртуализации координат нет). Скриншот — JPEG, координаты кликов модель
//! берёт с последнего снимка, как и в Browser Use.
//!
//! Безопасность: все инструменты кроме computer_screenshot «mutating» —
//! проходят подтверждения агента и блокируются в режиме плана.

use base64::Engine;
use serde_json::{json, Value};
use std::sync::Mutex;

// ---------------------------------------------------------------------------
// Конфигурация (вкладка «Computer Use» в настройках)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[derive(Default)]
pub struct ComputerConfig {
    #[serde(default = "default_computer_enabled")]
    pub enabled: bool,
}

/// Computer Use по умолчанию выключен — включается явно в настройках
fn default_computer_enabled() -> bool {
    false
}


pub static CONFIG: Mutex<Option<ComputerConfig>> = Mutex::new(None);

pub fn config() -> ComputerConfig {
    CONFIG.lock().unwrap_or_else(|p| p.into_inner()).clone().unwrap_or_default()
}

pub fn set_config(cfg: ComputerConfig) {
    *CONFIG.lock().unwrap_or_else(|p| p.into_inner()) = Some(cfg);
}

// ---------------------------------------------------------------------------
// Схемы инструментов
// ---------------------------------------------------------------------------

pub fn computer_tool_schemas() -> Value {
    json!([
        {
            "type": "function",
            "function": {
                "name": "computer_screenshot",
                "description": "Take a JPEG screenshot of the primary monitor. Returns an image you can see. Click coordinates must be taken from the last screenshot.",
                "parameters": { "type": "object", "properties": {} }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "computer_click",
                "description": "Move the mouse to x,y (physical pixels of the primary monitor, same as the screenshot) and click.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "x": { "type": "integer" },
                        "y": { "type": "integer" },
                        "button": { "type": "string", "enum": ["left", "right"], "description": "Default: left" },
                        "double": { "type": "boolean", "description": "Double-click. Default: false" }
                    },
                    "required": ["x", "y"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "computer_type",
                "description": "Type text into the currently focused window/control (Unicode, as if on a real keyboard).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "text": { "type": "string" }
                    },
                    "required": ["text"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "computer_key",
                "description": "Press a key or combo: \"enter\", \"tab\", \"esc\", \"up\", \"ctrl+s\", \"alt+f4\" …",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "key": { "type": "string" }
                    },
                    "required": ["key"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "computer_scroll",
                "description": "Scroll the mouse wheel; positive amount scrolls down, negative scrolls up.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "amount": { "type": "integer", "description": "Wheel steps (1 step ≈ 3 lines)" }
                    },
                    "required": ["amount"]
                }
            }
        }
    ])
}

// ---------------------------------------------------------------------------
// Исполнение
// ---------------------------------------------------------------------------

pub fn execute_computer_tool(name: &str, arguments: &str) -> Result<String, String> {
    let args: Value = serde_json::from_str(arguments)
        .map_err(|e| format!("invalid arguments JSON: {e}"))?;
    execute(name, &args)
}

fn execute(name: &str, args: &Value) -> Result<String, String> {
    match name {
        "computer_screenshot" => screenshot(),
        "computer_click" => click(args),
        "computer_type" => type_text(args),
        "computer_key" => press_key(args),
        "computer_scroll" => scroll(args),
        other => Err(format!("unknown computer tool: {other}")),
    }
}

/// Скриншот основного монитора → JPEG → data URL
fn screenshot() -> Result<String, String> {
    let monitors = xcap::Monitor::all().map_err(|e| format!("monitor enumeration failed: {e}"))?;
    let monitor = monitors
        .first()
        .ok_or("no monitor found")?;
    let image = monitor
        .capture_image()
        .map_err(|e| format!("screen capture failed: {e}"))?;
    let (w, h) = (image.width(), image.height());

    let rgb = image::DynamicImage::ImageRgba8(image).to_rgb8();
    let mut jpeg: Vec<u8> = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 70);
    encoder
        .encode_image(&rgb)
        .map_err(|e| format!("jpeg encode failed: {e}"))?;

    let b64 = base64::engine::general_purpose::STANDARD.encode(&jpeg);
    Ok(json!({
        "ok": true,
        "width": w,
        "height": h,
        "dataUrl": format!("data:image/jpeg;base64,{b64}")
    })
    .to_string())
}

fn with_enigo<T>(
    f: impl FnOnce(&mut enigo::Enigo) -> Result<T, String>,
) -> Result<T, String> {
    let mut enigo = enigo::Enigo::new(&enigo::Settings::default())
        .map_err(|e| format!("cannot init input control: {e}"))?;
    f(&mut enigo)
}

fn click(args: &Value) -> Result<String, String> {
    let x = arg_int(args, "x")? as i32;
    let y = arg_int(args, "y")? as i32;
    let right = args.get("button").and_then(|b| b.as_str()) == Some("right");
    let double = args.get("double").and_then(|d| d.as_bool()) == Some(true);
    let button = if right {
        enigo::Button::Right
    } else {
        enigo::Button::Left
    };
    with_enigo(|e| {
        use enigo::{Coordinate, Direction, Mouse};
        e.move_mouse(x, y, Coordinate::Abs)
            .map_err(|err| format!("move failed: {err}"))?;
        e.button(button, Direction::Click)
            .map_err(|err| format!("click failed: {err}"))?;
        if double {
            std::thread::sleep(std::time::Duration::from_millis(80));
            e.button(button, Direction::Click)
                .map_err(|err| format!("double click failed: {err}"))?;
        }
        Ok(format!(
            "mouse clicked at ({x},{y}) {}{}",
            if right { "right " } else { "" },
            if double { "double" } else { "single" }
        ))
    })
}

fn type_text(args: &Value) -> Result<String, String> {
    let text = args
        .get("text")
        .and_then(|v| v.as_str())
        .ok_or("missing required argument: text")?;
    with_enigo(|e| {
        use enigo::Keyboard;
        e.text(text).map_err(|err| format!("typing failed: {err}"))?;
        Ok(format!("typed {} characters", text.chars().count()))
    })
}

fn press_key(args: &Value) -> Result<String, String> {
    let combo = args
        .get("key")
        .and_then(|v| v.as_str())
        .ok_or("missing required argument: key")?;
    let parts: Vec<&str> = combo.split('+').map(|p| p.trim()).collect();
    if parts.is_empty() || parts.iter().any(|p| p.is_empty()) {
        return Err(format!("invalid key combo: {combo}"));
    }

    with_enigo(|e| {
        use enigo::{Direction, Keyboard};

        let main = parts[parts.len() - 1];
        let modifiers: Vec<enigo::Key> = parts[..parts.len() - 1]
            .iter()
            .map(|m| match m.to_ascii_lowercase().as_str() {
                "ctrl" | "control" => Ok(enigo::Key::Control),
                "shift" => Ok(enigo::Key::Shift),
                "alt" => Ok(enigo::Key::Alt),
                "win" | "meta" | "cmd" => Ok(enigo::Key::Meta),
                other => Err(format!("unknown modifier: {other}")),
            })
            .collect::<Result<_, _>>()?;

        for m in &modifiers {
            e.key(*m, Direction::Press)
                .map_err(|err| format!("press failed: {err}"))?;
        }
        let result = parse_key(main).and_then(|key| {
            e.key(key, Direction::Click)
                .map_err(|err| format!("press failed: {err}"))
        });
        for m in modifiers.iter().rev() {
            let _ = e.key(*m, Direction::Release);
        }
        result?;
        Ok(format!("pressed {combo}"))
    })
}

fn parse_key(name: &str) -> Result<enigo::Key, String> {
    use enigo::Key;
    let lower = name.to_ascii_lowercase();
    Ok(match lower.as_str() {
        "enter" | "return" => Key::Return,
        "tab" => Key::Tab,
        "esc" | "escape" => Key::Escape,
        "backspace" => Key::Backspace,
        "delete" | "del" => Key::Delete,
        "space" => Key::Space,
        "up" => Key::UpArrow,
        "down" => Key::DownArrow,
        "left" => Key::LeftArrow,
        "right" => Key::RightArrow,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" => Key::PageUp,
        "pagedown" => Key::PageDown,
        "insert" => Key::Insert,
        "capslock" => Key::CapsLock,
        f if f.starts_with('f') && f.len() >= 2 && f[1..].parse::<u8>().is_ok() => {
            let n: u8 = f[1..].parse().unwrap();
            if !(1..=12).contains(&n) {
                return Err(format!("unknown key: {name}"));
            }
            [Key::F1, Key::F2, Key::F3, Key::F4, Key::F5, Key::F6, Key::F7,
             Key::F8, Key::F9, Key::F10, Key::F11, Key::F12][(n - 1) as usize]
        }
        // Одиночный символ: буква, цифра, пунктуация
        c if c.chars().count() == 1 => {
            let ch = c.chars().next().unwrap().to_ascii_uppercase();
            Key::Unicode(ch)
        }
        other => return Err(format!("unknown key: {other}")),
    })
}

fn scroll(args: &Value) -> Result<String, String> {
    let amount = args
        .get("amount")
        .and_then(|v| v.as_i64())
        .ok_or("missing required argument: amount")?;
    let amount = amount.clamp(-50, 50) as i32;
    with_enigo(|e| {
        use enigo::{Axis, Mouse};
        // Положительный amount = прокрутка вниз = колесо "от себя"
        e.scroll(-amount, Axis::Vertical)
            .map_err(|err| format!("scroll failed: {err}"))?;
        Ok(format!("scrolled by {amount} steps"))
    })
}

fn arg_int(args: &Value, key: &str) -> Result<i64, String> {
    args.get(key)
        .and_then(|v| v.as_i64())
        .ok_or(format!("missing required argument: {key}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computer_schemas_valid() {
        let v = computer_tool_schemas();
        let arr = v.as_array().expect("schemas must be an array");
        assert_eq!(arr.len(), 5);
        for schema in arr {
            assert_eq!(schema["type"], "function");
            let name = schema["function"]["name"].as_str().unwrap();
            assert!(name.starts_with("computer_"), "{name}");
        }
    }

    #[test]
    fn key_parsing() {
        assert!(matches!(parse_key("enter"), Ok(enigo::Key::Return)));
        assert!(matches!(parse_key("ESC"), Ok(enigo::Key::Escape)));
        assert!(matches!(parse_key("f12"), Ok(enigo::Key::F12)));
        // Одиночная клавиша; комбинации с модификаторами разбирает press_key
        assert!(matches!(parse_key("a"), Ok(enigo::Key::Unicode(_))));
        assert!(parse_key("nonexistent_key").is_err());
        // Невалидная комбинация отвергается до нажатия клавиш
        assert!(execute_computer_tool("computer_key", r#"{"key":"ctrl+"}"#).is_err());
        assert!(execute_computer_tool("computer_key", r#"{"key":"badmod+s"}"#).is_err());
    }

    #[test]
    fn unknown_tool_rejected() {
        assert!(execute_computer_tool("computer_nuke", "{}").is_err());
    }

    /// Скриншот реального экрана (машина с дисплеем). Возвращает валидный
    /// data URL и физические размеры монитора.
    #[test]
    fn computer_screenshot_e2e() {
        let res = execute_computer_tool("computer_screenshot", "{}").expect("screenshot");
        let parsed: Value = serde_json::from_str(&res).unwrap();
        assert_eq!(parsed["ok"], true);
        let w = parsed["width"].as_u64().unwrap();
        let h = parsed["height"].as_u64().unwrap();
        assert!(w > 0 && h > 0, "monitor size must be positive");
        let url = parsed["dataUrl"].as_str().unwrap();
        assert!(url.starts_with("data:image/jpeg;base64,"));
        // JPEG не пустой: минимум несколько килобайт на реальном экране
        assert!(url.len() > 5_000, "screenshot too small: {} bytes", url.len());
    }
}
