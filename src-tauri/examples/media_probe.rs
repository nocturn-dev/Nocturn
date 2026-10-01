//! Зонд SMTC: диагностика медиа-минибара на живой машине.
//! `cargo run --example media_probe` — печатает системные медиа-сессии,
//! их источник, трек и статус. Запускается вне Tauri, тот же путь WinRT,
//! что в src-tauri/src/media.rs — расхождение в поведении сразу видно.

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

    let op = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()?;
    println!("[2] RequestAsync получен, жду завершения…");
    let manager = op.get()?;
    println!("[3] менеджер получен");

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
        println!(
            "  #{n} source={source:?} playing={playing} title={title:?} artist={artist:?}"
        );
    }
    if n == 0 {
        println!("  (сессий нет — ни один плеер сейчас не регистрирует SMTC)");
        println!("  подсказка: запусти Spotify и нажми play, затем повтори зонд");
    }
    println!("[4] готово, сессий: {n}");
    Ok(())
}

#[cfg(not(windows))]
fn main() {
    println!("probe is Windows-only");
}
