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

/// Ожидание с таймаутом + сбор вывода из пайпов.
fn finish(mut child: Child, timeout: Duration, abort: Option<&std::sync::atomic::AtomicBool>) -> ProcOutput {
    // stdout/stderr читаем двумя фоновыми потоками ПАРАЛЛЕЛЬНО с ожиданием
    // завершения: иначе команда с выводом больше буфера пайпа (~64 КБ)
    // блокируется на записи, try_wait не видит завершения — ложный TIMEOUT.
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
                // Stop: гасим процесс немедленно, не дожидаясь таймаута
                if abort.is_some_and(|f| f.load(std::sync::atomic::Ordering::Relaxed)) {
                    let _ = child.kill();
                    let _ = child.wait();
                    timed_out = true;
                    break None;
                }
                if started.elapsed() > timeout {
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

/// Читает поток с потолком READ_CAP байт, хвост отбрасывает (он всё равно
/// будет clip'нут при форматировании до OUTPUT_LIMIT). Возвращает сырые байты.
fn read_capped<R: Read>(r: &mut R) -> Vec<u8> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match r.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() >= READ_CAP {
                    buf.truncate(READ_CAP);
                    break;
                }
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
