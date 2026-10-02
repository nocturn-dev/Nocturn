//! Единый примитив запуска процессов: stdout/stderr читаются параллельно
//! потоками (иначе команды с выводом больше буфера пайпа блокируются),
//! таймаут с kill, сбор вывода с grace-периодом и обрезкой по 64 КБ.

use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const READ_CAP: usize = 256 * 1024; // потолок чтения одного потока
const OUTPUT_LIMIT: usize = 64 * 1024; // лимит при форматировании
const DRAIN_GRACE: Duration = Duration::from_secs(2);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Результат запуска: код выхода (None — убит по таймауту либо статус
/// недоступен), признак таймаута и собранный stdout/stderr.
pub(crate) struct ProcOutput {
    pub status: Option<i32>,
    pub timed_out: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Единый примитив: таймаут с kill + опциональный stdin-payload + опциональный
/// abort-флаг (Stop убивает исполняющийся процесс, не дожидаясь таймаута).
/// stdin пишется отсоединённым потоком: если процесс его не читает, write_all
/// блокируется на заполненном пайпе, но kill/смерть процесса закрывает пайп
/// и даёт broken pipe — дедлок невозможен.
pub(crate) fn run_command_opts(
    cmd: &mut Command,
    timeout: Duration,
    stdin_payload: Option<Vec<u8>>,
    abort: Option<&std::sync::atomic::AtomicBool>,
) -> Result<ProcOutput, String> {
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(if stdin_payload.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: консольные дети (powershell/cmd/git) из
        // GUI-процесса иначе создают видимое консольное окно на каждый вызов.
        // hooks.rs ставит тот же флаг сам — перезапись идемпотентна
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::process::CommandExt;
        // Своя процесс-группа: kill_tree по -pgid гасит и внуков, иначе
        // `sh -c "sleep 100 &"` при таймауте оставляет сироту с пайпами
        cmd.process_group(0);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn command: {e}"))?;

    if let (Some(payload), Some(mut stdin)) = (stdin_payload, child.stdin.take()) {
        // Отсоединённый поток-писатель: join() здесь нельзя — он ждал бы до
        // цикла таймаута, а хук вида `echo ok` stdin никогда не прочитает.
        std::thread::spawn(move || {
            use std::io::Write as _;
            let _ = stdin.write_all(&payload);
            // drop закрывает stdin — многие утилиты ждут EOF
        });
    }

    Ok(finish(child, timeout, abort))
}

/// Гасить процесс вместе с деревом потомков: shell/hooks порождают внуков,
/// kill одного ребёнка оставляет сирот с унаследованными пайпами/портами
/// (AGENTS.md: «дочерние процессы гасить деревом»). На Unix ребёнок должен
/// быть в своей группе — process_group(0) ставится при spawn в этом модуле.
pub(crate) fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: taskkill из GUI-приложения иначе мигнёт консолью
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
    #[cfg(not(windows))]
    {
        // Отрицательный pid = вся процесс-группа; SIGKILL неперехватываем
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
}

/// Ожидание с таймаутом + сбор вывода из пайпов.
fn finish(mut child: Child, timeout: Duration, abort: Option<&std::sync::atomic::AtomicBool>) -> ProcOutput {
    // stdout/stderr читаем двумя фоновыми потоками ПАРАЛЛЕЛЬНО с ожиданием
    // завершения: иначе команда с выводом больше буфера пайпа (~64 КБ)
    // блокируется на записи, try_wait не видит завершения — ложный TIMEOUT.
    // Известный остаток: потомок-демон, переживший kill_tree с унаследованным
    // пайпом (fork+setsid), держит read до EOF вечно — поток + до READ_CAP
    // буфера остаются до выхода приложения. Таймированное чтение std-пайпа
    // недоступно, асинхронный рерайт оправдан только если случай станет
    // реальным (хуки с демонизацией)
    let (out_tx, out_rx) = mpsc::channel();
    let (err_tx, err_rx) = mpsc::channel();
    if let Some(mut s) = child.stdout.take() {
        std::thread::spawn(move || {
            let _ = out_tx.send(read_capped(&mut s));
        });
    }
    if let Some(mut s) = child.stderr.take() {
        std::thread::spawn(move || {
            let _ = err_tx.send(read_capped(&mut s));
        });
    }

    // Ожидание с таймаутом: poll try_wait, по истечении — kill
    let started = Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) => {
                // Stop: гасим процесс немедленно, не дожидаясь таймаута.
                // Дерево, а не только ребёнок: иначе внуки живут с пайпами
                if abort.is_some_and(|f| f.load(std::sync::atomic::Ordering::Relaxed)) {
                    kill_tree(child.id());
                    let _ = child.kill();
                    let _ = child.wait();
                    timed_out = true;
                    break None;
                }
                if started.elapsed() > timeout {
                    kill_tree(child.id());
                    let _ = child.kill();
                    let _ = child.wait();
                    timed_out = true;
                    break None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                // try_wait не смог получить статус (сбой ОС). Убиваем ребёнка,
                // чтобы не оставить процесс-сироту, собираем пайпы с
                // grace-периодом и возвращаем текст ошибки в stderr
                let _ = child.kill();
                let _ = child.wait();
                let _ = out_rx.recv_timeout(DRAIN_GRACE);
                let _ = err_rx.recv_timeout(DRAIN_GRACE);
                return ProcOutput {
                    status: None,
                    timed_out: false,
                    stdout: String::new(),
                    stderr: format!("command failed: {e}"),
                };
            }
        }
    };

    // Собрать вывод с grace-периодом: внучатые процессы могут держать пайп
    // открытым после смерти родителя — recv_timeout не даёт висеть вечно.
    let stdout = clip(&drain(out_rx));
    let stderr = clip(&drain(err_rx));
    ProcOutput {
        status: status.and_then(|s| s.code()),
        timed_out,
        stdout,
        stderr,
    }
}

/// Читает поток с потолком READ_CAP байт. После лимита чтение ПРОДОЛЖАЕТСЯ
/// (лишние байты отбрасываются): раньше break дропал пайп — процесс получал
/// EPIPE/SIGPIPE посреди работы и умирал (терялся exit-код), а процесс,
/// игнорирующий SIGPIPE, блокировался на записи до ложного «TIMEOUT».
fn read_capped<R: Read>(r: &mut R) -> Vec<u8> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let mut capped = false;
    loop {
        match r.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if !capped {
                    buf.extend_from_slice(&chunk[..n]);
                    if buf.len() >= READ_CAP {
                        buf.truncate(READ_CAP);
                        capped = true;
                    }
                }
                // capped: байты читаем и выбрасываем — пайп остаётся живым
            }
        }
    }
    buf
}

/// Один recv с grace-периодом: второй порции не ждём, внучатые процессы
/// могут держать пайп открытым неограниченно долго.
fn drain(rx: mpsc::Receiver<Vec<u8>>) -> Vec<u8> {
    rx.recv_timeout(DRAIN_GRACE).unwrap_or_default()
}

/// Байты в строку без паники (потеря UTF-8 допустима); слишком длинный вывод
/// режем по границе символа с пометкой об усечении.
fn clip(b: &[u8]) -> String {
    let mut text = String::from_utf8_lossy(b).to_string();
    if text.len() > OUTPUT_LIMIT {
        crate::truncate_at_char_boundary(&mut text, OUTPUT_LIMIT);
        text.push_str("\n...[output truncated]");
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Регресс: Stop (abort-флаг) обязан убить исполняющийся процесс быстро,
    /// а не дожидаться таймаута. Проверяет и «дерево»: taskkill /T /F (Windows)
    /// и kill -pgid (Unix) гасят потомков спящего шелла
    #[test]
    fn abort_kills_process_immediately() {
        let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let f2 = flag.clone();
        let handle = std::thread::spawn(move || {
            let mut c = if cfg!(windows) {
                let mut c = Command::new("powershell");
                c.args(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"]);
                c
            } else {
                let mut c = Command::new("sh");
                c.args(["-c", "sleep 30"]);
                c
            };
            run_command_opts(&mut c, Duration::from_secs(60), None, Some(&f2))
        });
        // Даём процессу взлететь, затем жмём «Stop»
        std::thread::sleep(Duration::from_millis(500));
        let t0 = Instant::now();
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
        let out = handle.join().unwrap().unwrap();
        assert!(out.timed_out, "abort помечает вывод как прерванный");
        assert!(
            t0.elapsed() < Duration::from_secs(10),
            "abort должен убить процесс мгновенно, а не ждать таймаута (60 с)"
        );
    }

    /// Регресс [A5]: после READ_CAP читатель обязан ДОЧИТАТЬ поток до конца
    /// (не рвать пайп): процесс, пишущий больше лимита, раньше умирал от
    /// EPIPE, а игнорирующий SIGPIPE — блокировался до ложного TIMEOUT
    #[test]
    fn read_capped_drains_past_cap() {
        struct BigReader { remaining: usize }
        impl Read for BigReader {
            fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
                if self.remaining == 0 {
                    return Ok(0); // EOF: источник дописал до конца
                }
                let n = out.len().min(self.remaining).min(10_000);
                for b in &mut out[..n] {
                    *b = b'x';
                }
                self.remaining -= n;
                Ok(n)
            }
        }
        // 1 МБ источника — в 4 раза больше READ_CAP
        let mut r = BigReader { remaining: 1024 * 1024 };
        let buf = read_capped(&mut r);
        assert_eq!(buf.len(), READ_CAP);
        // Дочитали до EOF, а не бросили после лимита
        assert_eq!(r.remaining, 0);
    }
}
