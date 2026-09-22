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

## Reporting

Please open a GitHub issue for anything security-related you find. For
sensitive reports, contact the maintainers privately first.
