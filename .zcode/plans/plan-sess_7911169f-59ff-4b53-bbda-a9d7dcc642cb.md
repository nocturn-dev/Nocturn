# План исправлений Nocturn-AI: все находки аудита (60+)

Вердикт аудита принят полностью: волны 1–4 + бэклог, регресс-тест на каждый фикс, дефолты безопасности ужесточаются. Порядок: волна 1 → 2 → 3 → 4 → 5 (бэклог), после каждой волны — гейты `cargo test` + `vitest run` + `eslint` + `clippy` + `tsc && vite build` и отдельный коммит (стил репозитория — conventional commits).

---

## Волна 1 — Критичные фиксы корректности и безопасности (RCE, потеря данных, молчащие no-op)

1. **`reasoning_effort` теряется в IPC** — `src/api.ts:323`: ключ `reasoning_effort` → `reasoningEffort`. Проверка: слайдер из SettingsModal попадает в тело запроса (логика уже в chat.rs:245).
2. **Потеря параллельных tool-calls Anthropic** — `src-tauri/src/chat.rs` (`AnthropicAccumulator`): накапливать tool_use по `content_block_stop` в векторе, эмитить **один** `ToolCallsFinished` со всеми вызовами на `message_delta` (контракт = OpenAI-путь). Тест: два блока tool_use → одно событие с 2 вызовами.
3. **Двойной подсчёт prompt-токенов Anthropic** — там же: убрать Usage-событие из `message_start`, оставить единственное абсолютное в `message_delta`. Тест обновить.
4. **400 от Anthropic на tool-истории** — `chat.rs` `build_anthropic_body`: группировать подряд идущие `role:"tool"` в одно user-сообщение с несколькими `tool_result`. Тест на группировку.
5. **TypeError на пустом массиве calls** — `src/hooks/useAgentRun.ts:844`: guard `calls.length === 0` в `onToolCalls`.
6. **RCE через импорт настроек** — `settings.rs` `settings_write_all`: новый параметр `allow_executable_configs: bool`; без него запись `hooks.json`/`mcp.json` отклоняется. `SettingsModal` (импорт): при наличии этих файлов в payload — диалог подтверждения со списком устанавливаемых команд/серверов, флаг передаётся только после явного «да».
7. **Сломанный regex frontmatter** — `src/vault.ts:86`: `([\[\s\S]*?])` → корректный `([\s\S]*?)`. Тест: `agent: true` распознаётся, frontmatter не уходит в промт.
8. **CRLF ломает diff** — `src/diff.ts`: нормализация `\r\n`→`\n` перед `split("\n")`. Тест: файл с CRLF не красится целиком.

## Волна 2 — Производительность стриминга (возвращает FPS)

1. **Батчинг дельт** — `useAgentRun.ts` `appendTo`: дельты (контент и thoughts) копятся в ref, сброс в `setSessions` одним обновлением раз на rAF (~16 мс); немедленный flush на tool-calls/usage/finalize/stop/ask. Логика сброса — чистая функция + vitest.
2. **`useLang`** — `src/locales.tsx:85`: `t` через `useCallback([lang])`, value контекста — `useMemo`. Починит все memo/effect с `t` в deps.
3. **Мемоизация карточек** — `React.memo` для AssistantCard, ToolStepCard, SubagentCard, UserCard, ChangedFilesCard; массивы `remarkGfm`/`rehypeHighlight` — константы уровня модуля; нестабильные props (`files={[...writes.values()]}`, `merged`, `results`) — `useMemo` в ChatArea.
4. **Дифф из рендера** — ToolStepCard: `diffLines` в `useMemo([write])`; ChangedFilesCard: один проход LCS вместо двух; ChatArea IIFE (`parseWriteResult`/Map writes) — `useMemo` по сообщениям хода.
5. **Хоты на каждый токен** — SearchModal: guard `!open` внутри useMemo (поиск не считается для закрытой модалки); ChatArea `contextEstimate`/`totals`/`visible` — `useMemo`; Sidebar `visible`/`sorted`/`projectGroups` — `useMemo`; App `enabledPlugins`/`agentAllowlists`/`menuItems` — `useMemo`.
6. **Автосейв** — App.tsx `flush`: при активном стриме пропуск stringify (остаётся dirty), форс-flush на finalize; простой стрим — прежний интервал 3 с.
7. **Прочие ререндеры** — drag-ресайз (App.tsx:509): rAF-троттлинг mousemove; ChainMonitor: убрать 600мс setTick (пульс уже в CSS); MessageNav: rAF-троттлинг scroll-хендлера + `ticks` в useMemo; NotesModal: превью по debounce + cleanup таймера подтверждения.

## Волна 3 — Кроссплатформа и устойчивость Rust

1. **PTY на macOS/Linux** — `pty.rs build_shell_command`: `#[cfg(windows)]` powershell/cmd/gitbash; unix: `$SHELL` → bash → zsh → sh.
2. **MCP `npx` на Windows** — `mcp.rs connect`: при фейле прямого spawn (program not found) — retry через `cmd /C` (паттерн hooks.rs:138). Тест с mcp_echo_helper.
3. **Браузер на macOS** — `browser.rs find_browser_executable`: кандидаты `/Applications/Google Chrome.app/...`, Microsoft Edge, Brave.
4. **Блокирующий I/O с воркеров tokio** — обёртка `tauri::async_runtime::spawn_blocking` для: mcp_connect/autoconnect, запуск браузера и view_size (плюс таймаут CDP 120с → 10с), checkpoint_save, git_status, fs imagegen, чтение CA в network.rs, plugin_read/crypto_status/crypto_reset → `(async)`.
5. **Атомарная запись конфигов** — helper `atomic_write_json` (temp + rename) во всех точках: settings.rs, mcp.rs, tooling.rs, plugins.rs. Тест helper'а.
6. **crypto.rs** — `hex_decode` без слайсинга по char-границам (as_bytes + from_str_radix); `expect` в derive_key → `Result`. Тест на битый ввод.
7. **proc.rs** — ветка `Err(try_wait)` → kill + wait (без сирот).
8. **lib.rs** — ошибка трея не валит `setup` (лог + продолжение); `mcp_connect`: guard-набор «connecting» против двойного спавна.
9. **Single-instance** — подключить `tauri-plugin-single-instance` (вторая копия фокусирует существующее окно; заодно закрывает конфликт cleanup_browser_profiles).

## Волна 4 — Гонки движка агента + UX-безопасность

1. **Гонка параллельных прогонов** — `useAgentRun.ts`: guard на входе `handleSend` (early return при живом `activeRunRef`); `finalize` сбрасывает общие индикаторы только при `activeRunRef.current === requestId`; `runChain` (App.tsx:1444) и тик автоматизаций проверяют занятость движка. `handleStop`: точечное клонирование целевой сессии вместо всех.
2. **Stop убивает исполняющийся инструмент** — `run_tool` принимает `requestId`; proc.rs в цикле чтения опрашивает AbortRegistry (каждые ~100 мс) и убивает ребёнка; хуки и MCP-вызовы проверяют флаг перед стартом.
3. **Хуки с `timeout: 0`** — `hooks.rs`: потолок 3600 с вместо `Duration::MAX` + учёт abort-флага.
4. **«Забыли пароль»** — CryptoGate: требование ввести «RESET» перед `cryptoReset` (один промах мыши больше не стирает ключи).
5. **Машинный статус отказа субагента** — `useAgentRun.ts:1183`: `subStatus = "denied"`.
6. **Ссылки из markdown** — AssistantCard: `components={{ a }}` → `target="_blank"` + `rel="noopener noreferrer"` (вебвью не уводится на внешние сайты).

## Волна 5 — Ужесточение дефолтов + бэклог (выбрано «всё»)

**Безопасность (дефолты):**
1. **subagents.ts** — `vault_write` удалён из READ_ONLY; MCP-инструменты (`mcp__*`) убраны из дефолтного пула субагентов (только явный allowlist в роли). `image_generate` — в mutating-список фронта (подтверждение как у записи).
2. **SSRF-защита браузера** — `browser.rs is_navigable_url`: блок private/loopback/link-local диапазонов (IPv4+IPv6, с резолвом хоста); настройка `allowPrivateNetworks` в browser.json (по умолчанию выкл), тумблер в SettingsModal/Browser.
3. **Vault idle-lock** — авто-запирание после настраиваемой неактивности (дефолт 15 мин, 0 = выкл): zeroize ключа, специфичная ошибка → фронт снова показывает CryptoGate. Пароль и миграционные копии — zeroize.
4. **Шифрование по умолчанию** — новые установки: `encrypt_keys=true` (гейт при первом запуске, «Пропустить» = осознанный plaintext); `#[cfg(unix)]` chmod 600 на все конфиг-файлы через atomic_write helper.
5. **perm.rs на Unix** — сравнение путей регистрозависимое вне Windows (cfg), снимает case-коллизию; `checkpoints_dir` — без lowercase на Unix.
6. **`rejects_sensitive_path`** — канонизация + проверка `Component::ParentDir` (по образцу sound_import); `plugin_read` ограничен каталогом плагинов.
7. **MCP stdout** — лимит строки 8 МБ (превышение = kill сервера); `pty_write` — ограничение параллельных блокирующих вызовов (semaphore 8).

**Фронт-мелочи:**
8. TerminalPanel: кольцевой буфер 2000 строк (чистая функция + тест), сброс при смене сессии, clamp `cursorRef` после edit-message.
9. **Slash-команды stale closure** (App.tsx:1693): handlers через refs, `activeId` в deps — `/clear` бьёт по активной задаче.
10. SessionStart — подключить реальный вызов в `handleSend` (additionalContext мержится, как UserPromptSubmit).
11. api.ts: try/catch на localStorage-парсинг, cleanup таймера в catch detectOllama; дубли `ToolCallInfo` (→ types.ts) и `uid` (→ utils) устранены; `saveAutomations` дважды — фикс; мёртвый проп `AgentRunDeps.sessions` удалён; чистые предикаты движка (`mutatingTool`, usage-аккумулятор) вынесены и покрыты тестами.
12. `as never` (12 мест) — централизованный типизированный хелпер ключей с dev-предупреждением; index-key в PlanPanel/DiffView/ContextMenu — составные стабильные ключи; hljs-темы: light/dark скоупятся селектором темы.
13. git_status: разворачивание git-экранирования путей (тест); updater при deb — понятная ошибка в UI; magic numbers (MAX_STEPS, trim 30, max_tokens 8192, slice 20000) — именованные константы.

**Тест-покрытие (добавляемое):** vault frontmatter, diff CRLF, atomic_write, hex_decode, git_status unescape, perm case-sensitivity (unix-cfg), Anthropic (multi-tool-call / usage / grouping), TerminalPanel ring-buffer, чистые функции useAgentRun (flush-буфер, mutatingTool, usage-acc), хуки timeout clamp.

## Принятые риски (фиксировать в отчёте, не чинить)
- Внуки-процессы при таймауте shell (Windows Job Objects — тяжело, graceful-слив уже есть).
- DNS rebinding против SSRF-фильтра (residual, документируем).
- CDP на 127.0.0.1 доступен локальным процессам (документируем в тултипе Browser-настроек).

## Верификация
- После каждой волны: `cargo test` (юнит + e2e MCP), `cargo clippy`, `vitest run`, `eslint`, `tsc && vite build` — все зелёные.
- Коммит после каждой волны: `fix(critical): …`, `perf(stream): …`, `fix(platform): …`, `fix(engine): …`, `harden(security): …`.
- Финал: сводный отчёт — что исправлено, какие тесты добавлены, что осознанно не чинилось.