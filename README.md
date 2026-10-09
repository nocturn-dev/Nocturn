# Nocturn

<p align="center">
  <img src="docs/screenshots/main.png" width="820" alt="Nocturn main window: Full Claude theme, mascot Nok on the composer" />
</p>

**Nocturn** is a local-first, BYOK (**Bring Your Own Key**) AI client for
Windows, Linux and macOS (Windows is the most tested).
Your API key, your provider, your machine — no accounts, no telemetry, no backend
of its own. Built with **Tauri 2** (native binary) + **React 19 + TypeScript** + Tailwind CSS 4.

**Light by design:** the installer is ~16.6 MB. It idles at **~100 MB RAM**
(app + WebView2, per Task Manager); heavy agent runs with large tool outputs
climb to ~200–300 MB — the agent's own headless browser is a separate process
on top of that. No background services.

> Интерфейс на русском и английском (плюс 中文 / 日本語). Основной язык разработки — TypeScript, нативная часть — Rust.

## Why Nocturn

Hosted clients require registration and route everything through someone's
server; BYOK clients respect your key but stay at the plain-chat level.
Nocturn is the middle ground:

- **Full anonymity** — no account, no email, no sign-up, no telemetry. The app
  talks only to the API endpoint you configure. First run is: paste your key, go.
- **Agent-grade features, locally** — file, shell, PTY, browser, computer-use
  and Python tools; permission modes; subagents; memory; checkpoints; MCP;
  hooks; scheduled automations; local RAG; voice input and output.
- **Provider-agnostic** — any OpenAI-compatible endpoint plus native Anthropic
  and the OpenAI Responses API; a fallback model per profile; compare up to
  three providers side-by-side on one prompt.
- **Light and local-first** — everything (chats, projects, notes, knowledge
  bases, memory) stored on your disk in plain, inspectable JSON/markdown/SQLite.
- **Safety rails built in** — permission modes, per-task command allowlists,
  sensitive-path guards and hard token/cost budgets with automatic run abortion.

## Features

### Chat & agent

- **Streaming chat** with any OpenAI-compatible provider or native Anthropic;
  markdown, syntax highlighting, **editable Mermaid diagrams**, quote-into-composer,
  **edit & resend with branching** (editing any message forks a new session).
- **Agent mode** with tools: files (read/write/grep/list), shell, live **PTY
  terminal**, **Browser Use** via CDP (with a live view panel), **Computer
  Use** (screen capture, mouse, keyboard), image generation, and **Code
  Interpreter** — Python 3 via Pyodide (WASM) in a sandboxed worker. Read-only
  calls run in parallel batches; permission and deny checks stay enforced on
  the Rust side. After an edit, **LSP diagnostics** come back in the same turn
  — the model fixes compile errors immediately.
- **Context management for long runs** — old tool results are compacted away
  (microcompact), the conversation head is summarized into a persistent
  boundary when nearing the window (autocompact), a response cut by the output
  limit continues from where it stopped.
- **Permission modes** (Plan / Ask / Edit / Full) with **persistent rules**
  (deny / always-ask / allow, prefix-based like `shell_run(git *)`), a
  sensitive-path deny class (`.env`, `.ssh` — overridable only by an explicit
  owner allow-rule), shell-command analysis so an allow rule never silently
  covers chained or dangerous commands, and a **plan approval** panel.

<p align="center">
  <img src="docs/screenshots/permissions.png" width="560" alt="Persistent permission rules (deny / always-ask / allow)" />
</p>

- **Subagents** — parallel role-based workers (researcher / coder / critic /
  librarian) with a live monitor; run them in the background and the agent
  picks up their reports automatically.
- **Memory** — persistent facts the agent saves and recalls itself; review,
  edit or wipe them in settings.
- **Project rules** — an `AGENTS.md` / `CLAUDE.md` in the project root is
  automatically injected into the agent's context.
- **Checkpoints & rollback** — automatic snapshots before agent edits, shown
  as a timeline in the sidebar with per-file diffs; restore any state in one
  click; optional **git auto-commit**.
- **Local models** — Ollama and LM Studio are detected automatically; their
  models are listed in API settings and ready to use in one click.

### Knowledge

- **Knowledge bases (RAG)** — index your documents into a local SQLite FTS5
  index and attach a base to a chat: relevant snippets are injected into
  context automatically. Chunking, search and storage are fully local — no
  embedding APIs, nothing leaves the machine. A "latest search" panel shows
  exactly which snippets were injected.

<p align="center">
  <img src="docs/screenshots/knowledge.png" width="560" alt="Knowledge bases: local RAG on SQLite" />
</p>

- **Vault** — markdown notes with `[[wiki links]]`, a visual knowledge graph,
  and vault tools the agent can read, write and search.

### Voice & media

- **Media mini-bar** — a slim bar over the chat that follows the OS player
  (Spotify desktop, browser tabs): track, pause, switching — no accounts, no
  cloud. Optional synced lyrics from lrclib.net (explicit opt-in).
- **Dictation** — push-to-talk via local whisper.cpp; **Voice Wake** (Jarvis
  mode) — fully offline "Hey Jarvis" wake word; **read-aloud** by local
  Windows SAPI voices. Audio never leaves the machine.
- **Image generation** — an optional `image_generate` agent tool via your own
  image API (off by default).

### Integrations & automation

- **Integrations tab** — Spotify (OS media controls), YouTube (official embed:
  paste a link, queue, popup player) and **Telegram** (experimental): your own
  bot sends task notifications with inline confirm buttons and lets you steer
  the chat from your phone; the bot token lives encrypted in the vault.
- **Automations** — scheduled tasks (daily / weekdays / weekly / interval),
  an **idle queue** for unscheduled work when the engine is free, optional git
  auto-commit and a git-journaled checkpoint history.

<p align="center">
  <img src="docs/screenshots/automations.png" width="560" alt="Automations: scheduled tasks, idle queue, templates" />
</p>

- **MCP** — external Model Context Protocol servers over **stdio and remote
  HTTP**; tools merge into the agent automatically. Live server states with
  failure reasons, lazy reconnects, `${VAR}` expansion, deferred schemas past
  40 tools, opt-in **OAuth** (Authorization Code + PKCE, tokens encrypted).

<p align="center">
  <img src="docs/screenshots/mcp.png" width="560" alt="MCP servers: local processes and remote HTTP" />
</p>

- **Hooks** — shell commands on PreToolUse / PostToolUse / UserPromptSubmit /
  Stop / SessionStart; can block or enrich agent actions.
- **Web search** — an optional `web_search` tool via SearXNG (self-hosted) or
  Brave; pairs with the browser tools for reading full pages.
- **Quick Entry** — a global-hotkey floating input that drops a task into
  Nocturn from anywhere.
- **Import** — bring history from ChatGPT and Gemini exports.

### Providers

Any OpenAI-compatible endpoint, native Anthropic and the **OpenAI Responses
API** (`wire_api=responses`) for Codex-style providers; **import provider
configs** straight from a Codex `config.toml`. **Compare up to three
providers side-by-side on one prompt.**

<p align="center">
  <img src="docs/screenshots/compare.png" width="560" alt="Model comparison: up to three providers on one prompt" />
</p>

### Data & safety

- **Hard Limits** — per-task budgets (tokens, $/1M tokens, $ total) with
  automatic run abortion.
- **Usage overview & Reflect** — local statistics: token activity heatmap,
  daily trend, per-model usage.
- **Crypto vault** — optional AES-256-GCM encryption of API keys with a master
  password; the vault auto-locks after 15 minutes of inactivity.
- **Artifacts** — any ```html block in an answer gets a one-click **sandboxed
  preview** (iframe without same-origin: scripts run, your data stays sealed).
- **GGUF Lab** — local model surgery for R&D: pull GGUF models via your
  Ollama, inspect layers, cut selected layers, and smoke-test the result with
  a local `llama-server` or by importing it back into Ollama. The agent can
  drive the lab through `gguf_inspect` / `gguf_cut` / `gguf_test` tools.
- **Hard Mode** (experimental) — the window becomes a full-screen live PTY
  terminal (xterm.js) wired to your shell; exit by hotkey.

## Themes

Two looks, one toggle — **Settings → Customization**. **Halo** (default): warm
dark palette in the spirit of Claude, 12 dark styles + light, 6 accent presets
+ custom color, glass effects, theme profiles. **Official**: strict black /
grey / white monochrome in the Linear-Vercel spirit, with OLED and contrast
options. Ambient backgrounds: CSS glow, procedural canvas scenes (fog,
snowfall, neon city, starfield, gradient) or your own looped video.

<p align="center">
  <img src="docs/screenshots/customization.png" width="560" alt="Customization: theme profiles, Full Claude and Official themes" />
</p>

Mini-games (2048, Minesweeper, Snake) live in the "Отдых" settings tab for
good measure; settings have live search across all sections.

## Mascot

**Nok** — a pixel firefly on the composer's edge who mirrors the run: streams,
thinks, celebrates, panics, naps after five idle minutes, puts on tiny
headphones when music plays. Poke him (slow clicks pet, fast clicks anger),
right-click for commands, drag him to either corner. Everything repaints from
theme tokens and respects reduced motion.

## Privacy & Security

Nocturn never sends anything anywhere except the API provider **you** configured.
No analytics, no crash reporting, no phone-home. Update checks, lyrics lookups,
model downloads and web search are each gated behind their own toggles.

- **Chats, notes, projects, memory** live on your disk in plain, inspectable
  JSON/markdown; **API keys** can be encrypted (AES-256-GCM + Argon2id).
- **Knowledge bases** are indexed into a local SQLite file; **Code
  Interpreter** runs in a WASM worker with no disk or IPC access; **Artifacts**
  render in a sandboxed iframe.
- **Dictation and read-aloud** run through local processes — audio and text
  never leave the computer.
- **The agent layer** is hardened by regular deep-audit passes: permission
  rules are enforced server-side, the app's own config directory is
  unwritable by the agent, agent file writes are symlink-race-proof, and
  OAuth tokens (if opted into) are stored encrypted.

## Getting started

```bash
npm install          # once
npm run tauri dev    # native window (first Rust build takes a few minutes)
npm run build        # frontend build (tsc + vite)
```

Requirements: **Node 20+** and **Rust** (for the native build).

Windows, Linux and macOS builds are produced automatically for every release —
grab an installer from
[Releases](https://github.com/nocturn-dev/Nocturn/releases). Notes per
platform:

- **Windows** — the most tested platform; in-app auto-update via NSIS/MSI.
- **macOS** — builds are unsigned; on first launch right-click the app →
  *Open*, or allow it in System Settings → Privacy & Security. In-app
  auto-update does not work on unsigned builds — update by downloading a new
  dmg.
- **Linux** — use the `.AppImage` for automatic in-app updates (`.deb`/`.rpm`
  update manually); the UI requires **WebKitGTK 2.40+** (Debian 12+,
  Ubuntu 23.04+, Fedora 38+); Computer Use requires an **X11** session; Quick
  Entry works on Wayland via the GlobalShortcuts portal.

## Project layout

```
src/            React frontend (App, ChatArea, Sidebar, SettingsModal, …)
src-tauri/      Rust side: agent tools, MCP, browser (CDP), PTY, crypto,
                hooks, knowledge bases, dictation, memory
src/locales/    ru / en / zh / ja dictionaries (compiler-checked)
docs/           screenshots
.github/        CI: frontend build + cargo tests on Windows/Linux/macOS
```

## Changelog

Every change — features, fixes, refactors — lands in the commit history with
a `type(scope): message` summary. Releases are cut on `v*` tags; see
[Releases](https://github.com/nocturn-dev/Nocturn/releases) for
per-version installers.

## Contributing

Issues and PRs are welcome. `npm run lint`, `npm test`, `npm run build` and
`cargo clippy --all-targets -- -D warnings` / `cargo test` (in `src-tauri/`)
must pass — GitHub Actions enforces all of them.

## License

[MIT](LICENSE)

## More screenshots

<p align="center">
  <img src="docs/screenshots/prompts.png" width="420" alt="Prompt library with built-in samples" />
  <img src="docs/screenshots/jailbreak-search.png" width="420" alt="Jailbreak library: live search in curated sources" />
</p>
