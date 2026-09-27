# AGENTS.md — правила работы с кодом Nocturn

Контекст для агентов (ZCode и т.п.) и людей. Держать кратким и актуальным:
правки правил — в том же коммите, что и правки кода, которые они описывают.

## Что это

Nocturn (HaloUI) — локальный BYOK AI-клиент: Tauri 2 + React 19 + TS +
Tailwind 4, бекенд Rust в `src-tauri/`. Без облаков: ключи, чаты и настройки —
у пользователя на диске (часть — в зашифрованном vault).

## Карта кода

**Бекенд (`src-tauri/src/`):**
- `chat.rs` — SSE-стримы провайдеров (OpenAI-совместимый + нативный Anthropic),
  abort-реестр; `tooling.rs` — оркестрация: `run_tool`, схемы инструментов,
  user-disabled гардал; `tools.rs` — реестр встроенных инструментов
- `perm.rs` — серверный слой прав (plan/ask/edit/full); `crypto.rs` —
  AES-256-GCM + Argon2id; `settings.rs` — настройки/профили/экспорт
- `mcp.rs` — MCP over stdio; `browser.rs` (CDP), `computer.rs`, `pty.rs` (ConPTY),
  `hooks.rs`, `files.rs` (чекпоинты), `colibri.rs` (запуск `coli serve`)

**Фронтенд (`src/`):**
- `App.tsx` — композиция и состояние верхнего уровня; `hooks/useAgentRun.ts` —
  агентный цикл; `api.ts` — типизированные invoke-обёртки (единственная точка IPC)
- `components/cards/` — карточки сообщений; `components/settings/` — разделы
  настроек (сплит из монолита); `locales/{ru,en,zh,ja}.ts` — `MsgKey = keyof ru`

## Команды

- `npm run tauri dev` — запуск (UI существует только в нативном окне)
- `npm run build` — tsc + vite build; `npm run lint` — eslint src
- `npm run test` — vitest; `npm run bench` — перф-бюджеты горячих функций
- `cargo test` и `cargo clippy --all-targets -- -D warnings` — в `src-tauri/`
- `node scripts/verify.mjs fast` — tsc + eslint + vitest (~16 с)
- `node scripts/verify.mjs all` — + bench + clippy + cargo test + сборка

## Ритуалы

1. Любое изменение — только с зелёным `verify fast`; перед передачей
   владельцу — `verify all`. Pre-commit hook гоняет fast автоматически.
2. Новые ключи локалей добавляются во **все 4** файла (ru/en/zh/ja),
   с настоящими переводами, не заглушками.
3. Коммиты делает **агент — локально** (стиль `type(scope): message` по
   `git log`); **пуш — только владелец** (GitHub-аккаунт заблокирован).
4. Коммит-стиль: `type(scope): message` по-английски — сверяться с `git log`.

## Конвенции

- Новый инструмент агента: схема в `tools.rs`/`tooling.rs`, мутирующий —
  в mutating-списке `useAgentRun` и в `perm.rs`. Гардалы вызова ставятся
  ДО PreToolUse-хуков (образцы: `ensure_not_user_disabled`, `perm::decide`).
- Любая запись файлов по пути с фронтенда — только через
  `ensure_export_target` (sensitive-path, вне конфиг-каталога, atomic_write).
- `hooks.json`/`mcp.json` исполняемы по своей природе: произвольная запись
  в конфиг-каталог = RCE-вектор. Не ослаблять гардалы perm.rs/crypto.rs.
- Пути с фронтенда валидируются через `rejects_sensitive_path` /
  `ensure_export_target` (settings.rs): вербатим-префиксы (`\\?\`), `\.\`
  и 8.3-алиасы нормализуются/отвергаются — см. тесты settings::tests.
- Экспорт настроек: `crypto.json` уходит только при `include_secrets=true`
  (иначе файл-«шеринг» несёт материал для перебора мастер-пароля).
- UI-цвета — только токены `halo-*` (Tailwind theme vars); новые — через
  `appearance.ts`, не хардкодом в компонентах. Исключение — семантика
  статусов (success/error/warn-палитра Tailwind в карточках и точках
  проектов), сознательно не привязана к темам.
- Комментарии в коде — по-русски, объясняют «почему», а не «что».
- `#[tauri::command]` без async не трогает ФС/сеть: `Path::exists()` на
  сетевом пути морозил GUI (sync-команда живёт на главном потоке).
- Запуск процессов — через `proc::run_command_opts` (CREATE_NO_WINDOW и
  процесс-группа уже внутри); гасить дерево — `proc::kill_tree`.
- Enter-обработчики полей проверяют `isComposing`: энтер подтверждения IME
  (китайский/японский ввод) приходит с тем же `key === "Enter"` и не должен
  отправлять сообщение/коммитить (образец: `ChatArea.tsx`).
- Платформенный FFI (`#[link(name = ...)]`) — только под соответствующим
  `#[cfg(windows)]`/`#[cfg(unix)]`: атрибут уходит линкеру безусловно, и
  незагейченный user32 ломал сборку macOS/Linux (ловится cargo test
  в rust-матрице CI: тестовый бинарник линкуется).
- CSS: `color-mix()` — только с `@supports`-фолбэком (WebKitGTK < 2.40
  отбрасывает декларацию целиком); `backdrop-filter` ставить условно
  (blur(0px) — не no-op); `transition-all` не использовать (см. S8-волна).

## Грабли (полная версия — docs/internal/SESSION_NOTES.md)

- Windows: дочерние процессы гасить деревом (`proc::kill_tree` — taskkill
  /T /F на Windows, kill -pgid на Unix); `cmd /C` — только с raw_arg;
  таймаут сокета приходит как `TimedOut`, не `WouldBlock`.
- Python-хередоки и регулярки: бэкслэши через `chr(92)`; после генерации
  проверять байты (`\\n` в python — это `\n` в файле).
- Эффект с ранним `return` + повторная проверка того же условия → TS2367;
  TS не видит присваивания в колбэках — holder-объект.

## Документация

- `docs/internal/SESSION_NOTES.md` — хендофф и история решений
- `docs/internal/PLAN.md` — текущий рабочий план (блоки и статус)
- `SECURITY.md` / `RELEASE.md` — политика безопасности и релизный процесс
