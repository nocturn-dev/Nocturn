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
    /// Источник сессии (AUMID): диагностика «кого слышит минибар»
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
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

    /// Последний известный трек оконного режима: при паузе заголовок окна
    /// становится просто "Spotify" (трек пропадает) — липкий трек позволяет
    /// минибару показывать «⏸ Track — Artist» до возобновления
    #[derive(Clone)]
    struct StickyTrack {
        title: String,
        artist: String,
        position_secs: u64,
        cover: Option<String>,
    }
    static LAST_TRACK: Mutex<Option<StickyTrack>> = Mutex::new(None);
    /// Момент начала текущего трека оконного режима: позицию SMTC не даёт,
    /// тикаем локально от старта
    static TRACK_START: Mutex<Option<(String, std::time::Instant)>> = Mutex::new(None);

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

    /// Целевая сессия: строго десктопный Spotify (AUMID содержит "spotify").
    /// Браузерные сессии (web-плеер, YouTube) исключены: SMTC не отдаёт URL
    /// вкладки, отличить spotify.com от youtube.com невозможно — режим
    /// «Браузерный Spotify» вырезан по решению владельца. Среди кандидатов:
    /// играющий важнее паузированного, дальше — самый свежий таймлайн.
    fn spotify_session(
        manager: &GlobalSystemMediaTransportControlsSessionManager,
    ) -> Option<GlobalSystemMediaTransportControlsSession> {
        let view = manager.GetSessions().ok()?;
        let it = view.First().ok()?;
        let mut best: Option<GlobalSystemMediaTransportControlsSession> = None;
        let mut best_score = -1i64;
        loop {
            let has = it.MoveNext().ok()?;
            if !has {
                break;
            }
            let s = it.Current().ok()?;
            let source = s
                .SourceAppUserModelId()
                .map(|v| v.to_string())
                .unwrap_or_default()
                .to_lowercase();
            if !source.contains("spotify") {
                continue;
            }
            let is_playing = s
                .GetPlaybackInfo()
                .ok()
                .and_then(|p| p.PlaybackStatus().ok())
                .map(|st| st == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing)
                .unwrap_or(false);
            let ft = s
                .GetTimelineProperties()
                .map(|t| {
                    t.LastUpdatedTime()
                        .map(|dt| dt.UniversalTime)
                        .unwrap_or(0)
                })
                .unwrap_or(0);
            // Играющий плеер всегда важнее паузированного (бит 62 не
            // пересекается с таймштампом), дальше — свежесть таймлайна
            let mut score = if is_playing { 1i64 << 62 } else { 0 };
            score += ft / 2;
            if score > best_score {
                best_score = score;
                best = Some(s);
            }
        }
        best
    }

    fn apply_control(
        manager: &GlobalSystemMediaTransportControlsSessionManager,
        msg: &Msg,
    ) {
        // SMTC-сессия Spotify есть → нативное управление; нет (клиент без
        // SMTC) → WM_APPCOMMAND окну Spotify: Play/Pause — слепой тоггл,
        // факт применения придёт следующим опросом
        if let Some(session) = spotify_session(manager) {
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
        return;
        }
        window_control(msg);
    }

    const WM_APPCOMMAND: u32 = 0x0319;
    const APPCOMMAND_MEDIA_PLAY_PAUSE: isize = 14;
    const APPCOMMAND_MEDIA_NEXTTRACK: isize = 11;
    const APPCOMMAND_MEDIA_PREVTRACK: isize = 12;

    /// Управление окном Spotify без SMTC: WM_APPCOMMAND (проверено зондом
    /// --toggle: клиент тогглит воспроизведение и меняет заголовок)
    fn window_control(msg: &Msg) {
        use windows::Win32::Foundation::{LPARAM, WPARAM};
        use windows::Win32::UI::WindowsAndMessaging::PostMessageW;
        let Some(hwnd) = track_window_hwnd() else {
            eprintln!("media: window control ignored, no spotify window");
            return;
        };
        let cmd = match msg {
            Msg::Play | Msg::Pause => APPCOMMAND_MEDIA_PLAY_PAUSE,
            Msg::Next => APPCOMMAND_MEDIA_NEXTTRACK,
            Msg::Prev => APPCOMMAND_MEDIA_PREVTRACK,
        };
        unsafe {
            let _ = PostMessageW(
                Some(windows::Win32::Foundation::HWND(hwnd as *mut _)),
                WM_APPCOMMAND,
                WPARAM(0),
                LPARAM(cmd << 16),
            );
        }
    }

    /// Главное окно с треком: видимое, заголовок содержит " - " и не равен
    /// просто "Spotify" (пауза/свёрнутый клиент)
    /// Главное окно с треком: видимое, заголовок содержит " - " и не равен
    /// просто "Spotify" (пауза/свёрнутый клиент)
    fn track_window_hwnd() -> Option<isize> {
        let pids = spotify_pids();
        spotify_windows(&pids)
            .into_iter()
            .find(|(_hwnd, pid, title)| {
                pids.contains(pid)
                    && title.contains(" - ")
                    && !title.eq_ignore_ascii_case("Spotify")
            })
            .map(|(hwnd, _, _)| hwnd)
    }

    /// PID всех процессов spotify.exe
    fn spotify_pids() -> Vec<u32> {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        };
        let mut out = Vec::new();
        unsafe {
            let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
                return out;
            };
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            if Process32FirstW(snap, &mut entry).is_ok() {
                loop {
                    let len = entry
                        .szExeFile
                        .iter()
                        .position(|c| *c == 0)
                        .unwrap_or(entry.szExeFile.len());
                    let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
                    if name.eq_ignore_ascii_case("spotify.exe") {
                        out.push(entry.th32ProcessID);
                    }
                    if Process32NextW(snap, &mut entry).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snap);
        }
        out
    }

    /// (hwnd, pid, title) видимых окон процессов spotify.exe
    fn spotify_windows(pids: &[u32]) -> Vec<(isize, u32, String)> {
        use windows::core::BOOL;
        use windows::Win32::Foundation::{HWND, LPARAM};
        use windows::Win32::UI::WindowsAndMessaging::{
            EnumWindows, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
        };

        // EnumWindows-колбэк не умеет замыканий — контекст через LPARAM
        // (raw-указатель на Vec), разбираем после обхода
        unsafe extern "system" fn callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
            unsafe {
                if !IsWindowVisible(hwnd).as_bool() {
                    return BOOL(1);
                }
                let mut buf = [0u16; 512];
                let len = GetWindowTextW(hwnd, &mut buf);
                if len == 0 {
                    return BOOL(1);
                }
                let mut pid = 0u32;
                GetWindowThreadProcessId(hwnd, Some(&mut pid));
                let title = String::from_utf16_lossy(&buf[..len as usize]);
                let list = lparam.0 as *mut Vec<(isize, u32, String)>;
                if let Some(list) = list.as_mut() {
                    list.push((hwnd.0 as isize, pid, title));
                }
                BOOL(1)
            }
        }

        let mut collected: Vec<(isize, u32, String)> = Vec::new();
        unsafe {
            let ptr = &mut collected as *mut Vec<(isize, u32, String)>;
            let _ = EnumWindows(Some(callback), LPARAM(ptr as isize));
        }
        collected
            .into_iter()
            .filter(|(_hwnd, pid, _)| pids.contains(pid))
            .collect()
    }

    fn poll(manager: &GlobalSystemMediaTransportControlsSessionManager) -> Result<(), String> {
        // SMTC-сессия Spotify есть → нативные метаданные; нет → оконный
        // fallback (заголовок окна несёт «Artist — Track»)
        let dto_opt = match spotify_session(manager) {
            Some(session) => Some(smtc_dto(&session)?),
            None => window_dto()?,
        };

        let prev = STATE.lock().map_err(|e| e.to_string())?.clone();
        let significant = match (&prev, &dto_opt) {
            (None, None) => false,
            (None, Some(_)) | (Some(_), None) => true,
            (Some(p), Some(d)) => {
                p.dto.track_id != d.track_id
                    || p.dto.playing != d.playing
                    || p.dto.position_secs.abs_diff(d.position_secs) > 3
            }
        };
        *STATE.lock().map_err(|e| e.to_string())? =
            dto_opt.map(|dto| MediaSnapshot { dto });
        if significant {
            emit_state_change(true);
        }
        Ok(())
    }

    fn smtc_dto(
        session: &GlobalSystemMediaTransportControlsSession,
    ) -> Result<MediaStateDto, String> {
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
        let source_app = session
            .SourceAppUserModelId()
            .map(|v| v.to_string())
            .unwrap_or_default();

        // Обложка — только при смене трека (десятки КБ base64)
        let prev = STATE.lock().map_err(|e| e.to_string())?.clone();
        let track_changed =
            prev.as_ref().map(|p| p.dto.track_id.clone()).as_deref() != Some(&track_id);
        let cover = if track_changed {
            fetch_cover(&props).unwrap_or(None)
        } else {
            prev.as_ref().and_then(|p| p.dto.cover.clone())
        };

        Ok(MediaStateDto {
            title: if title.is_empty() { None } else { Some(title) },
            artist: if artist.is_empty() { None } else { Some(artist) },
            playing,
            position_secs,
            updated_at_ms,
            track_id,
            cover,
            source: if source_app.is_empty() {
                None
            } else {
                Some(source_app)
            },
        })
    }

    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    /// «Artist — Track — Album» → (artist, track); меньше двух сегментов — None
    fn parse_window_title(title: &str) -> Option<(String, String)> {
        let parts: Vec<&str> = title.splitn(3, " - ").collect();
        if parts.len() >= 2 && !parts[0].trim().is_empty() && !parts[1].trim().is_empty() {
            Some((parts[0].trim().to_string(), parts[1].trim().to_string()))
        } else {
            None
        }
    }

    /// Оконный fallback Desktop-режима: заголовок окна spotify.exe.
    /// playing — трек в заголовке; пауза = заголовок "Spotify" → липкий
    /// трек (⏸). Позицию ОС не отдаёт — тикаем локально от старта трека.
    /// Обложки в этом пути нет (SMTC-поток недоступен).
    fn window_dto() -> Result<Option<MediaStateDto>, String> {
        let pids = spotify_pids();
        if pids.is_empty() {
            // Клиент закрыт — липкий трек сбрасываем, минибар скрыт
            *LAST_TRACK.lock().map_err(|e| e.to_string())? = None;
            *TRACK_START.lock().map_err(|e| e.to_string())? = None;
            return Ok(None);
        }
        let track_window = spotify_windows(&pids).into_iter().find(|(_hwnd, pid, title)| {
            pids.contains(pid)
                && title.contains(" - ")
                && !title.eq_ignore_ascii_case("Spotify")
        });
        let now = now_ms();
        let Some((_, _pid, window_title)) = track_window else {
            // Пауза: заголовок "Spotify" → липкий трек со статусом ⏸
            let sticky = LAST_TRACK.lock().ok().and_then(|g| g.clone());
            return Ok(sticky.map(|st| MediaStateDto {
                title: Some(st.title.clone()),
                artist: if st.artist.is_empty() {
                    None
                } else {
                    Some(st.artist.clone())
                },
                playing: false,
                position_secs: st.position_secs,
                updated_at_ms: now,
                track_id: track_hash(&st.title, &st.artist),
                cover: st.cover.clone(),
                source: Some("Spotify (window)".into()),
            }));
        };
        let Some((artist, title)) = parse_window_title(&window_title) else {
            return Ok(None);
        };
        let track_id = track_hash(&title, &artist);
        // Позиция: локальный тик от старта трека (см. комментарий выше)
        let mut start = TRACK_START.lock().map_err(|e| e.to_string())?;
        let position_secs = match start.as_ref() {
            Some((id, at)) if id == &track_id => at.elapsed().as_secs(),
            _ => {
                *start = Some((track_id.clone(), std::time::Instant::now()));
                0
            }
        };
        *LAST_TRACK.lock().map_err(|e| e.to_string())? = Some(StickyTrack {
            title: title.clone(),
            artist: artist.clone(),
            position_secs,
            cover: None,
        });
        Ok(Some(MediaStateDto {
            title: Some(title),
            artist: Some(artist),
            playing: true,
            position_secs,
            updated_at_ms: now,
            track_id,
            cover: None,
            source: Some("Spotify (window)".into()),
        }))
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
