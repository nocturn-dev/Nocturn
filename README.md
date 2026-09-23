# Nocturn

<p align="center">
  <img src="docs/screenshots/main.png" width="820" alt="Nocturn main window" />
</p>

**Nocturn** is a local-first, BYOK (**Bring Your Own Key**) AI client for Windows.
Your API key, your provider, your machine — no accounts, no telemetry, no backend
of its own. Built with **Tauri 2** (native binary) + **React 19 + TypeScript** + Tailwind CSS 4.

**Light by design:** the installer is ~4.4 MB and the running app stays around
**~100 MB RAM** total (app + WebView2, per Task Manager) — no background services.

> Интерфейс на русском и английском (плюс 中文 / 日本語). Основной язык разработки — TypeScript, нативная часть — Rust.

## Features

- **Chat & Agent** — streaming chat with any OpenAI-compatible provider or native
  Anthropic; agent mode with tools (files, shell, PTY terminal, browser, computer),
  permission modes (Plan / Ask / Edit / Full) and per-task command allowlists.
- **Subagents** — parallel role-based workers (researcher / coder / critic / librarian)
  with a live monitor next to the send button.
- **Live browser view** — watch what the agent's browser does in a side panel,
  with viewport presets (1280×720, Fit, …).
- **Checkpoints & rollback** — automatic project snapshots before agent edits,
  restore any state in one click.
- **Automations** — scheduled tasks (daily / weekdays / weekly / interval): the
  agent starts a chat and runs the prompt on schedule. Optional keep-awake.
- **Vault** — markdown notes with `[[wiki links]]`, a visual knowledge graph and
  vault tools the agent can read and write.
- **MCP** — connect external Model Context Protocol servers (stdio), tools merge
  into the agent automatically.
- **Hooks** — shell commands on PreToolUse / PostToolUse / UserPromptSubmit /
  Stop / SessionStart; can block or enrich agent actions.
- **Hard Limits** — per-task budgets (tokens, $/1M tokens, $ total) with automatic
  run abortion.
- **Crypto vault** — optional AES-256-GCM encryption of API keys with a master
  password.
- **Image generation** — optional `image_generate` agent tool via your own
  image API (off by default).
- **Customization** — 6 dark themes + light, accent colors, glass effects, UI
  scale, theme profiles, RU / EN / 中文 / 日本語.


## Screenshots

<p align="center">
  <img src="docs/screenshots/quick-look.png" width="420" alt="Quick appearance settings" />
  <img src="docs/screenshots/customization.png" width="420" alt="Appearance settings: theme profiles, accent colors" />
</p>
<p align="center">
  <img src="docs/screenshots/automations.png" width="560" alt="Automations: scheduled agent tasks" />
</p>

## Privacy & Security

Nocturn never sends anything anywhere except the API provider **you** configured.
Prompts, files and tool results go straight to your endpoint; there is no
analytics, no crash reporting, no phone-home. API keys can be encrypted with a
master password (AES-256-GCM). See [SECURITY.md](SECURITY.md) for the full
breakdown of what is stored and what leaves the machine.

## Getting started

```bash
npm install          # once
npm run tauri dev    # native window (first Rust build takes a few minutes)
npm run dev          # quick browser preview without Tauri
npm run build        # frontend build (tsc + vite)
```

Requirements: **Node 20+** and **Rust** (for the native build). Windows is the
primary platform; macOS/Linux are not tested yet — expect rough edges.

## Project layout

```
src/            React frontend (App, ChatArea, Sidebar, SettingsModal, …)
src-tauri/      Rust side: tools, MCP, browser (CDP), PTY, crypto, hooks
locales/        ru / en / zh / ja dictionaries
docs/           screenshots, internal dev notes
.github/        CI: frontend build + cargo tests
```

## Contributing

Issues and PRs are welcome. `npm run build` and `cargo test` (in `src-tauri/`)
must pass — CI enforces both. Internal development notes live in
[docs/internal/SESSION_NOTES.md](docs/internal/SESSION_NOTES.md).

## License

[MIT](LICENSE)
