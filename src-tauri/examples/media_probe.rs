//! Зонд SMTC + окон Spotify: диагностика медиа-минибара на живой машине.
//! `cargo run --example media_probe` — SMTC-сессии (с таймлайнами) +
//! заголовки окон spotify.exe. `--toggle` — проверить управление без SMTC
//! (WM_APPCOMMAND PLAY_PAUSE; Spotify визуально переключит воспроизведение).
//! `--uia` — UI Automation по окнам Spotify: тексты времени и слайдеры
//! (проверка читаемости позиции плеера без SMTC; дерево Chromium строится
//! лениво — первый прогон почти пуст, второй полный).

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
        // Таймлайн: жива ли Position во время воспроизведения, что с End
        if let Ok(tl) = s.GetTimelineProperties() {
            let pos = tl.Position().map(|t| t.Duration / 10_000_000).unwrap_or(-1);
            let end = tl.EndTime().map(|t| t.Duration / 10_000_000).unwrap_or(-1);
            let lut = tl
                .LastUpdatedTime()
                .map(|dt| dt.UniversalTime / 10_000 - 11_644_473_600_000)
                .unwrap_or(-1);
            let now_unix = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            println!(
                "      timeline pos={pos}s end={end}s lastUpdated-возраст={}мс",
                now_unix - lut
            );
        }
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
        // --uia: UI Automation по окну с треком — тексты времени и слайдеры
        let uia = std::env::args().any(|a| a == "--uia");
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
        if uia {
            for (hwnd, pid, title) in &windows {
                println!("[4d] UIA-скан hwnd={hwnd:#x} pid={pid} title={title:?}");
                match uia_scan(*hwnd) {
                    Ok(()) => {}
                    Err(e) => println!("  UIA ошибка: {e}"),
                }
            }
            if windows.is_empty() {
                println!("  (окон нет — сканировать нечего)");
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

/// UIA-скан окна: все тексты вида «мм:сс» и все слайдеры с RangeValue.
/// Цель — понять, читаются ли из Spotify время воспроизведения и полоса
/// прогресса без SMTC
#[cfg(windows)]
fn uia_scan(hwnd: isize) -> Result<(), String> {
    use windows::core::Interface;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance};
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationRangeValuePattern, TreeScope_Subtree,
        UIA_ControlTypePropertyId, UIA_NamePropertyId, UIA_RangeValuePatternId,
        UIA_SliderControlTypeId,
    };

    unsafe {
        let uia: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).map_err(|e| e.to_string())?;
        let root = uia
            .ElementFromHandle(HWND(hwnd as *mut _))
            .map_err(|e| e.to_string())?;

        // TrueCondition + кэш Name/ControlType: VARIANT-условия в windows
        // 0.61 неудобны, фильтр по типам делаем в расте по кэшу
        let cond = uia.CreateTrueCondition().map_err(|e| e.to_string())?;
        let cache = uia.CreateCacheRequest().map_err(|e| e.to_string())?;
        cache
            .AddProperty(UIA_NamePropertyId)
            .map_err(|e| e.to_string())?;
        cache
            .AddProperty(UIA_ControlTypePropertyId)
            .map_err(|e| e.to_string())?;

        let t0 = std::time::Instant::now();
        let arr = root
            .FindAllBuildCache(TreeScope_Subtree, &cond, &cache)
            .map_err(|e| e.to_string())?;
        let len = arr.Length().map_err(|e| e.to_string())?;
        println!("  элементов: {}, скан {:?}", len, t0.elapsed());
        for i in 0..len {
            let el = arr.GetElement(i).map_err(|e| e.to_string())?;
            let name = el
                .CachedName()
                .map(|v| v.to_string())
                .unwrap_or_default();
            let ct = el.CachedControlType().map(|t| t.0).unwrap_or(0);
            if ct == UIA_SliderControlTypeId.0 {
                let val = el
                    .GetCurrentPattern(UIA_RangeValuePatternId)
                    .ok()
                    .and_then(|p| p.cast::<IUIAutomationRangeValuePattern>().ok())
                    .and_then(|p| p.CurrentValue().ok());
                println!("  [{i}] SLIDER value={val:?}");
            } else if is_time_label(&name) {
                println!("  [{i}] TIME {name:?}");
            }
        }
    }
    Ok(())
}

/// Строка вида «мм:сс» (с минусом или без) — метка времени плеера
#[cfg(windows)]
fn is_time_label(s: &str) -> bool {
    let b = s.trim().strip_prefix('-').unwrap_or(s.trim());
    let (mm, ss) = match b.split_once(':') {
        Some(v) => v,
        None => return false,
    };
    !mm.is_empty()
        && mm.len() <= 3
        && mm.bytes().all(|c| c.is_ascii_digit())
        && ss.len() == 2
        && ss.bytes().all(|c| c.is_ascii_digit())
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
