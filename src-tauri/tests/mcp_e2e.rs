//! E2E-тест MCP-клиента против настоящего процесса:
//! спавн → рукопожатие initialize → tools/list → tools/call → таймаут.

use serde_json::json;
use std::process::{Command, Stdio};
use std::time::Duration;

use nocturn_lib::mcp::McpConnection;

fn spawn_helper() -> std::process::Child {
    Command::new(env!("CARGO_BIN_EXE_mcp_echo_helper"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn mcp_echo_helper")
}

#[test]
fn mcp_client_end_to_end() {
    let mut child = spawn_helper();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let conn = McpConnection::from_child("echo", child, stdout, stderr)
        .expect("handshake must succeed");

    let tools = conn.tools.lock().unwrap().clone();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].name, "echo");
    assert!(tools[0].description.contains("Echoes"));

    let out = conn
        .call_tool("echo", json!({ "text": "привет HaloUI" }))
        .expect("call must succeed");
    assert_eq!(out, "echo: привет HaloUI");

    // Отрицательный сценарий: неизвестный метод — эхо-сервер на него
    // не отвечает, клиент должен отпустить запрос по короткому таймауту
    // (не ждём 120 секунд CALL_TIMEOUT)
    let res = conn.request("nonexistent/method", json!({}), Duration::from_secs(2));
    assert!(res.is_err(), "unknown method must time out");
    assert!(res.unwrap_err().contains("timeout"));

    conn.kill();
}

/// Пул: краш сервера → транспортная ошибка (детектится is_transport_err),
/// после реконнекта (новый процесс) вызов снова работает
#[test]
fn mcp_pool_reconnect_after_crash() {
    let mut child = spawn_helper();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let conn =
        nocturn_lib::mcp::McpConnection::from_child("echo", child, stdout, stderr)
            .expect("handshake must succeed");

    let ok = conn
        .call_tool("echo", json!({ "text": "before crash" }))
        .expect("call before crash must succeed");
    assert_eq!(ok, "echo: before crash");

    // Краш сервера: пайпы умирают вместе с процессом
    conn.kill();

    let err = conn
        .call_tool("echo", json!({ "text": "after crash" }))
        .expect_err("call on dead server must fail");
    assert!(
        nocturn_lib::mcp::is_transport_err(&err),
        "must be a transport error, got: {err}"
    );

    // Реконнект: свежий процесс → вызов снова работает
    let mut fresh_child = spawn_helper();
    let fresh_stdout = fresh_child.stdout.take().unwrap();
    let fresh_stderr = fresh_child.stderr.take().unwrap();
    let fresh = nocturn_lib::mcp::McpConnection::from_child(
        "echo",
        fresh_child,
        fresh_stdout,
        fresh_stderr,
    )
    .expect("reconnect must succeed");
    let out = fresh
        .call_tool("echo", json!({ "text": "after reconnect" }))
        .expect("call after reconnect must succeed");
    assert_eq!(out, "echo: after reconnect");
    fresh.kill();
}

#[test]
fn mcp_client_unicode_roundtrip() {
    let mut child = spawn_helper();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let conn = McpConnection::from_child("echo", child, stdout, stderr).unwrap();
    let out = conn
        .call_tool(
            "echo",
            json!({ "text": "съешь ещё этих мягких французских булок 🚀" }),
        )
        .unwrap();
    assert!(out.contains("французских булок"));
    assert!(out.contains("🚀"));
    conn.kill();
}
