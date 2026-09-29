//! Voice Wake («Jarvis-режим»): локальный детектор активационной фразы.
//! Инференс — в вебвью (openWakeWord ONNX через onnxruntime-web, WASM,
//! полностью офлайн), Rust отвечает только за скачивание моделей в
//! app_data/voice и выдачу их байтов фронту. Паттерн — dictation.rs:
//! стрим в temp + rename, прогресс событием, один активный скачивающий.

use base64::Engine;
use serde::Serialize;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;

const MODEL_BASE: &str =
    "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1";
/// Фичевые модели (общие для всех фраз) + wake-модели по ключу выбора.
/// Размеры ~1 МБ каждая: весь набор — единицы мегабайт, не whisper-овские 57
const FEATURE_FILES: &[&str] = &["melspectrogram.onnx", "embedding_model.onnx"];
const WAKE_FILES: &[(&str, &str)] = &[
    ("hey_jarvis", "hey_jarvis_v0.1.onnx"),
    ("hey_mycroft", "hey_mycroft_v0.1.onnx"),
];

static DOWNLOADING: AtomicBool = AtomicBool::new(false);

fn wake_file(wake_model: &str) -> Option<&'static str> {
    WAKE_FILES
        .iter()
        .find(|(key, _)| *key == wake_model)
        .map(|(_, file)| *file)
}

/// Белый список имён для voice_read_model: вебвью запрашивает файл по имени,
/// путь строится только из констант — traversal исключён по построению
fn is_known_model_file(name: &str) -> bool {
    FEATURE_FILES.contains(&name)
        || WAKE_FILES.iter().any(|(_, file)| *file == name)
}

fn voice_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("voice"))
}

#[derive(Serialize)]
pub struct VoiceFileStatus {
    pub name: String,
    pub exists: bool,
    pub bytes: u64,
}

#[derive(Serialize)]
pub struct VoiceStatus {
    pub files: Vec<VoiceFileStatus>,
    pub downloading: bool,
}

/// Статус моделей: какие файлы уже на диске. wake_model — выбранный на
/// фронте ключ («hey_jarvis»), его файл проверяется вместе с фичевыми
#[tauri::command(async)]
pub fn voice_status(app: tauri::AppHandle, wake_model: String) -> Result<VoiceStatus, String> {
    let dir = voice_dir(&app)?;
    let mut names: Vec<&str> = FEATURE_FILES.to_vec();
    if let Some(w) = wake_file(&wake_model) {
        names.push(w);
    }
    let files = names
        .iter()
        .map(|name| {
            let (exists, bytes) = std::fs::metadata(dir.join(name))
                .map(|m| (true, m.len()))
                .unwrap_or((false, 0));
            VoiceFileStatus {
                name: (*name).to_string(),
                exists,
                bytes,
            }
        })
        .collect();
    Ok(VoiceStatus {
        files,
        downloading: DOWNLOADING.load(Ordering::Relaxed),
    })
}

/// Скачать недостающие модели (фичевые + выбранная wake): стрим в temp +
/// rename, прогресс — событием voice-progress {file, received, total}
#[tauri::command(async)]
pub async fn voice_download_models(
    app: tauri::AppHandle,
    wake_model: String,
) -> Result<(), String> {
    if wake_file(&wake_model).is_none() {
        return Err(format!("unknown wake model: {wake_model}"));
    }
    if DOWNLOADING.swap(true, Ordering::Relaxed) {
        return Err("model download already in progress".into());
    }
    let result = do_download(&app, &wake_model).await;
    DOWNLOADING.store(false, Ordering::Relaxed);
    result
}

async fn do_download(app: &tauri::AppHandle, wake_model: &str) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let dir = voice_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut names: Vec<&str> = FEATURE_FILES.to_vec();
    if let Some(w) = wake_file(wake_model) {
        names.push(w);
    }
    let client = crate::network::shared_client(std::time::Duration::from_secs(30))?;
    for name in names {
        let final_path = dir.join(name);
        if final_path.exists() {
            continue; // уже скачана — повторное включение безвредно
        }
        let url = format!("{MODEL_BASE}/{name}");
        let resp = client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("model download failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("model download {name}: HTTP {}", resp.status().as_u16()));
        }
        let total = resp.content_length().unwrap_or(0);
        let tmp = dir.join(format!("{name}.tmp"));
        let mut file = tokio::fs::File::create(&tmp)
            .await
            .map_err(|e| e.to_string())?;
        let mut received: u64 = 0;
        let mut last_emit: u64 = 0;
        let mut stream = resp;
        while let Some(chunk) = stream
            .chunk()
            .await
            .map_err(|e| format!("model download interrupted: {e}"))?
        {
            file.write_all(&chunk).await.map_err(|e| e.to_string())?;
            received += chunk.len() as u64;
            // Файлы ~1 МБ: прогресс шлём дважды — начало и конец
            if received - last_emit >= 512 * 1024 {
                last_emit = received;
                let _ = app.emit(
                    "voice-progress",
                    json!({ "file": name, "received": received, "total": total }),
                );
            }
        }
        file.flush().await.map_err(|e| e.to_string())?;
        drop(file);
        if received == 0 {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("model download {name}: empty response"));
        }
        std::fs::rename(&tmp, &final_path).map_err(|e| e.to_string())?;
        let _ = app.emit(
            "voice-progress",
            json!({ "file": name, "received": received, "total": received }),
        );
    }
    Ok(())
}

/// Байты модели для вебвью (base64): ort-web создаёт сессию из ArrayBuffer.
/// Имя строго из белого списка — путь конструируется только из констант.
/// ~1 МБ на файл через IPC один раз при старте слушателя — приемлемо
#[tauri::command(async)]
pub fn voice_read_model(app: tauri::AppHandle, name: String) -> Result<String, String> {
    if !is_known_model_file(&name) {
        return Err(format!("unknown model file: {name}"));
    }
    let dir = voice_dir(&app)?;
    let data = std::fs::read(dir.join(&name))
        .map_err(|e| format!("model file {name} is not downloaded yet: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(data))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Регресс: voice_read_model — единственная команда, принимающая имя
    /// файла от вебвью; белый список обязан отсекать пути
    #[test]
    fn model_file_whitelist_rejects_traversal() {
        assert!(is_known_model_file("melspectrogram.onnx"));
        assert!(is_known_model_file("embedding_model.onnx"));
        assert!(is_known_model_file("hey_jarvis_v0.1.onnx"));
        assert!(is_known_model_file("hey_mycroft_v0.1.onnx"));
        assert!(!is_known_model_file("../settings.json"));
        assert!(!is_known_model_file("settings.json"));
        assert!(!is_known_model_file("c:\\windows\\system32\\cmd.exe"));
        assert!(!is_known_model_file(""));
        assert!(!is_known_model_file("melspectrogram.onnx.tmp"));
    }

    #[test]
    fn wake_model_keys_resolve_to_files() {
        assert_eq!(wake_file("hey_jarvis"), Some("hey_jarvis_v0.1.onnx"));
        assert_eq!(wake_file("hey_mycroft"), Some("hey_mycroft_v0.1.onnx"));
        assert_eq!(wake_file("alexa"), None);
    }
}
