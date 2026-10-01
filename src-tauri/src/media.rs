//! Системный медиа-минибар: состояние и управление плеером через системные
//! медиа-контролы ОС (Windows SMTC — те же кнопки ▶⏸ на клавиатуре) + текст
//! песни через lrclib.net.
//!
//! Local-first по построению: состояние и управление — чистая ОС, никаких
//! аккаунтов/токенов/облака Spotify. Единственная сеть — lrclib.net за
//! лирикой, и только по явному вызову с фронта (там свой тумблер).
//!
//! Потоковая модель: один наблюдатель-поток владеет ВСЕМИ WinRT-объектами
//! (они не Send), команды приходят через mpsc-канал, снапшот состояния —
//! Mutex для команды media_status. Опрос раз в секунду вместо подписок
//! на WinRT-события: делегаты-колбэки в windows-crate тянут за собой
//! хрупкие времена жизни, а опрос дешёв и не протекает.

use serde::Serialize;

/// Снимок состояния плеера для фронта. positionSecs + updatedAtMs:
/// фронт интерполирует время локальным тиком, бекенд не спамит IPC.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaStateDto {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub playing: bool,
    pub position_secs: u64,
    pub updated_at_ms: u64,
    /// Хеш (title|artist): дедуп событий и ключ лирики на фронте
    pub track_id: String,
    /// data:image/...;base64 — только при смене трека (тяжёлый payload)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsDto {
    pub plain: Option<String>,
    pub synced: Option<String>,
    pub found: bool,
}

/// Снимок для команды: на Windows — из наблюдателя, на остальных — None.
#[tauri::command(async)]
pub async fn media_status(app: tauri::AppHandle) -> Result<Option<MediaStateDto>, String> {
    #[cfg(windows)]
    {
        windows_impl::ensure_started(&app);
        Ok(windows_impl::snapshot())
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Ok(None)
    }
}

/// play | pause | next | prev. Управление уходит в наблюдатель-поток;
/// неудача применения видна фронту как неизменившийся статус (следующий
/// опрос пришлёт факт) — ошибки наблюдателя печатаются в stderr.
#[tauri::command(async)]
pub async fn media_control(app: tauri::AppHandle, action: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        windows_impl::ensure_started(&app);
        windows_impl::send_control(&action)
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("media integration is available on Windows only".into())
    }
}

/// Текст песни с lrclib.net: synced (LRC с таймкодами) или plain.
/// Кроссплатформенно (это чистый HTTP); кеш в памяти по ключу трека.
#[tauri::command(async)]
pub async fn lyrics_fetch(
    artist: String,
    title: String,
    duration_secs: Option<u64>,
) -> Result<LyricsDto, String> {
    lyrics::fetch(artist, title, duration_secs).await
}

// ---------------------------------------------------------------------------
// Windows: SMTC-наблюдатель
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod windows_impl {
    use super::MediaStateDto;
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use std::sync::mpsc;
    use std::sync::{Mutex, Once, OnceLock};
    use std::time::Duration;

    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession,
        GlobalSystemMediaTransportControlsSessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus,
    };
    use windows::Storage::Streams::DataReader;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

    #[derive(Clone)]
    pub struct MediaSnapshot {
        pub dto: MediaStateDto,
    }

    #[derive(Debug)]
    enum Msg {
        Play,
        Pause,
        Next,
        Prev,
    }

    static STATE: Mutex<Option<MediaSnapshot>> = Mutex::new(None);
    static TX: OnceLock<mpsc::Sender<Msg>> = OnceLock::new();
    static START: Once = Once::new();
    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

    /// Ленивый старт наблюдателя: первый media_status/media_control.
    /// AppHandle нужен, чтобы эмитить события только в main (канал приватный
    /// — урок colibri: broadcast доставлял логи и в quickentry).
    pub fn ensure_started(app: &tauri::AppHandle) {
        let _ = APP.set(app.clone());
        START.call_once(|| {
            std::thread::spawn(|| {
                unsafe {
                    // WinRT требует инициализированную квартиру: MTA —
                    // асинхронные операции не привязаны к окнам
                    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                }
                run_observer();
            });
        });
    }

    pub fn snapshot() -> Option<MediaStateDto> {
        STATE
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|s| s.dto.clone()))
    }

    pub fn send_control(action: &str) -> Result<(), String> {
        let tx = TX.get().ok_or("media observer is not running")?;
        let msg = match action {
            "play" => Msg::Play,
            "pause" => Msg::Pause,
            "next" => Msg::Next,
            "prev" => Msg::Prev,
            other => return Err(format!("unknown media action: {other}")),
        };
        tx.send(msg)
            .map_err(|e| format!("media observer is gone: {e}"))
    }

    fn track_hash(title: &str, artist: &str) -> String {
        let mut h = DefaultHasher::new();
        title.hash(&mut h);
        artist.hash(&mut h);
        format!("{:016x}", h.finish())
    }

    fn run_observer() {
        // Менеджер один на систему; RequestAsync -> .get() блокирует поток
        // наблюдателя — нарочно, он больше ничего не делает
        let manager =
            match GlobalSystemMediaTransportControlsSessionManager::RequestAsync() {
                Ok(op) => match op.get() {
                    Ok(m) => m,
                    Err(e) => {
                        eprintln!("media: SMTC request failed: {e}");
                        return;
                    }
                },
                Err(e) => {
                    eprintln!("media: SMTC unavailable: {e}");
                    return;
                }
            };

        let (tx, rx) = mpsc::channel::<Msg>();
        let _ = TX.set(tx);

        loop {
            // Канал управления заодно задаёт темп опроса (1 Гц)
            match rx.recv_timeout(Duration::from_secs(1)) {
                Ok(msg) => apply_control(&manager, &msg),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
            if let Err(e) = poll(&manager) {
                eprintln!("media: poll failed: {e}");
            }
        }
    }

    /// Целевая сессия: предпочитаем Spotify (source AUMID содержит
    /// "spotify"), иначе играющую, иначе первую попавшуюся
    fn target_session(
        manager: &GlobalSystemMediaTransportControlsSessionManager,
    ) -> Option<GlobalSystemMediaTransportControlsSession> {
        let view = manager.GetSessions().ok()?;
        let it = view.First().ok()?;
        let mut fallback: Option<GlobalSystemMediaTransportControlsSession> = None;
        let mut playing: Option<GlobalSystemMediaTransportControlsSession> = None;
        let mut spotify: Option<GlobalSystemMediaTransportControlsSession> = None;
        loop {
            let has = it.MoveNext().ok()?;
            if !has {
                break;
            }
            let s = it.Current().ok()?;
            let source = s
                .SourceAppUserModelId()
                .map(|v| v.to_string())
                .unwrap_or_default();
            let is_spotify = source.to_lowercase().contains("spotify");
            let is_playing = s
                .GetPlaybackInfo()
                .ok()
                .map(|p| {
                    p.PlaybackStatus().ok()
                        == Some(
                            GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing,
                        )
                })
                .unwrap_or(false);
            if is_spotify && spotify.is_none() {
                spotify = Some(s.clone());
            }
            if is_playing && playing.is_none() {
                playing = Some(s.clone());
            }
            if fallback.is_none() {
                fallback = Some(s);
            }
        }
        spotify.or(playing).or(fallback)
    }

    fn apply_control(
        manager: &GlobalSystemMediaTransportControlsSessionManager,
        msg: &Msg,
    ) {
        let Some(session) = target_session(manager) else {
            eprintln!("media: control ignored, no session");
            return;
        };
        let op = match msg {
            Msg::Play => session.TryPlayAsync(),
            Msg::Pause => session.TryPauseAsync(),
            Msg::Next => session.TrySkipNextAsync(),
            Msg::Prev => session.TrySkipPreviousAsync(),
        };
        // Блокирующее .get() на потоке наблюдателя (не на tokio-воркере);
        // результат bool: false = плеер отказал — статус придёт опросом
        match op {
            Ok(op) => {
                if let Ok(false) = op.get() {
                    eprintln!("media: player rejected control: {msg:?}");
                }
            }
            Err(e) => eprintln!("media: control failed: {e}"),
        }
    }

    fn poll(manager: &GlobalSystemMediaTransportControlsSessionManager) -> Result<(), String> {
        let Some(session) = target_session(manager) else {
            // Плеер закрыт: очищаем состояние и говорим фронту
            let changed = {
                let mut guard = STATE.lock().map_err(|e| e.to_string())?;
                guard.take().is_some()
            };
            if changed {
                emit_state_change(false);
            }
            return Ok(());
        };
        let props = session
            .TryGetMediaPropertiesAsync()
            .map_err(|e| e.to_string())?
            .get()
            .map_err(|e| e.to_string())?;
        let title = props.Title().map(|v| v.to_string()).unwrap_or_default();
        let artist = props.Artist().map(|v| v.to_string()).unwrap_or_default();
        let playing = session
            .GetPlaybackInfo()
            .ok()
            .and_then(|p| p.PlaybackStatus().ok())
            .map(|s| s == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing)
            .unwrap_or(false);
        let timeline = session.GetTimelineProperties().map_err(|e| e.to_string())?;
        // TimeSpan — 100ns-тики; LastUpdatedTime — 1601-файловое время:
        // фронт интерполирует elapsed от (position, unix-ms метки)
        let position_secs = timeline
            .Position()
            .map(|ts| (ts.Duration / 10_000_000).max(0) as u64)
            .unwrap_or(0);
        let updated_at_ms = timeline
            .LastUpdatedTime()
            .map(|dt| {
                const EPOCH_DIFF_MS: i64 = 11_644_473_600_000;
                ((dt.UniversalTime / 10_000) - EPOCH_DIFF_MS).max(0) as u64
            })
            .unwrap_or(0);
        let track_id = track_hash(&title, &artist);

        // Обложка — только при смене трека (десятки КБ base64)
        let prev = STATE.lock().map_err(|e| e.to_string())?.clone();
        let track_changed =
            prev.as_ref().map(|p| p.dto.track_id.clone()).as_deref() != Some(&track_id);
        let cover = if track_changed {
            fetch_cover(&props).unwrap_or(None)
        } else {
            prev.as_ref().and_then(|p| p.dto.cover.clone())
        };

        let dto = MediaStateDto {
            title: if title.is_empty() { None } else { Some(title) },
            artist: if artist.is_empty() { None } else { Some(artist) },
            playing,
            position_secs,
            updated_at_ms,
            track_id: track_id.clone(),
            cover,
        };

        // Событие — только на значимые изменения: трек, пауза, seek (>3с).
        // Позиция при обычном воспроизведении меняется каждый тик — не спамим
        let significant = match &prev {
            None => true,
            Some(p) => {
                p.dto.track_id != track_id
                    || p.dto.playing != playing
                    || p.dto.position_secs.abs_diff(position_secs) > 3
            }
        };
        *STATE.lock().map_err(|e| e.to_string())? = Some(MediaSnapshot { dto });
        if significant {
            emit_state_change(true);
        }
        Ok(())
    }

    /// Обложка: RandomAccessStream → байты → base64 data URL. Неудача —
    /// просто без обложки (некритичный путь)
    fn fetch_cover(
        props: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties,
    ) -> Result<Option<String>, String> {
        let reference = props.Thumbnail().map_err(|e| e.to_string())?;
        let stream = reference
            .OpenReadAsync()
            .map_err(|e| e.to_string())?
            .get()
            .map_err(|e| e.to_string())?;
        let size = stream.Size().map_err(|e| e.to_string())?;
        if size == 0 || size > 2 * 1024 * 1024 {
            return Ok(None);
        }
        let mime = stream.ContentType().map_err(|e| e.to_string())?;
        let input = stream.GetInputStreamAt(0).map_err(|e| e.to_string())?;
        let reader = DataReader::CreateDataReader(&input).map_err(|e| e.to_string())?;
        reader
            .LoadAsync(size as u32)
            .map_err(|e| e.to_string())?
            .get()
            .map_err(|e| e.to_string())?;
        let mut bytes = vec![0u8; size as usize];
        reader.ReadBytes(&mut bytes).map_err(|e| e.to_string())?;
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let mime = mime.to_string();
        let mime = if mime.is_empty() {
            "image/png".to_string()
        } else {
            mime
        };
        Ok(Some(format!("data:{mime};base64,{b64}")))
    }

    fn emit_state_change(has_track: bool) {
        if let Some(app) = APP.get() {
            use tauri::Emitter;
            let _ = app.emit_to(
                "main",
                "media-state",
                serde_json::json!({ "hasTrack": has_track }),
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Лирика: lrclib.net (бесплатный открытый API, без ключа). Сеть — только
// по явному вызову с фронта (там отдельный тумблер, выключен по умолчанию).
// ---------------------------------------------------------------------------

mod lyrics {
    use super::LyricsDto;
    use std::collections::HashMap;
    use std::sync::Mutex;
    use std::time::Duration;

    static CACHE: Mutex<Option<HashMap<String, LyricsDto>>> = Mutex::new(None);

    fn cache_key(artist: &str, title: &str, duration: Option<u64>) -> String {
        format!(
            "{}|{}|{}",
            artist.to_lowercase(),
            title.to_lowercase(),
            duration.unwrap_or(0)
        )
    }

    pub async fn fetch(
        artist: String,
        title: String,
        duration_secs: Option<u64>,
    ) -> Result<LyricsDto, String> {
        let key = cache_key(&artist, &title, duration_secs);
        if let Some(hit) = CACHE
            .lock()
            .ok()
            .and_then(|c| c.as_ref().and_then(|m| m.get(&key)).cloned())
        {
            return Ok(hit);
        }
        let client = crate::network::shared_client(Duration::from_secs(15))?;
        let resp = client
            .get("https://lrclib.net/api/search")
            .query(&[("artist_name", &artist), ("track_name", &title)])
            .header("User-Agent", "Nocturn/0.2 (local media minibar)")
            .send()
            .await
            .map_err(|e| format!("lrclib request failed: {e}"))?;
        let items: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

        // Выбор лучшего: при известной длительности — совпадение ±2с,
        // иначе ближайший; сначала с синхронизированным текстом
        let empty = Vec::new();
        let arr = items.as_array().unwrap_or(&empty);
        let pick = |synced_wanted: bool| -> Option<serde_json::Value> {
            arr.iter()
                .filter(|it| {
                    let field = if synced_wanted {
                        "syncedLyrics"
                    } else {
                        "plainLyrics"
                    };
                    it.get(field)
                        .and_then(|v| v.as_str())
                        .is_some_and(|s| !s.is_empty())
                })
                .min_by_key(|it| {
                    let d = it.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    (d - duration_secs.unwrap_or(0) as f64).abs() as i64
                })
                .cloned()
        };
        let synced =
            pick(true).and_then(|it| it.get("syncedLyrics").and_then(|v| v.as_str()).map(String::from));
        let plain =
            pick(false).and_then(|it| it.get("plainLyrics").and_then(|v| v.as_str()).map(String::from));
        let dto = LyricsDto {
            plain,
            synced,
            found: true,
        };
        {
            let mut guard = CACHE.lock().map_err(|e| e.to_string())?;
            let map = guard.get_or_insert_with(HashMap::new);
            if map.len() > 100 {
                map.clear();
            }
            map.insert(key, dto.clone());
        }
        Ok(dto)
    }
}
