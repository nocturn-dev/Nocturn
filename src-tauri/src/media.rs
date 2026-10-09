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
    /// Длительность трека из таймлайна (End). Нет (поток/фолбэк) — None:
    /// лирика тогда выбирается без сверки длительности
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_secs: Option<u64>,
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
#[cfg_attr(not(windows), allow(unused_variables))]
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
    use windows::Win32::UI::Accessibility::IUIAutomationRangeValuePattern;

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
        // наблюдателя — нарочно, он больше ничего не делает.
        // SMTC-сервис может быть не готов к моменту старта приложения:
        // одноразовый отказ раньше убивал наблюдателя до рестарта процесса —
        // ограниченный ретрарай на СВОЁМ потоке (минута), не в цикле опроса
        let manager = {
            let mut found = None;
            for attempt in 0..12 {
                match GlobalSystemMediaTransportControlsSessionManager::RequestAsync() {
                    Ok(op) => match op.get() {
                        Ok(m) => {
                            found = Some(m);
                            break;
                        }
                        Err(e) => {
                            eprintln!("media: SMTC request failed (attempt {}): {e}", attempt + 1);
                        }
                    },
                    Err(e) => {
                        eprintln!("media: SMTC unavailable (attempt {}): {e}", attempt + 1);
                    }
                }
                std::thread::sleep(std::time::Duration::from_secs(5));
            }
            match found {
                Some(m) => m,
                None => {
                    eprintln!("media: SMTC unavailable after retries — minubar disabled until restart");
                    return;
                }
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
    /// --toggle: клиент тогглит воспроизведение и меняет заголовок).
    /// На паузе трек-окна нет (заголовок просто "Spotify") — раньше Play
    /// молча игнорировался и song нельзя было возобновить из минибара;
    /// теперь в этом случае команда уходит в любое видимое окно клиента
    fn window_control(msg: &Msg) {
        use windows::Win32::Foundation::{LPARAM, WPARAM};
        use windows::Win32::UI::WindowsAndMessaging::PostMessageW;
        let pids = spotify_pids();
        let hwnd = track_window_hwnd().or_else(|| {
            spotify_windows(&pids)
                .into_iter()
                .find(|(_hwnd, _pid, title)| !title.is_empty())
                .map(|(hwnd, _, _)| hwnd)
        });
        let Some(hwnd) = hwnd else {
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
        // End таймлайна: длительность трека для выбора записи лирики.
        // 0 — радио/поток/неизвестно → None
        let duration_secs = timeline
            .EndTime()
            .map(|ts| (ts.Duration / 10_000_000).max(0) as u64)
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
            duration_secs: if duration_secs > 0 {
                Some(duration_secs)
            } else {
                None
            },
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
        let Some((track_hwnd, _pid, window_title)) = track_window else {
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
                duration_secs: None,
                cover: st.cover.clone(),
                source: Some("Spotify (window)".into()),
            }));
        };
        let Some((artist, title)) = parse_window_title(&window_title) else {
            return Ok(None);
        };
        let track_id = track_hash(&title, &artist);
        // Позиция/длительность: UI Spotify через UIA (см. uia_playback) —
        // заголовок окна позицию не даёт, а трек, стартовавший до
        // обнаружения фолбэком (запуск приложения mid-track, потеря SMTC
        // до смены трека), вечно отставал: локальный тик шёл от момента
        // обнаружения. UIA недоступен — прежняя логика (тик + seed)
        let (position_secs, duration_secs) = match uia_lookup(&track_id, track_hwnd) {
            Some((pos, dur)) => {
                // Держим TRACK_START в согласии с UIA — при отказе UIA
                // локальный тик продолжится с фактического места
                if let Ok(mut start) = TRACK_START.lock() {
                    if let Some(at) = std::time::Instant::now().checked_sub(Duration::from_secs(pos)) {
                        *start = Some((track_id.clone(), at));
                    }
                }
                (pos, if dur > 0 { Some(dur) } else { None })
            }
            None => {
                let position_secs = {
                    let mut start = TRACK_START.lock().map_err(|e| e.to_string())?;
                    match start.as_ref() {
                        Some((id, at)) if id == &track_id => at.elapsed().as_secs(),
                        _ => {
                            // Переход SMTC→window посреди трека: продолжаем позицию с
                            // последнего SMTC-снимка (позиция + время с LastUpdatedTime
                            // — та же компенсация, что у фронта), иначе elapsed
                            // сбрасывался в 0 и лирика отставала на всё время,
                            // проигранное до переключения. Seed только если SMTC играл
                            // (заголовок окна = играющий трек) и трек совпадает; при
                            // паузе в SMTC позиция неизвестно как устарела — с нуля
                            let seed_ms =
                                STATE.lock().ok().and_then(|g| g.clone()).and_then(|p| {
                                    let d = p.dto;
                                    if d.track_id != track_id || !d.playing {
                                        return None;
                                    }
                                    let drift = now_ms().saturating_sub(d.updated_at_ms);
                                    Some(d.position_secs.saturating_mul(1000).saturating_add(drift))
                                });
                            match seed_ms.and_then(|ms| {
                                std::time::Instant::now().checked_sub(Duration::from_millis(ms))
                            }) {
                                Some(at) => {
                                    *start = Some((track_id.clone(), at));
                                    at.elapsed().as_secs()
                                }
                                None => {
                                    *start = Some((track_id.clone(), std::time::Instant::now()));
                                    0
                                }
                            }
                        }
                    }
                };
                (position_secs, None)
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
            duration_secs,
            cover: None,
            source: Some("Spotify (window)".into()),
        }))
    }

    /// Строка «мм:сс» / «ч:мм:сс» (с минусом = остаток) → секунды
    fn parse_time_label(s: &str) -> Option<(u64, bool)> {
        let t = s.trim();
        let negative = t.starts_with('-');
        let t = t.strip_prefix('-').unwrap_or(t);
        let parts: Vec<&str> = t.split(':').collect();
        let (h, m, sec) = match parts.as_slice() {
            [mm, ss] if !mm.is_empty() && mm.len() <= 2 => (0u64, *mm, *ss),
            [hh, mm, ss] if !hh.is_empty() => (hh.parse::<u64>().unwrap_or(0), *mm, *ss),
            _ => return None,
        };
        if m.is_empty() || m.len() > 2 || sec.len() != 2 {
            return None;
        }
        let secs = h * 3600 + m.parse::<u64>().ok()? * 60 + sec.parse::<u64>().ok()?;
        Some((secs, negative))
    }

    /// Слайдер прогресса, найденный полным сканом. Значение перечитывается
    /// дёшево (один COM-вызов) каждый опрос — перемотка видна в пределах
    /// секунды; полный скан (~200мс) — на смене трека, протухе слайдера
    /// и раз в 30с на перекалибровку
    struct UiaSlider {
        track_id: String,
        pattern: IUIAutomationRangeValuePattern,
        /// Делитель значения слайдера: 1000 (мс) или 1 (сек) — калибруется
        /// по метке времени при полном скане
        factor: f64,
        dur: u64,
        scanned: std::time::Instant,
    }

    /// Полный UIA-скан окна: в дереве плеера метки времени стоят впритык
    /// к слайдеру прогресса (elapsed — до, длительность — после). Дерево
    /// Chromium строится лениво — первые сканы почти пусты, это не ошибка.
    /// Возвращает позицию, длительность, слайдер прогресса и его единицы
    fn uia_full_scan(
        hwnd: isize,
    ) -> Option<(u64, u64, IUIAutomationRangeValuePattern, f64)> {
        use windows::core::Interface;
        use windows::Win32::Foundation::HWND;
        use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
        use windows::Win32::UI::Accessibility::{
            CUIAutomation, IUIAutomation, IUIAutomationRangeValuePattern, TreeScope_Subtree,
            UIA_ControlTypePropertyId, UIA_NamePropertyId, UIA_RangeValuePatternId,
            UIA_SliderControlTypeId,
        };
        enum Item {
            Time(u64, bool),
            Slider {
                value: f64,
                max: f64,
                pattern: IUIAutomationRangeValuePattern,
            },
        }
        unsafe {
            let uia: IUIAutomation =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
            let root = uia.ElementFromHandle(HWND(hwnd as *mut _)).ok()?;
            // TrueCondition + кэш Name/ControlType: VARIANT-условия в
            // windows 0.61 неудобны, фильтр по типам — в расте по кэшу
            let cond = uia.CreateTrueCondition().ok()?;
            let cache = uia.CreateCacheRequest().ok()?;
            cache.AddProperty(UIA_NamePropertyId).ok()?;
            cache.AddProperty(UIA_ControlTypePropertyId).ok()?;
            let arr = root.FindAllBuildCache(TreeScope_Subtree, &cond, &cache).ok()?;
            let len = arr.Length().ok()?;
            // Потолок на размер дерева: аномалия лучше многосекундного
            // скана в потоке-наблюдателе
            if len <= 0 || len > 5000 {
                return None;
            }
            let mut items: Vec<(i32, Item)> = Vec::new();
            for i in 0..len {
                let el = arr.GetElement(i).ok()?;
                let ct = el.CachedControlType().map(|t| t.0).unwrap_or(0);
                if ct == UIA_SliderControlTypeId.0 {
                    let pattern = el
                        .GetCurrentPattern(UIA_RangeValuePatternId)
                        .ok()?
                        .cast::<IUIAutomationRangeValuePattern>()
                        .ok()?;
                    let value = pattern.CurrentValue().ok()?;
                    let max = pattern.CurrentMaximum().ok()?;
                    items.push((i, Item::Slider { value, max, pattern }));
                } else if let Ok(name) = el.CachedName() {
                    if let Some((secs, neg)) = parse_time_label(&name.to_string()) {
                        items.push((i, Item::Time(secs, neg)));
                    }
                }
            }
            // Пара «метка до слайдера, метка после» — elapsed/длительность
            // плеера; минус у правой метки — она про остаток. Слайдер этой
            // пары — прогресс: делитель (мс/сек) калибруется по метке
            for (idx, item) in &items {
                let Item::Slider { value, pattern, .. } = item else { continue };
                let before = items.iter().rev().find(|(j, it)| {
                    *j < *idx && matches!(it, Item::Time(..)) && idx - j <= 8
                });
                let after = items.iter().find(|(j, it)| {
                    *j > *idx && matches!(it, Item::Time(..)) && j - idx <= 8
                });
                if let (
                    Some((_, Item::Time(el, false))),
                    Some((_, Item::Time(du, neg))),
                ) = (before, after)
                {
                    let dur = if *neg { el + du } else { *du };
                    if *el <= dur && (30..=14400).contains(&dur) {
                        // Делитель — по МЕНЬШЕЙ ошибке против метки, а не по
                        // первому прошедшему порогу: у секундного слайдера со
                        // значением <2 с мс-ветка (|1.5/1000 − 1| ≤ 2) была
                        // истинна первой и давала позицию 0 на 30 с кэша
                        let err_ms = (*value / 1000.0 - *el as f64).abs();
                        let err_sec = (*value - *el as f64).abs();
                        if err_ms.min(err_sec) > 2.0 {
                            continue;
                        }
                        let factor = if err_ms <= err_sec { 1000.0 } else { 1.0 };
                        return Some(((*value / factor).round() as u64, dur, pattern.clone(), factor));
                    }
                }
            }
            // Меток нет — слайдер с большим максимумом это прогресс:
            // миллисекунды либо секунды
            for (_, item) in &items {
                let Item::Slider { value, max, pattern } = item else { continue };
                if *max >= 100_000.0 && *value <= *max {
                    return Some((
                        (*value / 1000.0).round() as u64,
                        (*max / 1000.0) as u64,
                        pattern.clone(),
                        1000.0,
                    ));
                }
                if (30.0..=10_000.0).contains(max) && *value <= *max {
                    return Some((*value as u64, *max as u64, pattern.clone(), 1.0));
                }
            }
            None
        }
    }

    /// Позиция и длительность для оконного пути. Слайдер прогресса
    /// перечитывается КАЖДЫЙ опрос — иначе перемотка до 5с жила в прошлом
    /// (старый троттлинг полного скана). thread_local: window_dto живёт
    /// только в потоке-наблюдателе, COM-интерфейсы не Send
    fn uia_lookup(track_id: &str, hwnd: isize) -> Option<(u64, u64)> {
        use std::cell::RefCell;
        thread_local! {
            static UIA_SLIDER: RefCell<Option<UiaSlider>> = const { RefCell::new(None) };
            // Неудачный полный скан (дерево не построено/окно чужое): без
            // гарда он повторялся бы каждый опрос — ~200мс в секунду
            static UIA_LAST_FAIL: RefCell<Option<std::time::Instant>> =
                const { RefCell::new(None) };
        }
        UIA_LAST_FAIL.with(|fail| {
            if fail
                .borrow()
                .is_some_and(|at| at.elapsed() < Duration::from_secs(5))
            {
                return None;
            }
            UIA_SLIDER.with(|slot| {
                let mut slot = slot.borrow_mut();
                let cached = match slot.take() {
                    Some(c)
                        if c.track_id == track_id
                            && c.scanned.elapsed() < Duration::from_secs(30) =>
                    {
                        Some(c)
                    }
                    // чужой трек или пора перекалиброваться — полный скан ниже
                    _ => None,
                };
                if let Some(c) = cached {
                    match unsafe { c.pattern.CurrentValue() } {
                        Ok(v) if v >= 0.0 => {
                            let pos = (v / c.factor).round() as u64;
                            let dur = c.dur;
                            if pos <= dur + 5 {
                                *slot = Some(c);
                                fail.borrow_mut().take();
                                return Some((pos, dur));
                            }
                            // рассинхрон — полный скан ниже
                        }
                        _ => {} // слайдер протух — полный скан ниже
                    }
                }
                let Some((pos, dur, pattern, factor)) = uia_full_scan(hwnd) else {
                    *fail.borrow_mut() = Some(std::time::Instant::now());
                    return None;
                };
                fail.borrow_mut().take();
                *slot = Some(UiaSlider {
                    track_id: track_id.to_string(),
                    pattern,
                    factor,
                    dur,
                    scanned: std::time::Instant::now(),
                });
                Some((pos, dur))
            })
        })
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

    #[cfg(test)]
    mod tests {
        use super::parse_time_label;

        #[test]
        fn time_labels_parse() {
            // метки плеера: elapsed / total / остаток (с минусом)
            assert_eq!(parse_time_label("1:26"), Some((86, false)));
            assert_eq!(parse_time_label("12:05"), Some((725, false)));
            assert_eq!(parse_time_label("3:50"), Some((230, false)));
            assert_eq!(parse_time_label("-2:30"), Some((150, true)));
            assert_eq!(parse_time_label("1:02:03"), Some((3723, false)));
            // не метки: пусто, без секунд, мусор
            assert_eq!(parse_time_label(""), None);
            assert_eq!(parse_time_label("1:2"), None);
            assert_eq!(parse_time_label("a:b"), None);
            assert_eq!(parse_time_label("Spotify Premium"), None);
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
        // Total-таймаут обязателен: shared_client ставит только
        // connect_timeout, а stalled-соединение (молчащий прокси, NAT без
        // RST) вешало lyrics_fetch навсегда — минибар замирал на «…»
        let items: serde_json::Value = tokio::time::timeout(Duration::from_secs(15), async {
            client
                .get("https://lrclib.net/api/search")
                .query(&[("artist_name", &artist), ("track_name", &title)])
                .header("User-Agent", "Nocturn/0.2 (local media minibar)")
                .send()
                .await
                .map_err(|e| format!("lrclib request failed: {e}"))?
                .json::<serde_json::Value>()
                .await
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|_| "lrclib request timed out after 15s".to_string())??;

        // Выбор записи — чистая функция pick_lyrics ниже: известная
        // длительность — ближайшая по ней (аудит-регресс: раньше при
        // неизвестной длительности unwrap_or(0) делал «лучшей» самую
        // короткую запись); неизвестная — нейтрально, первый подходящий
        // в порядке релевантности lrclib
        let empty = Vec::new();
        let arr = items.as_array().unwrap_or(&empty);
        let target = duration_secs.map(|s| s as f64);
        let synced = pick_lyrics(arr, target, "syncedLyrics")
            .and_then(|it| it.get("syncedLyrics").and_then(|v| v.as_str()).map(String::from));
        let plain = pick_lyrics(arr, target, "plainLyrics")
            .and_then(|it| it.get("plainLyrics").and_then(|v| v.as_str()).map(String::from));
        let dto = LyricsDto {
            plain,
            synced,
            found: true,
        };
        {
            let mut guard = CACHE.lock().map_err(|e| e.to_string())?;
            let map = guard.get_or_insert_with(HashMap::new);
            // Вытеснение четверти вместо clear(): после clear() плейлист
            // >100 треков перезагружал бы лирику всего цикла с lrclib
            if map.len() > 100 {
                let victims: Vec<String> = map.keys().take(25).cloned().collect();
                for k in victims {
                    map.remove(&k);
                }
            }
            map.insert(key, dto.clone());
        }
        Ok(dto)
    }

    /// Выбор записи лирики из ответа lrclib. ЧИСТАЯ функция — золотые тесты
    /// ниже. Счёт: (0, |d − target|) у записей с длительностью при известной
    /// цели; всё прочее (цели нет / у записи нет длительности) — нейтральный
    /// ранг 1 в порядке ответа lrclib: раньше `unwrap_or(0)` в min_by_key
    /// вырождал выбор в «взять запись с минимальным duration» (аудит А2-5)
    fn pick_lyrics<'a>(
        items: &'a [serde_json::Value],
        duration_secs: Option<f64>,
        field: &str,
    ) -> Option<&'a serde_json::Value> {
        let mut best: Option<(u8, f64, usize)> = None;
        for (i, it) in items.iter().enumerate() {
            let Some(s) = it.get(field).and_then(|v| v.as_str()) else {
                continue;
            };
            if s.is_empty() {
                continue;
            }
            let d = it.get("duration").and_then(|v| v.as_f64());
            let rank = match (duration_secs, d) {
                (Some(t), Some(d)) => (0u8, (d - t).abs()),
                // Известная цель, у записи длительности нет: не соревнуется
                // по счёту — идёт после всех записей с длительностью
                (Some(_), None) => (1, 0.0),
                // Цели нет: сверка длительности бессмысленна
                (None, _) => (1, 0.0),
            };
            let better = match best {
                None => true,
                Some((r, s, _)) => rank.0 < r || (rank.0 == r && rank.1 < s),
            };
            if better {
                best = Some((rank.0, rank.1, i));
            }
        }
        best.map(|(_, _, i)| &items[i])
    }

    #[cfg(test)]
    mod pick_tests {
        use super::pick_lyrics;

        /// Золотой вектор: известная длительность — ближайшая по ней
        #[test]
        fn prefers_closest_duration_when_known() {
            let items = vec![
                serde_json::json!({"duration": 210.0, "syncedLyrics": "A"}),
                serde_json::json!({"duration": 195.0, "syncedLyrics": "B"}),
                serde_json::json!({"duration": 240.0, "syncedLyrics": "C"}),
            ];
            let got = pick_lyrics(&items, Some(196.0), "syncedLyrics").unwrap();
            assert_eq!(got.get("syncedLyrics").unwrap(), "B");
        }

        /// Аудит-регресс А2-5: раньше |d − 0| делал «лучшей» самую короткую
        /// запись трека с неизвестной длительностью (радио/поток). Теперь —
        /// первый подходящий в порядке релевантности lrclib
        #[test]
        fn neutral_when_duration_unknown() {
            let items = vec![
                serde_json::json!({"duration": 214.0, "syncedLyrics": "REAL"}),
                serde_json::json!({"duration": 31.0, "syncedLyrics": "SHORT"}),
            ];
            let got = pick_lyrics(&items, None, "syncedLyrics").unwrap();
            assert_eq!(
                got.get("syncedLyrics").unwrap(),
                "REAL",
                "длительность не переупорядочивает выбор"
            );
        }

        /// При известной цели записи без длительности не выигрывают счётом
        #[test]
        fn prefers_records_with_duration_when_known() {
            let items = vec![
                serde_json::json!({"syncedLyrics": "NODUR"}),
                serde_json::json!({"duration": 210.0, "syncedLyrics": "CLOSE"}),
            ];
            let got = pick_lyrics(&items, Some(210.0), "syncedLyrics").unwrap();
            assert_eq!(got.get("syncedLyrics").unwrap(), "CLOSE");
            // Ни у одной записи длительности нет — первая подходящая
            let items2 = vec![
                serde_json::json!({"syncedLyrics": "N1"}),
                serde_json::json!({"syncedLyrics": "N2"}),
            ];
            let got2 = pick_lyrics(&items2, Some(210.0), "syncedLyrics").unwrap();
            assert_eq!(got2.get("syncedLyrics").unwrap(), "N1");
        }

        /// Пустое значение поля и чужое поле не участвуют в выборе
        #[test]
        fn skips_empty_and_wrong_field() {
            let items = vec![
                serde_json::json!({"duration": 200.0, "syncedLyrics": ""}),
                serde_json::json!({"duration": 200.0, "plainLyrics": "PLAIN"}),
            ];
            assert!(pick_lyrics(&items, Some(200.0), "syncedLyrics").is_none());
            let got = pick_lyrics(&items, Some(200.0), "plainLyrics").unwrap();
            assert_eq!(got.get("plainLyrics").unwrap(), "PLAIN");
        }
    }
}
