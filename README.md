# Nocturn

<p align="center">
  <img src="docs/screenshots/main.png" width="820" alt="Nocturn main window: Full Claude theme, mascot Nok on the composer" />
</p>

**Nocturn** is a local-first, BYOK (**Bring Your Own Key**) AI client for
Windows, Linux and macOS (Windows is the most tested).
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
- **Claude-Desktop-level features, locally** — an agent with file, shell, PTY,
  browser, computer-use and Python tools; permission modes; subagents; memory;
  checkpoints; MCP (local and remote); hooks; scheduled automations; local RAG;
  voice input and output — all running on your machine against your key.
- **Provider-agnostic** — any OpenAI-compatible endpoint plus native Anthropic,
  with a fallback model per profile; switch providers mid-project without losing
  history. Compare up to three providers side-by-side on one prompt.
- **Light and local-first** — ~4.4 MB installer, ~100 MB idle RAM, everything
  (chats, projects, notes, knowledge bases, memory) stored on your disk in
  plain, inspectable JSON/markdown/SQLite.
- **Safety rails built in** — permission modes, per-task command allowlists,
  sensitive-path guards and hard token/cost budgets with automatic run abortion.

## What's new in 0.2.x

The jump from 0.1 to 0.2.2 grew the codebase several times over (~93k lines
of TypeScript + Rust today). The highlights, by theme:

### Agent engine
- **Context management for long runs** — old tool results are compacted out
  of the request without an LLM call (microcompact); when the model nears its
  window the conversation head is summarized into a persistent boundary that
  survives restarts (autocompact); an answer cut by the output limit
  continues exactly where it stopped; the task plan is re-injected every few
  steps.
- **Parallel read-only batches** — whitelisted tools (reads, greps,
  screenshots) execute concurrently in ordered chunks; mutating calls keep
  their confirmation gates.
- **Background subagents** keep running after the main run ends and wake the
  engine with their reports automatically (capped continuations).
- **Hard Limits** abort a run on token/$ budgets; a fallback model takes over
  mid-run on 429/5xx.

### Permissions & safety
- **Persistent rules** (deny / always-ask / allow, prefix-based like
  `shell_run(git *)`) enforced on the Rust side in every mode; **shell
  command analysis** so an allow rule never silently covers chained or
  dangerous commands (PowerShell patterns included); a **sensitive-path deny
  class** (`.env`, `.ssh`, credential files — escape only via an explicit
  owner allow-rule); unconditional self-protection of the app's own config
  directory.
- **Symlink-race-proof writes**: agent file writes open the target refusing
  symlinks, re-read the final path from the opened handle and re-run every
  path gate before a byte is written.

### MCP
- **Server states with failure reasons** (stderr tail) instead of silent
  breakage; lazy reconnects on transport errors; `${VAR}` expansion in
  configs; **deferred schemas** past 40 tools with an on-demand discovery
  call; opt-in **OAuth** (Authorization Code + PKCE, single-flight refresh,
  tokens encrypted, zero background requests).

### Knowledge
- Local RAG on SQLite FTS5 (chunking, search and storage run entirely on the
  machine) with a **"latest search" panel** showing exactly which snippets
  were injected; WAL and busy timeouts so indexing never breaks live queries.

### Media & integrations
- **Spotify mini-bar** over the chat with synced lyrics — and a **lyrics
  ribbon rendered behind the interface**; a **YouTube player** (official
  embed, popup window + mini-bar control, queue); a **Telegram bot** — task
  notifications with inline confirm buttons and chat control from the phone
  (experimental); offline **voice wake** ("Hey Jarvis"), push-to-talk
  dictation and local read-aloud.

### Automation
- Scheduled tasks, an **idle queue** for unscheduled work when the engine is
  free, optional git auto-commit and a **git-journaled checkpoint history**,
  workflow scenarios with step interpolation.

### Chat UX
- **Checkpoint timeline** with per-file diffs in the sidebar; one-click
  **branch review** handed to the agent as a strict review task; **editable
  Mermaid** diagrams (tweak the source, send the edit back to the composer);
  quote-into-composer, message navigation, smooth streaming with adjustable
  print speed.

### Providers
- Any OpenAI-compatible endpoint, native Anthropic — and now the **OpenAI
  Responses API** (`wire_api=responses`) for Codex-style providers; **import
  provider configs** straight from a Codex `config.toml`; compare up to three
  providers side-by-side on one prompt. **Local runtimes** — Ollama and LM
  Studio are detected automatically in API settings, with their models listed
  and ready to use in one click.

### Mascot
- **Nok** — a pixel firefly on the composer edge who mirrors the run:
  streaming, thinking, celebrating, panicking, napping, wearing headphones
  when music plays; 16 event-triggered quip decks, a draggable perch, full
  theme repaint.

### Under the hood
- Incremental markdown parsing and throttled stream updates (O(1) print
  ticks), lazy-loaded modals and terminals, incremental context estimates,
  deferred startup parsing — the ~4.4 MB installer stays light at ~100 MB
  idle RAM.

## Features

### Chat & agent

- **Streaming chat** with any OpenAI-compatible provider or native Anthropic;
  markdown, syntax highlighting, **Mermaid diagrams** (editable source —
  tweak the diagram by hand and send your edits back to the composer),
  citation of any tool result, quote-into-composer by selection.
- **Branch review** — a button in the chat header collects the diff against
  a base branch and hands it to the agent as a strict code-review task
  (findings by severity, verdict, no code changes) before you merge or push.
- **Agent mode** with tools: files (read/write/grep/list), shell, live **PTY
  terminal**, **Browser Use** via CDP (navigate, read, screenshot, click — with
  a live view panel), **Computer Use** (screen capture, mouse, keyboard),
  image generation, and **Code Interpreter** — Python 3 via Pyodide (WASM) in a
  sandboxed worker: no disk, no IPC, stdout/stderr go back to the model.
  Read-only calls run in parallel batches; permission and deny checks stay
  enforced on the Rust side.
- **LSP diagnostics loop** — a read-only `lsp_diagnostics` tool (language
  servers over stdio, spawned lazily per language) and automatic diagnostics
  attached to every `fs_write` result: edit → compile errors in the same turn
  → the model fixes them immediately, no extra `tsc`/`cargo check` shell call
  needed. Diagnostics are best-effort and never break an edit; project-root
  and sensitive-path gates apply like any file tool.
- **Context management for long runs** — old tool results are compacted away
  (microcompact) and the conversation is summarized into a persistent boundary
  when the model nears its window (autocompact); a response cut by the output
  limit continues automatically from where it stopped, and the agent gets a
  plan reminder every few steps.
- **Permission modes** (Plan / Ask / Edit / Full) with **persistent rules**
  (deny / always-ask / allow, prefix-based like `shell_run(git *)`), a
  sensitive-path deny class (`.env`, `.ssh`, `.git/config` — overridable only
  by an explicit owner allow-rule), unconditional self-protection of the app's
  own config directory, and shell-command analysis (an allow rule never
  silently covers chained or dangerous commands). Plus per-task command
  allowlists with "always for this task" memory and a **plan approval** panel
  in Plan mode. Rules live in Settings → Permissions.
- **Edit & resend with branching** — editing any message forks a new session;
  the original stays intact and one click returns you to it.
- **Subagents** — parallel role-based workers (researcher / coder / critic /
  librarian) with a live monitor next to the send button. Run them in the
  background: when one finishes, the agent picks up its report automatically —
  and if the run has already ended, a new one starts by itself (capped at
  three auto-continuations per task).
- **Local models** — Nocturn detects local runtimes (Ollama, LM Studio)
  automatically and lists their models in API settings; picking one fills in
  the endpoint for you (ports 11434 / 1234).
- **Memory** — persistent facts the agent saves and recalls itself
  (`memory_save` / `memory_recall`); review, edit or wipe them in settings.
- **Project rules** — an `AGENTS.md` / `CLAUDE.md` in the project root is
  automatically injected into the agent's context.
- **Checkpoints & rollback** — automatic snapshots before agent edits, shown
  as a timeline in the sidebar (expand any snapshot to see which files it
  holds and how they changed since), restore any state in one click;
  optional **git auto-commit** before edits.

### Knowledge

- **Knowledge bases (RAG)** — index your documents (markdown, code, logs, CSV…)
  into a local SQLite FTS5 index and attach a base to a chat: relevant snippets
  are injected into context automatically. Chunking, search and storage are
  fully local — no embedding APIs, nothing leaves the machine. A "latest
  search" panel shows exactly which snippets were injected (or why nothing
  was found) — no more guessing what the agent can and cannot see.
- **Vault** — markdown notes with `[[wiki links]]`, a visual knowledge graph,
  and vault tools the agent can read, write and search.

### Voice & media

- **Media mini-bar** — a slim bar over the chat that follows the OS player
  (Spotify desktop, browser tabs): track, elapsed time, pause and track
  switching via the system media controls — no accounts, no cloud. Optional
  synced lyrics from lrclib.net (explicit opt-in: only the track title and
  artist are looked up), auto-follow highlight in theme accent or a custom
  color.
- **Dictation** — push-to-talk via a local whisper.cpp (the model downloads on
  first use, microphone is selectable).
- **Voice Wake (Jarvis mode)** — optional always-on local wake word
  (openWakeWord, fully offline): say "Hey Jarvis" and dictate a task
  hands-free. Audio never leaves the machine.
- **Read-aloud** — answers spoken by local Windows SAPI voices, ru/en
  auto-selected. No cloud speech anywhere.
- **Image generation** — an optional `image_generate` agent tool via your own
  image API (off by default).

### Automation & integration

- **Integrations tab** — a dedicated settings tab for local integrations,
  gated by a one-time transparency warning: everything runs through WinAPI
  on your machine. **Spotify** (desktop client via OS media controls +
  window-title fallback) and **YouTube** (official `youtube-nocookie` embed:
  paste a link, queue, collapsible popup player feeding the same mini-bar)
  are mutually exclusive — one active integration at a time. **Telegram**
  (experimental) — your own bot sends task notifications with inline
  confirm buttons and lets you steer the chat from your phone; the bot
  token lives encrypted in the vault.
- **Automations** — scheduled tasks (daily / weekdays / weekly / interval): the
  agent starts a chat and runs the prompt on schedule; optional keep-awake.
- **MCP** — external Model Context Protocol servers over **stdio and remote
  HTTP** (streamable); tools merge into the agent automatically. Servers show
  live states with failure reasons (stderr tail) instead of silent breakage,
  reconnect invisibly when a session expires, and support `${VAR}` environment
  expansion in their config. Past 40 tools, schemas are deferred behind an
  MCP tool-discovery call to keep the context lean. Optional **OAuth**
  (Authorization Code + PKCE) for hosted servers — strictly opt-in: nothing
  is requested until you press Authorize, tokens are stored encrypted, and
  refresh is single-flight under parallel 401s.
- **Hooks** — shell commands on PreToolUse / PostToolUse / UserPromptSubmit /
  Stop / SessionStart; can block or enrich agent actions.
- **Web search** — an optional `web_search` tool via SearXNG (self-hosted) or
  Brave; pairs with the browser tools for reading full pages.
- **Plugins & packs** — a plugin system with roles, prompts, skills and packs
  (hooks/MCP bundles) you can import and export as one file.
- **Quick Entry** — a global-hotkey floating input that drops a task into
  Nocturn from anywhere (X11 uses XGrabKey natively; on Wayland the hotkey
  goes through the GlobalShortcuts portal).
- **Import** — bring history from ChatGPT and Gemini exports.

### Data & safety

- **Hard Limits** — per-task budgets (tokens, $/1M tokens, $ total) with
  automatic run abortion.
- **Usage overview & Reflect** — local statistics: token activity heatmap,
  daily trend, per-model usage; a one-shot model "reflection" over your local
  summary, savable as a note.
- **Crypto vault** — optional AES-256-GCM encryption of API keys with a master
  password; the vault auto-locks after 15 minutes of inactivity.
- **Artifacts** — any ```html block in an answer gets a one-click **sandboxed
  preview** (iframe without same-origin: scripts run, your data stays sealed).
- **Hard Mode** (experimental) — Nocturn hides away and the window becomes a
  full-screen live PTY terminal (xterm.js) wired to your shell; exit by hotkey.
- **GGUF Lab** — local model surgery for R&D: pull GGUF models via your
  Ollama, inspect layers, cut selected layers (per-layer metadata is
  remapped by index, SWA phases and MTP tails are handled), and smoke-test
  the result with a local `llama-server` or by importing it back into
  Ollama — without leaving Nocturn. Surgery output is re-parsed and its
  surviving tensor bytes are verified byte-for-byte; blob exports are
  hash-checked. The agent can drive the lab through
  `gguf_inspect` / `gguf_cut` / `gguf_test` tools; GGUF artifacts also appear
  in the storage manager with a dedicated cleanup.

## Settings: deeper than it looks

Nocturn keeps its power in settings rather than in your face:

- **20+ sections in 6 groups** — Основное / Профиль / Кастомизация / API /
  Browser Use / Computer Use / Горячие клавиши · Память / Субагенты / Плагины /
  MCP / Права / LSP-диагностики / Изображения / Промпты / Скиллы / Команды /
  Хуки · Сеть / Обзор · Отдых / Маскот · Справка — plus standalone surfaces
  (knowledge bases, knowledge graph, automations, model comparison, usage
  statistics, storage manager).
- **Dozens of settings in Customization alone**: 12 dark theme styles + light +
  **Official**
  monochrome (with OLED and contrast options), 6 accent presets +
  custom color + per-project accent, glass effects with a blur slider,
  ambient backgrounds, wallpapers, UI scale, radius, message scale, motion
  speed, smooth streaming with adjustable print speed, fonts for UI / code /
  terminal (including local font import), custom CSS, terminal shell and
  palette, app mark, **theme profiles** — and mini-games (2048, Minesweeper,
  Snake) in the "Отдых" tab for good measure.
- **Search across all settings** — type a few letters, jump to the exact
  section with the item highlighted.

## Screenshots

<p align="center">
  <img src="docs/screenshots/customization.png" width="420" alt="Customization: theme profiles, Full Claude and Official themes" />
  <img src="docs/screenshots/permissions.png" width="420" alt="Persistent permission rules (deny / always-ask / allow)" />
</p>
<p align="center">
  <img src="docs/screenshots/mcp.png" width="420" alt="MCP servers: local processes and remote HTTP" />
  <img src="docs/screenshots/knowledge.png" width="420" alt="Knowledge bases: local RAG on SQLite" />
</p>
<p align="center">
  <img src="docs/screenshots/compare.png" width="560" alt="Model comparison: up to three providers on one prompt" />
</p>
<p align="center">
  <img src="docs/screenshots/automations.png" width="560" alt="Automations: scheduled tasks, idle queue, templates" />
</p>
<p align="center">
  <img src="docs/screenshots/prompts.png" width="460" alt="Prompt library with built-in samples" />
  <img src="docs/screenshots/jailbreak-search.png" width="460" alt="Jailbreak library: live search in curated sources" />
</p>

## Themes

Two looks, one toggle — **Settings → Customization**. The theme applies
instantly and is remembered.

| Theme | What it is |
|---|---|
| **Halo** (default) | Warm dark palette in the spirit of Claude: 12 dark styles + light, 6 accent presets + custom color, glass effects, theme profiles. |
| **Official** | Strict black / grey / white monochrome in the Linear-Vercel spirit. Hierarchy comes from brightness and borders, color is reserved for semantics — diffs, tool statuses, errors. Extras: true-black OLED background, higher-contrast mode, greyscale code highlighting. Always dark, opt-in. |

Ambient backgrounds come in two flavours: the CSS "breathing accent" glow, or
procedural canvas scenes — fog, snowfall, neon city, starfield, gradient — and
your own looped video. Scene palettes are fixed night scenes (the gradient
scene takes your two custom colors) — they are deliberately theme-independent.

> **A note on ambient video backgrounds:** a looping video behind the chat
> looks great, but the decoder keeps using GPU/battery while it plays.
> Playback pauses automatically while the agent is streaming and when the
> window is minimized, yet on battery-powered laptops the procedural scenes
> are the friendlier choice. Keep custom clips short (~50 MB) and dim — the
> app adds a dark overlay on top for text readability.

## Mascot

**Nok** — a pixel firefly who lives on the composer's edge (Settings →
«Маскот», on by default). He is not decoration: he mirrors what the agent is
doing. He flies to the text while streaming, leans in while thinking, bursts
confetti when a run finishes, panics (red lamp) when it fails, raises a
question mark when the agent waits for your answer, naps after five idle
minutes, and — when music plays — puts on tiny headphones. Left alone he
amuses himself: floats thought-bubbles, "writes code" on a tiny laptop,
tumbles off the edge ("learned to fly"), or jumps at you from the sidebar.

Poke him: slow clicks are petting (hearts, warmer glow), fast clicks build an
anger ladder until he storms off screen and returns sulking. Right-click
gives commands — fly around, come home, sleep, hide until restart — and you
can drag him to either corner of the composer. Type "Hey Nok, fly" in the
chat and he takes a lap over your messages (easter eggs never reach the
model). Everything repaints from theme tokens, so he fits all 13 looks,
respects reduced motion, and — yes — he has opinions about `rm -rf`.

## Privacy & Security

Nocturn never sends anything anywhere except the API provider **you** configured.
Prompts, files and tool results go straight to your endpoint; there is no
analytics, no crash reporting, no phone-home. Concretely:

- **Update checks are opt-in** — the app asks GitHub for a new version only
  if you enabled it in Settings; otherwise it contacts nothing but your
  configured endpoints (lyrics lookups, model downloads and web search are
  equally gated behind their own toggles).

- **Chats, notes, projects, memory** live on your disk in plain, inspectable
  JSON/markdown.
- **API keys** can be encrypted with a master password (AES-256-GCM + Argon2id);
  an encrypted vault auto-locks after 15 minutes of inactivity.
- **Knowledge bases** are indexed into a local SQLite file; search runs entirely
  on this machine (no embedding APIs).
- **Code Interpreter** runs Python in a WASM worker with no disk or IPC access;
  **Artifacts** render in a sandboxed iframe without same-origin.
- **Dictation and read-aloud** run through local processes (whisper.cpp / Windows
  SAPI) — audio and text never leave the computer.
- **The agent layer** is hardened by regular deep-audit passes (permission
  checks, sensitive-path guards, command allowlists, tool-output handling).
  Permission rules are enforced server-side, the app's own config directory is
  unwritable by the agent, agent file writes are symlink-race-proof (the file
  is opened refusing symlinks and its true location is re-validated against
  the sensitive-path and project-roots gates before anything is written), and
  OAuth tokens (if you opt into an OAuth MCP server) are stored encrypted.

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
[Releases](https://gitlab.com/nocturn-lab1/Nocturn-AI/-/releases). Notes per
platform:

- **Windows** — the most tested platform.
- **macOS** — builds are unsigned; on first launch right-click the app →
  *Open*, or allow it in System Settings → Privacy & Security.
- **Linux** — use the `.AppImage` for automatic in-app updates (`.deb` updates
  manually); the UI requires **WebKitGTK 2.40+** (Debian 12+, Ubuntu 23.04+,
  Fedora 38+ — older versions silently degrade glass/ambient effects);
  Computer Use (screen capture / input) requires an **X11** session;
  Quick Entry global hotkey works on Wayland via the GlobalShortcuts portal
  (on Wayland the overlay's position and always-on-top are compositor-owned —
  it may appear where the compositor places it rather than top-center).

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
[Releases](https://gitlab.com/nocturn-lab1/Nocturn-AI/-/releases) for
per-version installers.

## Contributing

Issues and PRs are welcome. `npm run lint`, `npm test`, `npm run build` and
`cargo clippy --all-targets -- -D warnings` / `cargo test` (in `src-tauri/`)
must pass — GitLab CI enforces all of them (`.github/` workflows are kept
for reference only; the GitHub account is frozen).

## License

[MIT](LICENSE)
