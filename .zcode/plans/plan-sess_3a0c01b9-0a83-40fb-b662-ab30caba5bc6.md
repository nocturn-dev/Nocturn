# ПЛАН ФИКСОВ Nocturn-AI v0.2.2 (все 80+ находок аудита)

Ветки: `fix/audit-wave-N`, коммит после каждой волны. Решения пользователя: иконки → локальный SVG-бандл; сплит SettingsModal → отложен; вложения → лёгкий фикс.

## Волна 0 — Страховочная сетка
1. Бейслайн: `cargo test` + `cargo clippy`, `npm test`, `tsc && vite build`, `eslint src` — зафиксировать текущее состояние.
2. Регресс-тесты ДО правок: `proc::read_capped` >256 КБ (A5), `path_allowed` регистр (A8), матрица `perm::decide` plan/ask/full × computer_*/vault_write/mcp (A4), `atomic_write` два писателя (B11), dedup usage (A6), thinking-блоки roundtrip (A2).

## Волна 1 — Критическая безопасность
- **B1** `settings.rs::settings_export_write` — запрет записи в app_config_dir (hooks.json, mcp.json, crypto.json, profiles.json) иначе чем через `settings_write_all` с `allow_executable_configs=true`; тот же гейт, что у импорта.
- **B2** `browser.rs::is_private_host` — заменить самодельный парсинг на `url`-крейт: хост из `url.host_str()`, strip userinfo, раскрытие целочисленных/hex IPv4 (`2130706433`, `127.1`, `0x7f000001`), IPv4-mapped IPv6 (`::ffff:a.b.c.d` и hex), блок loopback/link-local/metadata (169.254.169.254).
- **A4** `perm.rs::decide` — Plan: deny `computer_*`, `vault_write`, `mcp__*` (в ask — подтверждение, в full — авто); `tooling.rs::run_tool` — перенести `perm::decide` ПЕРЕД PreToolUse-хуками; Ask-режим: `fs_delete`/`shell_run` проходят тот же path-контроль, что и остальные (не `Ok(())`).
- **B3** `settings.rs::rekey_all` — транзакция: оба файла в temp, `.bak`-копии оригиналов, swap только после успеха обоих, `crypto_write_meta` последним; при сбое — откат из .bak.
- **B4** `crypto.rs` — `Zeroizing<String>` для мастер-пароля (убрать клон в `crypto_unlock:204`); активный idle-таймер: фоновая задача раз в минуту проверяет `vault_idle_expired` и выгружает ключи из памяти.
- **B5** `files.rs::checkpoint_restore_impl` — перед записью проверить каждого предка пути через `symlink_metadata`: любой symlink/junction в цепочке → отказ.
- **B6** `settings.rs::rejects_sensitive_path` — сравнение по компонентам пути (не `contains`), нормализация 8.3-имён и хвостовых точек; на Unix — собственный список (/etc, /proc, ~/.ssh); переиспользовать в checkpoint_restore.
- **B7** `settings.rs::settings_read_all` — параметр `include_secrets` (default false): маскировать `api_key` в profiles/settings при экспорте; фронт: явный чекбокс + предупреждение.
- **D1** `TerminalPanel.tsx:400-439` — ранний `return` при `e.ctrlKey||e.metaKey||e.altKey` в обработчике y/a/n.

## Волна 2 — Abort/стриминг (ядро агента)
- **A1** `tooling.rs::run_tool` — если `request_id` задан, а записи в реестре нет: зарегистрировать свежий `Arc<AtomicBool>` (RAII-guard на время тулл-кола) → `chat_abort(request_id)` убивает и исполняющийся инструмент; проверка флага внутри длинных инструментов (shell poll уже есть).
- **C11** `subagents.ts:216` — передавать `requestId` в `runTool`; `useAgentRun` — трекать id субагентов и звать `chat_abort` по всем при Stop.
- **A2** Anthropic thinking: `chat.rs` — в `AnthropicAccumulator` копить `signature_delta`; в `ChatMessage` (155) добавить `thinking: Option<Value>` (блок `{thinking, signature}`); `build_anthropic_body` — эмитить thinking-блоки перед tool_use; фронт `useAgentRun` — передавать `Message.thought`+signature в историю; при trim старых ходов thinking срезать.
- **A3** `tooling.rs` MCP-ветка — обёртка `tokio::time::timeout(CALL_TIMEOUT)` + `select!` по abort-флагу.
- **A7** `chat.rs::SseAccumulator::flush` (OpenAI) — эмитить накопленные tool_calls при любом завершении стрима, не только по `finish_reason`.
- **A6** `chat.rs::feed` — usage эмитить один раз (финальный чанк); фронт — суммировать только финальное событие.
- **A16** `chat.rs` — при занятом request_id: поднять флаг старого и заменить запись; `is_anthropic_base` → явный `provider` из настроек фронта (не substring).
- **A9** `chat.rs` — idle-таймаут 120→300 с для reasoning (config), сброс на любой SSE-байт; `stream_options`: при 400 с упоминанием поля — один ретрай без него.
- **C5** `useAgentRun.ts:683-695` — tool-результат с пустым content заменять на `"(empty)"`, никогда не выбрасывать; `trimContextWindow` — резать только целые пары assistant.tool_calls+tool.
- **B9** `mcp.rs::write_line` — запись в отдельном таске c таймаутом через канал; по таймауту — kill сервера.
- **B10** `mcp.rs::kill` — Windows: Job Object (win32job crate) либо `taskkill /PID x /T /F`; kill → wait.

## Волна 3 — Гонки и целостность данных (фронтенд)
- **C1** `handleSend` — захват `activeRunRef` синхронно ДО await хуков (placeholder-claim, освобождение при валидационном отказе).
- **C2** `handleStop` — не обнулять `activeRunRef` синхронно; флаг `stopping`, release только в finalize при `cur===requestId`; `cancelInteractions` — только свои interaction-id.
- **C3** `finalize` дренаж — если handleSend отказал, вернуть сообщение в голову очереди.
- **C4** `App.tsx:654-717` — загрузка: блокировать send до hydration (уже есть guard) + `setSessions` функционально с merge dirty-сессий; аналогично profiles/settings.
- **C10** `runChain` — атомарный claim (handleSend возвращает bool «стартовал»); `finally` — owner-проверка `streamingId===chainRunId`.
- **C12** `handleDelete/handleClearChat` — сначала stopRun(sessionId) (abort + дождаться finalize), потом удаление.
- **C13** `handleUseLocalModel` — `setApiSettings(prev => ({...prev, ...}))`.
- **C14** сериализация сейвов через promise-chain (saveQueue ref); `.catch` → тост об ошибке + пометка dirty для ретрая.
- **C15** уведомление «модель изменена» — только в обработчике ручной смены модели, не в effect.
- **C16** `handleAddProfile` → `crypto.randomUUID()`; `handleSaveNote` — try/catch + тост; `refreshNotes` — `Promise.all` с per-item catch.
- **B11** `fsutil.rs::atomic_write` — temp-имя pid+random (create_new), чистка stale .tmp при старте.

## Волна 4 — Надёжность бекенда
- **A5** `proc.rs::read_capped` — после CAP продолжать дренировать пайп (discard/ring-tail), не break → exit-код сохраняется, SIGPIPE нет; тест с 300 КБ.
- **A8** `perm.rs::path_allowed` — lowercase и на macOS (`cfg(target_os="macos")`, APFS case-insensitive).
- **A10** `hooks.rs` — `timeout: 0` → skip хука (не 3600 с); кэш hooks.json по mtime; blocked только при явном decision=block (не любой nonzero exit).
- **A12** `chat.rs::take_complete_lines` — однопроходный дренаж (индекс старта, один `drain` на чанк).
- **A13** `network.rs::apply` — fs::read в `spawn_blocking`.
- **B8** `settings.rs`/`plugins.rs`/`notes.rs` — все `read_to_string` через capped-reader (32 МБ); `plugin_read`, `crypto_status`, `crypto_reset` → `async fn` + spawn_blocking (Tauri 2 sync-команды на main thread).
- **B12** `browser.rs` — имя профиля с uuid, удаление профиля при stop; CDP с токеном в path; free_port — retry при занятом bind.
- **B13** `imagegen.rs` — Content-Length cap 20 МБ, приватные IP под фильтр для img_url, имя `img-{uuid8}`.
- **B15** `pty.rs` — kill+wait в отдельном треде; удаление сессии из реестра по pty-exit.
- **B16** `files.rs::git_status_impl` — `-c core.quotepath=false`; таймаут через spawn+wait_timeout.
- **B18** `mcp.rs::spawn_server` — CREATE_NO_WINDOW для прямого спавна.

## Волна 5 — Производительность
- **C6** ask_user/handleAskAnswer — клонировать только целевую сессию (как в FIX-местах).
- **C7** `modifiedFiles` useMemo — считать по [длина messages, id последнего fs_write], не по всему activeSession; `agentAllowlists` аналогично.
- **C8** App render — модалки монтировать условно `{open && <SettingsModal/>}` (Settings/Search/Notes/Automations/BrowserPanel).
- **C9** стабилизация пропсов: handleSend/handleStop/onAskAnswer/onConfirmDecision → useCallback; pendingConfirm/pendingAsk, queued, availableCommands → useMemo; ChatArea/Sidebar/SettingsModal → React.memo.
- **C17** `scheduleFlush` — fallback `setTimeout(250)` когда `document.hidden`.
- **C20** `diff.ts` — пре-чек схожести (общий префикс/суффикс O(n)) → wholeReplace при низком коэффициенте; переиспользование строк матрицы.
- **D5** автоскролл — stickiness фиксировать в onScroll-хендлере (до коммита), не post-factum useEffect.
- **D6** AssistantCard — плавная печать: парсинг markdown не чаще 5 fps / полный парс по завершении; highlight только приращения.
- **D7** TerminalPanel — оконный рендер (последние N строк + virtualization по высоте), `ptyResize` по ResizeObserver (cols/rows из ширины), unmount — НЕ убивать PTY при смене задачи (привязать к явному закрытию панели).
- **D10** SearchModal — debounce 250 мс, ранний выход по сессии.
- **D13** glass — отключать `backdrop-filter` при активном ambient-canvas (класс-тоггл); `animate-pulse` под `prefers-reduced-motion`.
- **D17** вложения — stable id (uuid при attach) вместо `key={dataUrl}`.
- **A15/C14-лёгкий фикс (выбор пользователя)** — даунскейл/сжатие картинок при attach (цель ≤1 МБ dataUrl), автосейв сессий — троттлинг 3с→10с idle + beforeunload flush, сериализация из C14.

## Волна 6 — UI/UX, i18n, a11y, конфиги
- **D2 (выбор пользователя)** — локальный SVG-бандл: модуль `src/components/providerIcons.ts` с inline-SVG (~30 популярных провайдеров, единый стиль), CDN-загрузка удалена, CSP не трогаем.
- **D3** ErrorBoundary — `key={activeId}` в точке использования; глобальный `unhandledrejection` handler с тостом.
- **D4** NotesModal `a` — `target="_blank" rel="noopener noreferrer"` (переиспользовать MarkdownLink).
- **D8** HooksSection — сохранение по blur/Enter, не на keystroke.
- **D9** ApiSection — тест соединения по blur/debounce 1200 мс, очистка таймеров при unmount.
- **D11** модалки — Escape игнорирует при фокусе в textarea/input (или подтверждение), `role="dialog" aria-modal`, общий хук useFocusTrap (Tab-ловушка + возврат фокуса).
- **D12** Dropdown/ContextMenu — role listbox/option/menu, стрелки, aria-expanded; Sidebar span-кнопки onKeyDown.
- **D14** FileTree — join через `normalizePath`, memoize дерева.
- **D15** формат-утилиты: Intl.NumberFormat (compact) и Intl.DateTimeFormat от текущего lang; TracePanel-единицы из локалей; убрать хардкод "ru-RU".
- **D16** SUGGESTIONS и desc кастомных ролей → ключи локалей (en/ru/zh/ja).
- **D18** ThemeSection — поэлементная сверка вместо JSON.stringify.
- **D19** BrowserPanel — await start + флаг в cleanup.
- **D20** tsconfig: `noUncheckedIndexedAccess: true` + правка ошибок компиляции; eslint react-hooks правила → error; `document.documentElement.lang` синхронно с локалью; locales zh/ja → полный `Record<MsgKey,string>`.
- Мелочи: AutomationsModal:248 ключ кнопки удаления, ChatArea:916 мёртвый тернарник, Sidebar relTime для zh/ja из локалей.

## Волна 7 — Верификация
1. `cargo test && cargo clippy -- -D warnings`, `npm test`, `tsc && vite build`, `eslint src` — все зелёные.
2. Новые тесты из Волны 0 — зелёные; матрица perm-тестов покрывает A4.
3. Ручной смоук: Stop во время shell_run (убивается мгновенно), Plan-режим не двигает мышь, Anthropic reasoning + tool-цикл из 3+ ходов без 400, обрыв сети → tool_calls не теряются, экспорт настроек без ключей, Ctrl+A в терминале не разрешает инструмент, стрим в свёрнутом окне доезжает.

## Отложено (вне этой волны)
- **D21** механический сплит SettingsModal на `src/components/settings/*.tsx` — отдельной задачей после стабилизации (решение пользователя).
- Рефакторинг вложений на диск — если лёгкий фикс (Волна 5) не снимет проблему размера sessions.json.