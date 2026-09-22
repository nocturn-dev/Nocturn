//! Отдельный бинарём-«сервер» для e2e-тестов MCP-клиента:
//! tests/mcp_e2e.rs запускает его как настоящий дочерний процесс по stdio.
fn main() {
    nocturn_lib::mcp::run_echo_helper();
}
