# AGENTS.md: Rules for Nocturn Codebase

Context for agents and human contributors. Keep concise and up-to-date:
rule updates must be committed alongside the code changes they describe.

## What this is

Nocturn (HaloUI), a local BYOK AI client: Tauri 2 + React 19 + TypeScript +
Tailwind 4, with a Rust backend in `src-tauri/`. No cloud dependencies: keys,
conversations, and settings are stored locally on disk (sensitive parts in an
encrypted vault).

## Code Map

**Backend (`src-tauri/src/`):**
- `chat.rs`: Provider SSE streams (OpenAI-compatible + native Anthropic),
  abort registry; `tooling.rs`: orchestration, `run_tool`, tool schemas,
  user-disabled guardrails; `tools.rs`: built-in tool registry
- `perm.rs`: Server-side permission model (plan/ask/edit/full); `crypto.rs`:
  AES-256-GCM + Argon2id; `settings.rs`: settings, profiles, export/import
- `mcp.rs`: MCP over stdio; `browser.rs` (CDP), `computer.rs`, `pty.rs` (ConPTY),
  `hooks.rs`, `files.rs` (checkpoints), `colibri.rs` (runs `coli serve`)

**Frontend (`src/`):**
- `App.tsx`: Top-level state and composition; `hooks/useAgentRun.ts`:
  agent loop; `api.ts`: Typed invoke wrappers (single entry point for IPC)
- `components/cards/`: Message cards; `components/settings/`: Settings panels;
  `src/locales/{ru,en,zh,ja}.ts`: Localization dictionaries (`MsgKey = keyof ru`)

## Commands

- `npm run tauri dev`: Launch application (UI runs inside the native window)
- `npm run build`: `tsc` + `vite build`; `npm run lint`: ESLint for `src`
- `npm run test`: Vitest, including performance budgets for hot paths
  (`*.perf.test.ts`)
- `cargo test` and `cargo clippy --all-targets -- -D warnings` inside `src-tauri/`
- `node scripts/verify.mjs fast`: `tsc` + ESLint + Vitest (~16s)
- `node scripts/verify.mjs all`: Fast suite + Clippy + Cargo tests + full build

## Workflow & Rituals

1. Every change requires a passing `verify fast`; run `verify all` before
   submitting work. The pre-commit hook runs `fast` automatically.
2. New locale keys must be added to **all 4** dictionaries (ru/en/zh/ja) with
   accurate translations, not placeholders.
3. Commit messages must follow conventional commits: `type(scope): message`
   in English, matching the style in `git log`.

## Conventions

- New agent tool: Schema in `tools.rs`/`tooling.rs`; mutating tools must be
  added to `isMutatingTool` (`src/agent/toolFilter.ts`, guarded by tests) and
  in `perm.rs`. Call guardrails must precede PreToolUse hooks (examples:
  `ensure_not_user_disabled`, `perm::decide`).
- Any frontend file write by path must use `ensure_export_target`
  (sensitive path protection, outside config directory, atomic write).
- `hooks.json` and `mcp.json` are executable configurations: arbitrary writes
  to the config directory are an RCE vector. Never weaken `perm.rs` or
  `crypto.rs` checks.
- Frontend paths are validated via `rejects_sensitive_path` and
  `ensure_export_target` (in `settings.rs`): verbatim prefixes (`\\?\`),
  relative traversals, and 8.3 aliases are normalized or rejected.
- Settings export: `crypto.json` is exported only when `include_secrets=true`
  (otherwise shared configs expose key derivation material).
- UI colors use `halo-*` design tokens (Tailwind CSS theme variables); add
  new tokens via `appearance.ts`, never hardcode in components. Semantic
  status indicators (success/error/warning colors) are intentionally decoupled.
- Code comments are written in Russian or English and must explain *why*,
  not *what*.
- Synchronous `#[tauri::command]` functions must never touch the filesystem or
  network: blocking calls freeze the main UI thread.
- Process execution uses `proc::run_command_opts` (sets `CREATE_NO_WINDOW` and
  process groups); terminate process trees using `proc::kill_tree`.
- Field Enter-handlers must check `!isComposing`: IME confirmation Enter keys
  share `key === "Enter"` and must not submit or commit prematurely.
- Platform-specific FFI (`#[link(name = ...)]`) must be strictly guarded with
  `#[cfg(windows)]` or `#[cfg(unix)]`.
- CSS rules: `color-mix()` must include `@supports` fallbacks for older
  WebKitGTK engines; use `backdrop-filter` conditionally; avoid `transition-all`.

## Gotchas

- Windows: Terminate child processes as a tree (`proc::kill_tree`: `taskkill /T /F`
  on Windows, `kill -pgid` on Unix); use `cmd /C` only with raw arguments; socket
  timeouts manifest as `TimedOut`, not `WouldBlock`.
- Python scripts & regex: Pass backslashes via `chr(92)`; verify raw bytes after
  generation (`\\n` in Python is `\n` on disk).
- TypeScript effects with early returns and repeated conditions trigger TS2367;
  callbacks do not narrow types across closures, use holder objects when needed.

## Documentation

- `README.md`: Public project overview and setup.
- `SECURITY.md` / `RELEASE.md`: Security policy and release workflow.
