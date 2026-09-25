# Nocturn

<p align="center">
  <img src="docs/screenshots/main.png" width="820" alt="Nocturn main window" />
</p>

**Nocturn** is a local-first, BYOK (**Bring Your Own Key**) AI client for Windows.
Your API key, your provider, your machine — no accounts, no telemetry, no backend
of its own. Built with **Tauri 2** (native binary) + **React 19 + TypeScript** + Tailwind CSS 4.

**Light by design:** the installer is ~4.4 MB. It idles at **~100 MB RAM**
(app + WebView2, per Task Manager); heavy agent runs with large tool outputs
climb to ~200–300 MB — the agent's own headless browser is a separate process
on top of that. No background services.

> Интерфейс на русском и английском (плюс 中文 / 日本語). Основной язык разработки — TypeScript, нативная часть — Rust.

## Why Nocturn

Most AI desktop apps force a trade-off: hosted clients (Claude Desktop, ChatGPT
desktop) are polished but require registration and route everything through
someone's server; BYOK clients (Chatbox, Cherry Studio, Fabric) respect your key
but stay at the plain-chat level. Nocturn is the missing middle ground:

- **Full anonymity** — no account, no email, no sign-up, no telemetry. The app
  talks only to the API endpoint you configure. First run is: paste your key, go.
- **Claude-Desktop-level features, locally** — agent mode with file, shell, PTY,
  browser and computer tools; permission modes; subagents; checkpoints; MCP;
  hooks; scheduled automations — all running on your machine against your key.
- **Provider-agnostic** — any OpenAI-compatible endpoint plus native Anthropic;
  switch providers mid-project without losing history.
- **Light and local-first** — ~4.4 MB installer, ~100 MB idle RAM, everything
  (chats, projects, notes) stored on your disk in plain, inspectable storage.
- **Safety rails built in** — permission modes, per-task command allowlists and
  hard token/cost budgets with automatic run abortion.

## Features

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
- **Customization** — 8 dark themes + light + **Official** monochrome, accent
  colors, glass effects, **ambient backgrounds** (procedural scenes — fog,
  snowfall, neon city, starfield — or your own looped video), UI scale, theme
  profiles, RU / EN / 中文 / 日本語.

> **A note on ambient video backgrounds:** a looping video behind the chat
> looks great, but the decoder keeps using GPU/battery while it plays.
> Playback pauses automatically while the agent is streaming and when the
> window is minimized, yet on battery-powered laptops the procedural scenes
> are the friendlier choice. Keep custom clips short (~50 MB) and dim — the
> app adds a dark overlay on top for text readability.


## Screenshots

<p align="center">
  <img src="docs/screenshots/quick-look.png" width="420" alt="Quick appearance settings" />
  <img src="docs/screenshots/customization.png" width="420" alt="Appearance settings: theme profiles, accent colors" />
</p>
<p align="center">
  <img src="docs/screenshots/automations.png" width="560" alt="Automations: scheduled agent tasks" />
</p>

## Themes

Two looks, one toggle — **Settings → Customization**. The theme applies
instantly and is remembered.

| Theme | What it is |
|---|---|
| **Halo** (default) | Warm dark palette in the spirit of Claude: 8 dark styles + light, 6 accent presets + custom color, glass effects, theme profiles. |
| **Official** | Strict black / grey / white monochrome in the Linear-Vercel spirit. Hierarchy comes from brightness and borders, color is reserved for semantics — diffs, tool statuses, errors. Extras: true-black OLED background, higher-contrast mode, greyscale code highlighting. Always dark, opt-in. |

## Privacy & Security

Nocturn never sends anything anywhere except the API provider **you** configured.
Prompts, files and tool results go straight to your endpoint; there is no
analytics, no crash reporting, no phone-home. API keys can be encrypted with a
master password (AES-256-GCM); an encrypted vault auto-locks after 15 minutes
of inactivity and asks for the password again on return. The agent layer is
hardened by regular deep-audit passes (permission checks, command allowlists,
tool-output handling).
See [SECURITY.md](SECURITY.md) for the full
breakdown of what is stored and what leaves the machine.

## Getting started

```bash
npm install          # once
npm run tauri dev    # native window (first Rust build takes a few minutes)
npm run dev          # quick browser preview without Tauri
npm run build        # frontend build (tsc + vite)
```

Requirements: **Node 20+** and **Rust** (for the native build).

Windows, Linux and macOS builds are produced automatically for every release —
grab an installer from
[Releases](https://github.com/nocturn-lab/Nocturn-AI/releases). Notes per
platform:

- **Windows** — the most tested platform.
- **macOS** — builds are unsigned; on first launch right-click the app →
  *Open*, or allow it in System Settings → Privacy & Security.
- **Linux** — use the `.AppImage` for automatic in-app updates (`.deb` updates
  manually); Computer Use (screen capture / input) requires an **X11** session.

## Project layout

```
src/            React frontend (App, ChatArea, Sidebar, SettingsModal, …)
src-tauri/      Rust side: tools, MCP, browser (CDP), PTY, crypto, hooks
locales/        ru / en / zh / ja dictionaries
docs/           screenshots, internal dev notes
.github/        CI: frontend build + cargo tests
```

## Contributing

Issues and PRs are welcome. `npm run lint`, `npm test`, `npm run build` and
`cargo clippy --lib -- -D warnings` / `cargo test --lib` (in `src-tauri/`)
must pass — CI enforces all of them. Internal development notes live in
[docs/internal/SESSION_NOTES.md](docs/internal/SESSION_NOTES.md).

## License

[MIT](LICENSE)
