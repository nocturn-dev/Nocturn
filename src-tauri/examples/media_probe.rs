//! Зонд SMTC + окон Spotify: диагностика медиа-минибара на живой машине.
//! `cargo run --example media_probe` — SMTC-сессии + заголовки окон
//! spotify.exe. `cargo run --example media_probe -- --toggle` — проверить
//! управление без SMTC (WM_APPCOMMAND PLAY_PAUSE; Spotify визуально
//! переключит воспроизведение).

#[cfg(windows)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus,
    };
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    println!("[1] CoInitializeEx ok");

    let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()?.get()?;
    println!("[2] менеджер получен");

    let view = manager.GetSessions()?;
    let it = view.First()?;
    let mut n = 0;
    loop {
        if !it.MoveNext()? {
            break;
        }
        n += 1;
        let s = it.Current()?;
        let source = s
            .SourceAppUserModelId()
            .map(|v| v.to_string())
            .unwrap_or_default();
        let props = s.TryGetMediaPropertiesAsync()?.get()?;
        let title = props.Title().map(|v| v.to_string()).unwrap_or_default();
        let artist = props.Artist().map(|v| v.to_string()).unwrap_or_default();
        let playing = s
            .GetPlaybackInfo()
            .ok()
            .and_then(|p| p.PlaybackStatus().ok())
            .map(|st| st == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing)
            .unwrap_or(false);
        println!("  #{n} source={source:?} playing={playing} title={title:?} artist={artist:?}");
    }
    println!("[3] SMTC-сессий: {n}");

    // Оконный путь: если клиент не регистрирует SMTC — у десктопного
    // Spotify заголовок главного окна несёт «Artist — Track — Album»
    println!("[4] процессы spotify.exe:");
    let pids = spotify_pids();
    if pids.is_empty() {
        println!("  (процесс не запущен)");
    } else {
        for pid in &pids {
            println!("  pid={pid}");
        }
        let windows = spotify_windows(&pids);
        if windows.is_empty() {
            println!("  (видимых окон с заголовками нет)");
        }
        for (hwnd, pid, title) in &windows {
            println!("  окно hwnd={hwnd:#x} pid={pid} title={title:?}");
        }
        // --toggle: WM_APPCOMMAND PLAY_PAUSE окну с треком — проверка
        // управления без SMTC (Spotify визуально тогглит воспроизведение)
        let toggle = std::env::args().any(|a| a == "--toggle");
        if toggle {
            let track_hwnd = windows
                .iter()
                .find(|(_hwnd, pid, title)| {
                    pids.contains(pid)
                        && title.contains(" - ")
                        && !title.eq_ignore_ascii_case("Spotify")
                })
                .map(|(hwnd, _, _)| *hwnd);
            match track_hwnd {
                Some(hwnd) => {
                    println!("[4b] WM_APPCOMMAND PLAY_PAUSE → hwnd={hwnd:#x}");
                    post_play_pause(hwnd)?;
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    println!("[4c] заголовки после тоггла:");
                    for (hwnd, pid, title) in spotify_windows(&pids) {
                        println!("  окно hwnd={hwnd:#x} pid={pid} title={title:?}");
                    }
                }
                None => println!("  (окно с треком не найдено)"),
            }
        }
    }
    println!("[5] готово");
    Ok(())
}

/// PID всех процессов spotify.exe
#[cfg(windows)]
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
#[cfg(windows)]
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
        .filter(|(hwnd, pid, _)| {
            let _ = hwnd;
            pids.contains(pid)
        })
        .collect()
}

/// WM_APPCOMMAND (0x319) PLAY_PAUSE → окну Spotify: исторический путь
/// управления для клиентов без SMTC
#[cfg(windows)]
fn post_play_pause(hwnd: isize) -> Result<(), String> {
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::PostMessageW;
    const WM_APPCOMMAND: u32 = 0x0319;
    const APPCOMMAND_MEDIA_PLAY_PAUSE: isize = 14;
    unsafe {
        PostMessageW(
            Some(HWND(hwnd as *mut _)),
            WM_APPCOMMAND,
            WPARAM(0),
            LPARAM(APPCOMMAND_MEDIA_PLAY_PAUSE << 16),
        )
        .map_err(|e| e.to_string())
    }
}

#[cfg(not(windows))]
fn main() {
    println!("probe is Windows-only");
}
