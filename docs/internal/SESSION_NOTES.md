# Nocturn (HaloUI) — handoff (21.09.2026)

Стек: Tauri 2 + React 19 + TS + Tailwind 4. Сборка: `npm run build` (tsc + vite),
Rust-тесты: `cargo test` в `src-tauri` (40 + 2 e2e). Запуск: `npm run tauri dev`.
Версия 0.2.0-alpha. Все разделы настроек реализованы — заглушек не осталось.
Предыдущий хэндофф (M0–M6, заметки от 19.09) перезаписан этой версией.

## Что добавлено за сессию (поверх M0–M6)

**Release-инфраструктура (перед публикацией):**
1) CI: job release на теге v* — windows-latest, npm run tauri build с
   TAURI_SIGNING_PRIVATE_KEY(_PASSWORD) из secrets, softprops/action-gh-release
   прикладывает nsis/*.exe, msi/*.msi, **/*.sig, latest.json.
2) tauri-plugin-updater: Cargo dep, .plugin(...) в run(), capability
   updater:default, tauri.conf.json: bundle.createUpdaterArtifacts=true +
   plugins.updater{endpoints:[github .../latest/download/latest.json],
   pubkey: REPLACE_WITH_TAURI_SIGNER_PUBKEY}. Frontend api.checkForUpdate
   (check → confirm → downloadAndInstall, ошибки молча), App вызывает через
   8с после старта; тост upd.installed. npm i @tauri-apps/plugin-updater.
3) Экспорт/импорт настроек: Rust settings_read_all/write_all (whitelist
   EXPORT_FILES: settings/profiles/projects/sessions/commands/plugins/
   shortcuts/subagents/colors/hooks/mcp/imagegen/browser/computer/crypto
   — crypto.json нужен для переноса зашифрованных ключей!),
   settings_export_write (валидация JSON)/settings_import_read. Frontend:
   pickSaveFile/pickJsonFile (dialog), collectLocal/restoreLocal
   (LS_EXPORT_KEYS: automations, theme-profiles, appearance, header-color,
   theme, lang, sidebar-* , notify, keep-awake, browser-panel). UI в
   «Основное»: Экспорт/Импорт + confirm; после импорта location.reload().
4) RELEASE.md: signer generate, pubkey, secrets, теги. Локали main.export*/
   import*, upd.* во всех 4 языках. ВАЖНО: локали теперь в locales/ru|en|zh|
   ja.ts — locales.tsx только враппер; MsgKey = keyof ru. Дисклеймер «This response is AI-generated, for
reference only» (chat.aiDisclaimer, 4 языка) — мелкая строка под каждой
карточкой ассистента с непустым ответом (ChatArea, после usage-ряда).




**Крипто: Argon2id вместо PBKDF2.** Оказалось, AES-GCM уже был на RustCrypto
(aes_gcm::Aes256Gcm — AutoCoder), формат enc:v1:base64(nonce‖ct‖tag)
стандартный — менять нечего. Заменён KDF: crypto.rs derive_key_argon2
(Argon2id, Params::default() = 19MiB/t=2, OWASP) + encrypt_with/decrypt_with
(явный ключ). lib.rs: crypto.json получил поле kdf ("argon2id"|"pbkdf2",
отсутствие = pbkdf2-легаси); crypto_setup сразу argon2id; crypto_unlock при
легаси-мете тихая миграция: verify старым KDF → rekey_all (settings.json
api_key + profiles.json[].api_key: decrypt_with старым → encrypt_with новым;
нерасшифровывающиеся остаются как есть) → новая соль/check/kdf=argon2id.
Формат полей НЕ менялся → совместимость полная. Тест argon2_derive_
deterministic_and_salt_sensitive. ГРЯБЛЯ: b"..." литералы не держат
кириллицу (non-ASCII byte string).

**Крипто-гигиена (по ревью пользователя):** encrypt/decrypt больше не клонируют
ключ — borrow из VAULT_KEY (as_ref → &[u8] в encrypt_with/decrypt_with);
clear_key затирает ключ через zeroize (ручной цикл *byte=0 LLVM может
вырезать как dead store); decrypt больше не декодирует base64 дважды
(просто lock+borrow+decrypt_with). Замечания пользователя: рекурсия —
неверно (слоистость), v1-префикс у новых полей — не баг (KDF в meta,
мультиключей нет), клоны/затирание — верно по сути, преувеличено как
«критическое» (ключ всё равно живёт в VAULT_KEY, plaintext гуляет в JS).


**Подготовка к open source (чек-лист публикации):** LICENSE (MIT),
.gitignore (node_modules/dist/target/gen-schemas), .github/workflows/ci.yml
(frontend tsc+vite на ubuntu; cargo test --lib на windows-latest),
SECURITY.md (что уходит/хранится/поверхность агента), README переписан
под опенсорс (фичи, приватность, скриншоты docs/screenshots/main.png /
quick-look.png / automations.png — сняты с живого приложения), SESSION_NOTES
переехал в docs/internal/. git init -b main + initial commit (88 файлов);
identity локально Nocturn Dev <dev@nocturn.local> — пользователь может
поправить автора перед push.


**Наследство AutoCoder (волна 3) — аудит и достройка.** Внешний агент
выполнил: локали разнесены на 4 файла (locales/ru|en|zh|ja.ts, MsgKey =
keyof ru, translate фоллбэк en→ru); Hard Limit (limits.ts: maxTokens/
usdPer1M/maxUsd, checkHardLimit в 3 местах агентного цикла, секция в
«Основном»); профили тем (themeProfiles.ts, «Кастомизация» → «Профили
темы», сохранение/переключение одним кликом); корректирующий запрос
(pendingCorrections по requestId, injectCorrections в начале следующего
раунда, префикс agent.correctionPrefix, карточка correction:true в чате);
Splash (Splash.tsx, держится пока грузятся хранилища, фейд через onGone);
уведомления также о запросах подтверждения (notify.confirmTitle).
НЕ ДОДЕЛАНО было: ключи composer.correct / agent.correctionPrefix /
splash.tagline отсутствовали в zh/ja (MsgKey из ru, а translate индексирует
объединение словарей → весь t() падал типом). ДОБАВИЛ перевод в zh/ja.
Проверено: tsc clean, vite build, cargo 60 тестов, runtime — splash
исчезает, «Основное» с Hard Limit, «Кастомизация» с профилями/акцентом.
Внимание: composer.placeholder заменён AutoCoder? нет — остались наши
«Скажи задачу — сделаем».


**Живой просмотр браузера агента (панель справа):** browser.rs — pub
view_frame() (Page.captureScreenshot jpeg q50 + location.href) и
set_viewport() (Emulation.setDeviceMetricsOverride / clear). lib.rs —
browser_view_start (глобальный AtomicBool BROWSER_VIEW_ACTIVE; один поток
тиком 400мс берёт Arc<BrowserConnection> из registry через
app.state::<BrowserRegistry>() — ВАЖНО: clone из MutexGuard через
промежуточный let, иначе E0597), шлёт tauri event "browser-frame"
{data: base64|null (только при изменении кадра), url}; browser_view_stop;
browser_view_size(w,h|null). Frontend: BrowserPanel.tsx — фиксированная
панель справа 440px (адрес read-only, селектор Fit/1280×720/1024×768/
1920×1080, img object-contain, hint когда кадров нет); api.ts
browserViewStart/Stop/SetSize + listenBrowserFrame (UnlistenFn синхронный!).
App: browserPanelOpen + тумблер browserAutoPanel (localStorage
haloui-browser-panel, дефолт on) — execTool открывает панель на первом
browser_* прогона. Тумблер в Настройки→Основное (main.browserPanel).
Interactivity (клики в панель → CDP Input.*) — фаза 2, не реализовано.
Локали browserPanel.*.
  ГРЯБЛЯ (исправлено): фоновый capture через обычный request() во время
  загрузки страницы упирался в таймаут и mark_dead → все browser_*-инструменты
  агента падали («browser connection is closed»). Теперь request_impl(
  timeout, fatal): request_soft (3с, fatal=false, просрочка → abandoned без
  mark_dead) для view_frame (и для URL-evaluate тоже — отдельный
  request_soft, не evaluate); при ошибке кадра тик трансляции спит 1.2с.

**Мелкие правки UI:** иконка субагента (SubagentIcon, две фигуры) в чипе
tool-call для subagent_run (остальные — ToolIcon); таблицы markdown:
word-break normal + overflow-wrap break-word (колонка растёт под слово,
рвутся только безнадёжные токены — было «anywhere» и «Мессенджеры»
ломалось); contextLimitFor: точный id → нечёткий матч (id содержит
модель/наоборот, регистронезависимо) → эвристика «256k» в имени модели
(16..2048) → эвристика по имени. ГРЯБЛЯ: python-heredoc сожрал  в
regex → проверять regex после генерации из питона.

**Сайдбар без демо-проектов:** seedProjects (Nocturn/Обучение) удалён —
список проектов стартует пустым, наполняется только вручную. Хранение —
projects.json (натива) / haloui-projects localStorage (превью), автосейв;
удалённый проект не восстанавливается. seedSessions тоже удалён — чаты
стартуют пустым списком, только созданные пользователем; импорт TFn из
локалей убран (неиспользуемый). Локали seed.* остались (не мешают).

**Тосты вместо строк в чате:** components/Toast.tsx — плавающие
уведомления снизу справа (anim-fade-up, стек до 4, авто-скрытие 4.2с,
pointer-events-none); App: toasts state + addToast; чекпоинт больше НЕ
pushMessage в чат, а addToast(t("cp.created")). Место для будущих
сервисных уведомлений (vault_write и т.п.).

**Монитор субагентов у кнопки отправки:** SubRunState += task (первая
строка промта); завершённый прогон удаляется из subRuns через 30с
(setTimeout в App). ChatArea: кнопка-робот (RobotIcon SVG) справа от
ContextRing, видна ТОЛЬКО когда subRuns непуст; бейдж = активные (или
всего, если активных нет); поповер снизу-вверх: точка (пульс = работает,
зелёная = готово) + роль + задача, w-80, закрытие по клику вне.
Локали sub.monitor. Плейсхолдер композера: RU «Скажи задачу — сделаем»,
EN «Name it — it gets done» (вместо «Сообщение… (Ctrl+V…»). ГРЯБЛЯ:
python-запись "
" внутри кода — проверять экранирование.

**Release v0.1.0 выпущен и проверен.** Грабли CI: 1) workflow без tags: ["v*"] в on.push не срабатывал на пуш тега — теги ≠ ветки; 2) тег должен указывать на коммит с актуальным workflow (форс-пуш тега); 3) latest.json Tauri v2 сам НЕ генерирует (это делает tauri-action) — скрипт scripts/make-latest-json.ps1 в CI (sig → signature, exe url); 4) двойное .exe: $sig.BaseName отрезает только .sig; 5) инлайн-pwsh в YAML ломается об экранирование кавычек — выносить в .ps1 файл. Проверено: latest.json в Assets корректен (version/url/signature), автообновление рабочее.

**Быстрая кастомизация в сайдбаре:** QuickSettings += пропсы align
("left" — открывать от левого края) и initialTab; во вкладке «Вид»
добавлена палитра акцента (6 пресетов ACCENT_PRESETS + input[type=color]).
Sidebar: проп quick (весь пучок model/theme/appearance/glass), кнопка
PaletteIcon рядом с «Настройки» (футер, flex) → QuickSettings align=left
initialTab="look" — из сайдбара сразу открывается вкладка «Вид».
App прокидывает quick={{...}}. Заметки: слайдер масштаба в
боковом поповере узкий, но работает; поповер bottom-full — открывается
вверх, футер низкий — места хватает. ОТКАТ: дублирующая кнопка быстрой
кастомизации в футере сайдбара удалена (QuickSettings уже есть у
композера); проп quick из Sidebar убран. Осталось ценное: палитра
акцента (6 пресетов + свой) во вкладке «Вид» QuickSettings.
  ГРЯБЛЯ №2 (исправлено, старая): на Windows таймаут чтения сокета
  приходит как ErrorKind::TimedOut (os error 10060), а не WouldBlock —
  request считал это фатальной ошибкой и убивал соединение при любом
  ответе дольше 250мс (навигация!). Теперь обе категории = «пока тихо,
  ждём дедлайна» в request_impl.


**Полировка автоматизаций + дэмоджификация:** эмодзи по всему UI заменены
на SVG/ASCII: ⏳→QueueIcon, ❝→QuoteIcon (ChatArea ×3), ⓘ→InfoIcon,
◎⚡▤≡→sun/zap/doc/list SVG-иконки (Template.icon теперь enum), ＋→+,
▾→·, служебный префикс чата "⚙ "→"[i] " (ВАЖНО: фильтры из контекста
модели в App.tsx — startsWith("[i]")) и локали chat.modelChanged тоже
"[i] ". Инструмент vault_write (tools.rs, schema+execute; в App добавлен
в mutating-список — plan-режим блокирует, ask подтверждает). История
запусков: Automation.runs[] (посл. 10, пишет движок), в списке
«запусков: N», иконка HistoryIcon раскрывает последние 5. Vault-интеграция:
флаг toVault (иконка док-файла на пункте + чекбокс в форме; шаблоны
создают с true), движок дописывает VAULT_REPORT_SUFFIX — агент сохраняет
отчёт в automations-report.md через vault_write. Локали auto.runCount/
history/toVault.


**Автоматизации (референс ZCode):** automations.ts — модель {id, name,
prompt, schedule(daily|weekdays|weekly|interval, time/weekday/minutes),
nextRunAt, lastRunAt, enabled}, localStorage haloui-automations,
nextRunAfter (8-дневный поиск слота), isDue, 4 шаблона (dev-брифинг,
скан рисков, релиз, сверка доков — RU тексты промтов). AutomationsModal:
шапка «Автоматизации Workflows», карточка списка/пустое состояние с
«Создать задачу», форма (название, промт, вид расписания, время/день/минуты),
тумблер keep-awake, сетка шаблонов 2×2; клик по шаблону = мгновенное
создание. Движок в App: interval 30с, isDue → максимум ОДИН запуск за тик;
создаёт новую сессию (title=name) и handleSend(prompt, targetId) через
handleSendRef (объявить useRef<typeof handleSend | null> — handleSend
объявлен ниже по коду!); без настроенного API — просто перенос срока.
keep-awake: Rust keep_awake — SetThreadExecutionState через extern "system"
kernel32 (без новых crate), ES_CONTINUOUS|SYSTEM|DISPLAY; api.ts keepAwake;
localStorage haloui-keep-awake; применяется на тумблер. Сайдбар:
«Автоматизации» больше не заглушка — открывает модал. Локали auto.*.

**Сайдбар без дубля проектов:** верхний отдельный блок «ПРОЕКТЫ» (список +
«Новый проект») удалён; управление проектами живёт во вкладке «Проекты»
ниже пилюль: заголовок секции с «+» (создание через RenameInput), группы
включают пустые проекты, заголовок группы кликабелен (выбор/сброс фильтра
проекта) и несёт контекст-меню. Локаль sidebar.projectsEmpty.

**Сайдбар крупнее:** строки действий и задач text-sm/py-2, пилюли text-xs
px-3/py-1.5, заголовки секций 11px, kbd/время/теги/счётчики на ступень
крупнее, иконки Zap/Grid/Search 16px, бренд 15px, «Выбрать папку» text-sm;
дефолт ширины 340 (миграция 288/320 → 340, clamp max 440).

**Правки сайдбара №2:** названия проектов в группах — text-sm; разделитель
(border-t mx-4 mt-4) между блоком действий и навигацией, с воздухом
с обеих сторон (nav mt-0, пилюли pt-4);
цветные заголовки секций: HeaderLabel (ПРОЕКТЫ/ЗАДАЧИ/ЗАМЕТКИ — клик
открывает ColorPalette) + ФАЙЛЫ (только цвет): 6 пресетов = ACCENT_PRESETS
из appearance.ts + input[type=color] + «Как в теме» (сброс); хранение
localStorage haloui-header-color, стиль перекрывает muted-класс. Локали
sidebar.headerColorTitle/Custom/Reset.


**Редизайн левого бара (десерифизация):** строки действий (Новая задача /
Поиск) — плоские (иконка без круглой обводки, kbd справа без рамки/фона,
text-[13px]); под ними «Автоматизации» — disabled-заглушка с бейджем «Скоро»
— и «Менеджер плагинов» (открывает настройки на разделе plugins).
  Баг-fix: эффект «сброс при открытии» в SettingsModal перекрывал
  initialSection — теперь open-эффект ставит initialSection ?? "main".
  Над списком задач — переключатель-пилюли «# Задачи / Проекты»
  (groupBy flat|project, localStorage haloui-sidebar-group): в режиме
  «Проекты» задачи сгруппированы по проектам (точка + имя), без проекта —
  «Без проекта»; рендер строки вынесен в sessionRow. Локаль
  sidebar.noProject. Переписано по референсу ZCode: Session += archived/tag
  (пersistятся автосохранением sessions.json); хендлеры App
  handleArchiveSession/handleTagSession + onDeleteSession в Sidebar.
  Строка чата на ховере (group/row): архив, тег (window.prompt), удалить ✕;
  тег — бейдж перед временем. Тумблер архива (иконка коробки у пилюль):
  показывает вместо обычных только архивированные. Режим «Проекты»:
  секция «Проекты» + «Задачи» (без проекта) как отдельные заголовки;
  группы с отступом и бордером, максимум 5 строк + «Показать ещё (n)»
  (expandedGroups Set); стрелка справа от пилюль сворачивает секцию
  проектов (localStorage haloui-sidebar-projects), «Задачи» остаются.
  Локали sidebar.archive/unarchive/showArchive/backToChats/archiveEmpty/
  tag/tagPrompt/showMore/showLess/hideProjects/showProjects.
  БАГ-FIX чёрного экрана: TDZ — visible фильтровал по showArchived,
  объявленному ниже; при переносе состояний вверх продублировался блок
  groupBy — следить, что состояния объявлены ДО первого использования
  (useMemo-подобные IIFE в теле компонента не прощают). Отладка: Vite dev
  + reimport "/src/main.tsx?t=x" через module-script в странице ловит
  стек ошибки. У задач в
списке справа относительное время (relTime: 5м/3ч/2д, от createdAt — у
Message нет ts). Заголовки секций сайдбара приглушены (10px, tracking
0.14em, /50). Настройки: новый проп initialSection (Section экспортирован),
useEffect переключает раздел; App хранит settingsSection, открытые через
сайдбар/хоткей разделы задают его явно. Локали sidebar.automations/plugins/
soon. Иконки ZapIcon/GridIcon.


**Скил Repo Wiki (&wiki):** skills.ts BUILTIN_SKILLS. В описании прямо
сказано: жёстко локально, код/доки уходят только к провайдеру пользователя.
Опциональный по природе — вызывается только вручную из палитры «&».
Генерит docs/wiki/ (overview, по модулю, index) через fs_*.

**Свои звуки уведомлений:** Rust sound_import/sound_data/sound_delete в
lib.rs — файл (mp3/wav/ogg/m4a/flac, ≤5МБ) копируется в appdata/sounds/
custom.<ext>; sound_data отдаёт data URL. notify.ts: NotifySound += "custom",
кеш data URL (refreshCustomSound), playSound("custom") → Audio(dataUrl).
NotifyPrefs.customName — для отображения в UI. Настройки → Основные → блок
уведомлений: кнопка «＋ Свой звук» (pickAudioFile → soundImport → прослушка)
и ✕ (soundDelete). В браузерном режиме custom тихо не играет.

**Генерация изображений (imagegen.rs, тумблер, выключен по умолчанию):**
OpenAI-совместимый POST {base_url}/images/generations (b64_json или url →
скачивание), файлы в appdata/images/img-<ts>.png, модели возвращается JSON
{ok, path, bytes}. Конфиг imagegen.json {enabled, base_url, api_key, model,
size}; команды imagegen_get/set_config; схема image_generate в
get_tool_schemas ТОЛЬКО при enabled; исполнение — в execute_tool_inner
(новый параметр data_dir = app_data_dir) до builtin-ветки. Инструмент
мутирующий (mutating=true по умолчанию — имя не из списка чтения, значит
подтверждение как у shell в ask-режиме). Секция настроек «Генерация
изображений» (SettingsModal ImageGenSection, иконка image, Section type
расширен, invalidateToolSchemas при сохранении). Локали ig.* / settings.imagegen.

**Очередь корректирующих сообщений (без прерывания агента):** ChatArea
в `submit()` при typing=true зовёт `onQueue` вместо `onSend`; над композером
чипы очереди (⏳, крестик — убрать). App.tsx: state `queuedMsgs` + ref,
`finalize()` забирает первый элемент и зовёт `handleSend(text, att, targetId)`
— последовательный дренаж (следующий уйдёт после его finalize). Срабатывает
и после Stop. Локали composer.queued / composer.queuedRemove.

**Граф заметок как инструмент агента:** tools.rs — `vault_search({query})`
(пустой запрос = список всех, совпадения по заголовку выше совпадений по
телу, сниппеты) и `vault_read({file})` (контент до 64КБ + Outgoing links
+ Backlinks — по [[целям]] и заголовку). Имена файлов `vault_sanitize`
(как sanitize_note_file). Роутинг в `execute_tool_inner` (новый параметр
notes_dir, caller run_tool) до builtin-ветки; схемы — в get_tool_schemas
рядом с builtin. Чтение — не мутирующее (plan-режим пропускает). Тест
vault_search_and_read_roundtrip.

**Смена режима разрешений по хоткею:** действие `cycle_perm_mode` в
`shortcuts.ts` (SHORTCUT_ACTIONS + дефолт Ctrl+Shift+M + подпись `sc.permMode`).
Диспетч в App.tsx: цикл ask → plan → edit → full для активной задачи
(PermissionMode уже импортирован там).

**Чекпоинты проекта (снимки для отката):**
- Rust (lib.rs, после git_status): `checkpoint_save/list/restore/delete`.
  Снимки в appdata/checkpoints/<sha256(путь)[:16]>/<ts>-<hex>.json; файлы
  в base64; скип CP_SKIP_DIRS (.git, node_modules, target…), лимиты 512КБ/файл,
  25МБ/снимок, хранить CP_KEEP=20 (чистка по ts в имени). restore валидирует
  id (`cp_id_ok`) и относительные пути (без .. и абсолюта).
- api.ts: checkpointSave (в браузере/null-ошибках → null), List, Restore (→
  число файлов), Delete.
- Автоснимок: App.tsx `ensureCheckpoint()` в агентном цикле — один раз за
  прогон перед первой исполняемой мутирующей правкой (ветки full/edit/allowed
  и после подтверждения ask). projectRoot через projectRootRef. Метка —
  последний user-запрос. Служебное сообщение в чат с префиксом "⚙ " (это
  фильтруется из контекста модели, как смена модели).
- UI: Sidebar, секция «Файлы» → иконка часов → Checkpoints (список,
  восстановление с confirm, удаление). Локали cp.*.


**Шифрование:** выключение тумблера требует мастер-пароль (гейт intent="disable",
CryptoGate; пароль проверяет crypto_unlock; кнопки «забыли пароль» там нет).

**Хуки** (`hooks.rs` + раздел настроек): shell-команды на событиях
PreToolUse/PostToolUse/UserPromptSubmit/Stop/SessionStart. Контекст — JSON в
stdin (raw_arg! — иначе кавычки ломаются на Windows). `{"decision":"block"}`
или exit≠0 у PreToolUse блокирует инструмент; `additionalContext` дописывается.
Пайпы читать в потоках + recv_timeout (потомок наследует пайп и висит после
kill). Врезка в run_tool до/после диспетчеризации, всё в spawn_blocking.
6 готовых пресетов в UI. UserPromptSubmit может блокировать отправку.

**Скилы** (`skills.ts`): 12 встроенных («&» в композере — палитра, шаблон
вставляется в черновик). Каталог в настройках; плагинные скилы — read-only
с пометкой. `Skill.desc` опционален (плагины могут не прислать) — все
использования через `?.`.

**Команды**: 9 встроенных (/ru /en /short /step /fix /commit /pr /ask /continue,
`commands.ts` BUILTIN_COMMANDS) + пользовательские (`commands.json`, раздел
«Команды», шаблон с $ARGUMENTS → разворачивается в ЧЕРНОВИК, не авто-отправка).
Мерж в ChatArea: allCommands = реестр App + builtins + user (user перекрывает
builtin по имени, Map по name).

**Плагины** (`plugins.json`, plugin_read/plugins_load/save): import plugin.json
{name, version, commands, skills, roles} → предпросмотр → установка. Сущности
текут динамически: команды → палитра «/», скилы → «&», роли → субагенты
(эффективный конфиг = subConfig.roles + pluginRoles; при сохранении своих
настроек plugin-роли отфильтровываются!). Plugin-роли и plugin-скилы в UI
read-only («из плагина»). Хуки сознательно НЕ устанавливаются плагинами.

**Субагенты** (subagents.ts, M1–M3): инструмент subagent_run({role, task}) —
изолированный прогон (свой контекст, allowlist, потолок шагов), отчёт —
tool result. Глубина 1 (схема субагентам не выдаётся). Роли: researcher /
coder / critic / librarian + свои в subagents.json (editor: имя, модель-
override, allowlist, maxSteps, промт). Батч subagent_run исполняется
параллельно (maxParallel, переполнение — очередь). SubagentCard в чате:
живые мысли (сброс на tool-шаге), чипы инструментов, финальный отчёт; после
рестарта восстанавливается из tool-сообщения. Схема в Rust — БЕЗ enum ролей
(плагинные роли валидны). Тумблер enabled фильтрует схему из getToolSchemas.

**Уведомления** (notify.ts + tauri-plugin-notification): тост+звук ТОЛЬКО когда
окно не в фокусе; два триггера — finalize() (задача завершена) и askConfirm
(агент ждёт подтверждения). Тело: «проект · модель» + название задачи.
3 звука на WebAudio (chime/ping/soft, прослушка при выборе). Тумблер в
«Основном», prefs в localStorage haloui-notify. capabilities: notification:default.

**Горячие клавиши** (shortcuts.ts, shortcuts.json): 7 действий перебиндиваются
(запись по e.code, Esc отмена, конфликт — плашка), + СВОИ хоткеи: комбо →
любая slash-команда с аргументом (диспетчер после встроенных). Хранение
{binds, custom}; плоский файл = старая версия. Голая буква без модификаторов
не перехватывается.

**Прочее:**
- Палитра slash/скилов: композер `z-30` (glass-pane создаёт stacking context,
  иначе палитра ПОД лентой сообщений z-10). MessageNav вынесен ИЗ скролл-
  контейнера (иначе уезжает при прокрутке).
- Крошки в настройках: ← назад по ИСТОРИИ (navStack), подпись = куда вернёшь.
- Dropdown (кастомный, вместо нативного select): темы-стили, команда хоткея,
  событие хука.
- Тема: style-select + превью узора; стекло сайдбара — тумблер sidebar-glass
  (42% surface + blur×1.6; bg полупрозрачный ОБЯЗАТЕЛЬНО, иначе blur не виден).
- Статистика: считается из ВСЕХ сессий (не usageLog!), цвета моделей
  настраиваются (colors.json, дефолт по hash(name)); донат-дуги анимируются
  (usage-arc: dasharray 0→), тренд рисуется (usage-draw, pathLength=1),
  клетки — волной. Remount по tick.
- Время: dayPeriod() в time.ts — UTC/GMT-fallback при отсутствии таймзоны.
- Редактирование отправленных сообщений: карандаш на UserCard → textarea
  (Enter=отправить, Esc=отмена) → handleSend(..., editMsgId): срезает всё
  после правленого, userMsg = копия orig с новым текстом, currentOverride
  для истории. ⚙-уведомление о смене модели не входит в запрос (filter
  startsWith "⚙").
- Модель сменилась → служебное сообщение «⚙ Модель изменена» в активный чат.

## Уроки/грабли за сессию
- python-хередоки в bash: бэкслэши в заменах лучше через chr(92); replace
  с count=2 регулярно бьёт по RU-секции дважды → дубли ключей (MsgKey strict).
- При правке TSX регулярками: `\\n` в python = `\n` в файле — проверять байты.
- raw_arg для cmd /C обязателен (кавычки); kill() убивает только cmd,
  потомки держат пайпы.
- TS не видит присваивания в колбэках: `let x=null; cb=(v)=>{x=v}` → x: null;
  использовать holder-объект.
- Эффект с `if (cond) return` в первом if → внутри step сравнение того же
  cond даёт TS2367 (narrowing).

## Техдолг / идеи
- Разрезка бандла (600KB+); экспорт чатов; своя команда /model.
- Плагины с хуками (нужен подтверждаемый механизм установки).
- Условные рёбра цепочек (frontmatter `when:`); субагентам наследовать
  «Всегда для задачи» вместо безусловного allowlist.
- Настройки-раздел для подтверждений субагентов; субагентные токены серым в Σ.

## Хендофф 26.09 (вечер) — идёт пачка фич, сессия может оборваться по квоте
План согласован владельцем (в чате). Прогресс по волнам:
- [x] Волна 1 (S-пачка): Saved-тост (fingerprint appearance/theme/glass при
  открытых настройках → один тост settings.saved по closeSettings); тумблер
  reduceMotion (appearance field + html.motion-reduced CSS + AmbientLayer
  paused в App + themeProfiles passthrough); OpenDyslexic в UI_FONT_PRESETS;
  дифф-превью в CodeThemeSwatch (−/+ две строки, цвета .hljs-addition/
  deletion из css темы, фиксирован съеденный heredoc-бэкслеш в регэкспе —
  свотчи были серыми); версия в «Основном» уже была.
- [x] Волна 2: autostart (tauri-plugin-autostart + тумблер в Основном);
  Storage-менеджер (размеры sessions/checkpoints/images/sounds/fonts + очистка);
  Default transcript view (Normal/Thinking/Verbose — дефолт вида ленты,
  per-session переключение остаётся).
- [x] Волна 3: Панель плана в Plan Mode — правая панель по образцу
  DiffPanel, auto-open при переключении режима в «План», задачи из
  session.plan (PlanTask {title,status}) live, кнопка «Одобрить план →
  Спрашивать» (setPermissionMode("ask")), «Скопировать план». Мини-PlanPanel
  у композера остаётся.
- [x] Волна 4: Quick Entry — tauri-plugin-global-shortcut (Ctrl+Alt+Space,
  ремап в Основном), второе frameless-окно у верхнего центра, Enter →
  новая задача в главном окне.
- [x] Волна 5: Fallback-модель в профиле API, авто-переключение при 429/5xx
  после ретраев, бейдж в карточке.
- [x] Волна 6: клик по строке диффа в Review → цитата файла в композер.
ОТЛОЖЕНО (решение владельца): мини-игры (вкладка «Отдых»: 2048/Сапёр/Змейка),
Memory-фича (vault-факты), Reflect, импорт файла памяти, авто-коммит/PR.
ВЫБРОШЕНО (BYOK/Local/Anon): connector-discover, import memory из
провайдеров по API, PR-автоматизация, dictation, wallet-QR.

## ХЕНДОФФ-ОБРЫВ (26.09, вечер, квота) — НОВАЯ СЕССИЯ ПРОДОЛЖАЕТ С ВОЛНЫ 2.2
Прочитай этот блок ПЕРВЫМ. Контекст: владельцем согласован план «пачка фич»
(полный текст плана — в истории чата), Волна 1 закрыта, Волна 2 начата.

### ЧЕК-ПОИНТ СОСТОЯНИЯ (verify fast зелёный на этом месте)
Сделано в этой пачке (незакоммичено, поверх старых правок):
- Волна 1: Saved-тост (App.tsx: settingsTouchedRef + settingsFingerprint +
  prevFingerprintRef + closeSettings — блок после msgGlass-префов; ключ
  settings.saved ×4); reduceMotion (appearance.ts: поле+default+load+класс
  motion-reduced; index.css: html.motion-reduced блок после @media
  prefers-reduced-motion; ThemeSection: ToggleRow в gEffects после msgGlass;
  App: AmbientLayer paused={streamingId !== null || appearance.reduceMotion};
  themeProfiles: passthrough reduceMotion); OpenDyslexic в UI_FONT_PRESETS
  (fonts.ts); дифф-свотчи CodeThemeSwatch (двухстрочный −old/+new, цвета
  .hljs-addition/.hljs-deletion парсятся, исправлен съеденный heredoc-регэксп).
- Волна 2.1 autostart: Cargo.toml += tauri-plugin-autostart = "2"; lib.rs
  плагин init(MacosLauncher::LaunchAgent, None) после updater; capabilities
  += "autostart:default"; api.ts: autostartIsEnabled/autostartSet (invoke
  "plugin:autostart|is_enabled|enable|disable" — npm-пакет НЕ нужен);
  MainSection: autostartOn state + ToggleRow после Row версии; ключи
  main.autostart(+Desc) ×4.

### ВОЛНА 2.2 + 2.3 — ВЫПОЛНЕНЫ (26.09, вторая сессия, verify all зелёный)
Сделано в продолжение чекпоинта выше:
- Волна 2.2 Storage-менеджер: fsutil.rs — dir_size (стек read_dir, без
  рекурсии, symlink/junction не раскрываются), clear_dir_contents (содержимое
  каталога, корень жив), StorageStats{config,checkpoints,images,sounds,fonts},
  команды storage_stats/storage_cleanup(kind) — #[tauri::command(async)] +
  spawn_blocking (паттерн files.rs), зарегистрированы в lib.rs рядом с
  checkpoint_*; тесты dir_size_sums_nested_files, clear_dir_contents_keeps_root.
  api.ts: storageStats() (вне Tauri → null) / storageCleanup(kind) (→ число
  удалённых записей). MainSection: блок «Хранилище» внизу секции — StorageRow
  (label + fmtBytes, локализованные Б/КБ/МБ vs B/KB/MB) ×5, двухшаговая кнопка
  очистки (confirmKind: первый клик «Очистить» → «Точно?», второй — cleanup +
  перезапрос stats) только у чекпоинтов и картинок; блок скрыт вне Tauri.
- Волна 2.3 Default transcript view: App.tsx useStringPref
  "haloui-transcript-view" ("normal"|"thinking"|"verbose", дефолт normal);
  проброс transcriptView/onTranscriptViewChange через SettingsModal →
  MainSection; сегмент-контрол из 3 кнопок после showReasoning;
  changeTranscriptView синхронно двигает showReasoning (thinking/verbose =
  true) и showUserMsgs (verbose = true). Локали main.view/viewNormal/
  viewThinking/viewVerbose ×4 (рядом с main.storage* — те после
  main.autostartDesc).
- Проверки: verify fast после каждого шага, verify all в конце (48s: tsc,
  eslint, vitest 90, bench, clippy, cargo test 105, vite build).

### ВОЛНА 2.2 — ПЛАН ИСПОЛНЕНИЯ (исходный, сохранён для истории)
1) Rust (fsutil.rs, команды с app handle, spawn_blocking):
   - storage_stats -> StorageStats { config, checkpoints, images, sounds,
     fonts } (u64 байты; dir_size через read_dir-стек; config =
     app_config_dir целиком; checkpoints = app_data/checkpoints; images =
     app_data/images; sounds = app_data/sounds; fonts = app_data/fonts).
   - storage_cleanup(kind: "checkpoints" | "images") — очистить содержимое
     соответствующего каталога (fs::remove_dir_all/remove_file по entries).
   Зарегистрировать fsutil::storage_stats, fsutil::storage_cleanup в
   generate_handler (lib.rs, рядом с files::checkpoint_*).
2) api.ts: storageStats() / storageCleanup(kind) c inTauri-гардом (паттерн —
   как autostartIsEnabled выше).
3) MainSection: блок «Хранилище» внизу секции — строки «Конфиги и задачи /
   Чекпоинты / Картинки агента / Звуки / Шрифты» с размерами (fmtBytes:
   <1024 → Б, <1МБ → КБ, иначе МБ, одна десятичная) и двухшаговой кнопкой
   очистки (первый клик «Очистить», второй «Точно?») для чекпоинтов и
   картинок; после очистки — перезапрос storageStats. Звуки/шрифты чистятся
   по-штучно в своих секциях — кнопку не давать.
4) Ключи ×4 (pat: добавлять regex-якорем возле main.autostart):
   main.storage, main.storageConfig, main.storageCheckpoints,
   main.storageImages, main.storageSounds, main.storageFonts,
   main.storageClean, main.storageCleanConfirm.
   RU: Хранилище / Конфиги и задачи / Чекпоинты / Картинки агента / Звуки /
   Шрифты / Очистить / Точно?   (EN/zh/ja — по образцу)
5) Волна 2.3 (после 2.2): Default transcript view — useStringPref
   "haloui-transcript-view" ("normal"|"thinking"|"verbose") в App.tsx рядом
   с showReasoning (строка ~224: haloui-show-reasoning); сегмент-контрол из
   3 кнопок в MainSection (рядом со streamSmooth/showReasoning rows); смена
   сегмента выставляет showReasoning (thinking/verbose = true, normal =
   false) и showUserMsgs (verbose = true, иначе false); prefs:
   haloui-show-reasoning (224), haloui-show-user-msgs (240). Ключи ×4:
   main.view, main.viewNormal, main.viewThinking, main.viewVerbose.
6) verify fast после каждого шага; verify all в конце волны 2. Затем
   дописать этот хендофф (отметить [x] 2.2/2.3).

### БАТЧ ФИКСОВ/ФИЧ 27.09 (вечер) — verify all зелёный 46.8s
- Сегмент «Вид ленты» больше НЕ трогает showUserMsgs (тумблер «Показывать мои
  сообщения» скакал при выборе «С размышлениями»/«Подробный»); двигает только
  авто-раскрытие размышлений. Показ user-сообщений — отдельный выбор.
- F11: retry-луп возврата в maximize (3 попытки × 80мс с проверкой
  is_maximized) — 70мс-фикс не хватал: tao восстанавливает размещение с
  переменной задержкой.
- ТРЕЙ-ЗОМБИ (главная находка): «main window NOT found» — скрытое окно
  quickentry ДЕРЖАЛО процесс живым после закрытия главного окна: трей
  оставался, Open Nocturn не находил main (PostMessage invalid handle — из
  умирающего окна). Фикс: RunEvent::WindowEvent{label:"main",
  event:Destroyed} → app.exit(0) (RunEvent::WindowClosed НЕ существует в
  tauri 2.11 — вариант WindowEvent с .. из-за non_exhaustive).
- Плавная печать: тик 100мс → 50мс (D6-бюджет поднят) + настраиваемый
  множитель догоняющего темпа: преф haloui-print-speed (0.5/1/2), сегмент
  «Скорость печати» в «Основном» рядом с тумблером (виден при включённой
  плавной печати), проброс App → SettingsModal → MainSection + ChatArea →
  AssistantCard (advance = max(4, ceil(backlog/4 * speed))).
- Поиск по настройкам: SettingsModal — строка над навигацией + область
  («По всем настройкам» / «Только в кастомизации» = секция theme).
  settings/searchIndex.ts: SETTINGS_SEARCH_INDEX {section, keys[]} — матчи по
  локализованным подписям в рантайме (все языки). Непустой запрос заменяет
  nav списком результатов (разделы тоже ищутся), клик → goto(section).
  searchIndex пополнять при новых настройках.

### F11 ДЕФОЛТ + ВОЗВРАТ В MAXIMIZE ПОСЛЕ ФУЛСКРИНА (27.09, verify all 38s)
- toggle_fullscreen дефолтный бинд F11 (SHORTCUT_DEFAULTS; мерж
  {...DEFAULTS, ...saved} — подхватится и у существующих shortcuts.json).
- Фикс: F11 из фулскрина падал в ОКОННЫЙ режим вместо развёрнутого — tao
  восстанавливает сохранённое до фулскрина размещение АСИНХРОННО и перебивал
  немедленный maximize. Лечение: после set_fullscreen(false) пауза 70мс, потом
  maximize (если FS_WAS_MAX) + nudge. Семантика: F11 ходит только
  оконный↔фулскрин поверх maximize; в оконный режим — только кнопка □.

### КНОПКА ⤢ УБРАНА + ТРЕЙ-ДИАГНОСТИКА (27.09, verify all зелёный)
- Кнопка fullscreen (⤢) из WindowControls УДАЛЕНА (путалась с maximize в третий
  раз; переход fullscreen↔оконный у безрамочных окон дёргает DWM на любом
  железе — лечению не поддаётся на нашем слое). Вместо неё: НОВОЕ НАЗНАЧАЕМОЕ
  ДЕЙСТВИЕ toggle_fullscreen в «Горячих клавишах» (SHORTCUT_ACTIONS +
  SHORTCUT_LABEL_KEYS→win.fullscreen, диспетчер → invoke
  window_toggle_fullscreen). «Всегда в полный экран» как настройка — опция
  на будущее, не сделана. Стейт-машина isFullscreen в WindowControls удалена.
- Трей «Open Nocturn» не работал и после unminimize-фикса (Quit при этом
  работал → диспатч меню жив, ломается показ окна). Форс-приём: unminimize →
  show → always_on_top(true)→(false) → set_focus (обход foreground-lock
  Windows). + eprintln-диагностика: [tray] menu event / visible/minimized/
  focused / «main window NOT found» — в консоли tauri dev, чтобы на след.
  раунд увидеть, где затыкается, если снова не сработает. Clear All Data —
  тот же путь показа + emit clear-data-request.

### МОЦИОН-СИСТЕМА: ТОКЕНЫ + СКОРОСТЬ + EXIT + VIEW TRANSITIONS (27.09, verify all 39.5s)
План согласован владельцем (аудит → M3-практики → 5 волн). Реализовано:
- Волна A: motion-токены в :root — --motion-fast/base/slow (calc(120/220/320ms *
  --motion-scale)), --ease-enter cubic-bezier(0.05,0.7,0.1,1) / --ease-exit
  (0.3,0,0.8,0.15) / --ease-standard; ВСЕ anim-классы переведены на токены.
  src/motion.ts: useDelayedUnmount(open, ms) (общий exit-паттерн вместо
  копипасты), withViewTransition(update) (flushSync внутри startViewTransition,
  фолбэк reduce-motion/нет-VT), exitDuration(). anim-slide-left РАНЬШЕ НЕ
  СУЩЕСТВОВАЛ в CSS (мёртвый класс — панели появлялись мгновенно) — теперь
  въезд+выезд slide-left/slide-left-out.
- Волна A.5: appearance.motionScale (0.7/1/1.4, дефолт 1, themeProfiles
  passthrough) → --motion-scale; ThemeSection: «Продвинутые стили» переименованы
  в «Продвинутые настройки» (themes.gAdvanced ×4), под «Пользовательский CSS» —
  блок «Скорость анимаций» (3 пресета × multiply; «Меньше движения» = выкл).
- Волна B: exit-анимации SystemPromptModal, AutomationsModal
  (useDelayedUnmount + anim-pop/fade↔pop-out/fade-out); SettingsModal переведён
  на useDelayedUnmount. ОТЛОЖЕНО: NotesModal/GraphModal/ResetConfirmModal
  (родительский условный рендер по данным — нужен рефакторинг пропсов),
  CryptoGate (особые потоки), Toast-exit (нужен leaving-стейт в useToasts).
- Волна C: withViewTransition на: handleNewChat (Ctrl+N и кнопка), выбор задачи
  в сайдбаре (onSelect), открытие/закрытие поиска (шорткат+кнопка+onClose),
  выбор из поиска (закрывает+переключает). SearchModal: scoped VT
  (.search-vt → view-transition-name: search-panel, въезд сверху, внутренние
  anim-pop гасятся при VT — снапшот управляет морфом).
- Волна D: Diff/Plan/Browser панели — useDelayedUnmount + anim-slide-left /
  slide-left-out (настоящий въезд/выезд). Сайдбар УЖЕ был анимирован
  (transition-[width,opacity]) — аудит-ремарка снята. TerminalPanel не тронут
  (живой PTY, вход-only анимация — по желанию позже).

### ФУЛСКРИН ИЗ MAXIMIZED: ЧЁРНАЯ ПОЛОСА (27.09, verify all зелёный)
Точная последовательность пользователя: фулскрин → оконный → maximize (таскбар
виден) → фулскрин → ЧЁРНАЯ ПОЛОСА. Диагноз: вход в native fullscreen ИЗ
нативно-maximized безрамочного окна — NCCALCSIZE максимизированного инсетит
клиент в rcWork и во фулскрине внизу остаётся фон окна (тёмная полоса на месте
таскбара). Фикс: FS_WAS_MAX (AtomicBool) — перед входом в фулскрин с
is_maximized → unmaximize; на выходе → maximize обратно (и в
window_toggle_fullscreen, и в maximize-ветке window_toggle_maximize).
Состояние «из maximize» переживает фулскрин.

### NUDGE НА ВЫХОДЕ ИЗ FULLSCREEN (27.09, verify all зелёный)
Чёрная полоса оставалась при переключении оконный↔полноэкранный: nudge стоял
только на unmaximize, а кнопка ⤢ ходила напрямую через JS setFullscreen.
Добавлено: window_toggle_fullscreen (Rust) — set_fullscreen(!is_fullscreen) +
nudge на ВЫХОДЕ из фулскрина (shell «rude fullscreen» не отпускает панель);
кнопка ⤴ → invoke с фолбэком; maximize-ветка тоже nudжит после выхода из
фулскрина.

### ЗАТМЕНИЕ: TOPMOST ПО ФОКУСУ (27.09, verify all 46.3s)
ALT+TAB/клик по панели задач «не работали» в затмении: переключение ПРОИСХОДИЛО,
но постоянный always-on-top оставлял наше окно поверх выбранного приложения.
Фикс: topmost по фокусу — RunEvent::WindowEvent(Focused) при активном FS_SAVE:
focus → always_on_top(true) (затмение накрывает таскбар), blur → false
(выбранное приложение видно, таскбар возвращается). Возврат в Nocturn —
клик по иконке/alt-tab: фокус вернулся → topmost вернулся. WIN+D больше не
единственный способ уйти.

### ЗАТМЕНИЕ БЕЗ ИНТЕРПОЛЯЦИИ (27.09, verify all 47s)
Владелец: при F11 «нескриншотелимые» артефакты. Диагноз: живой ресайз WebView2 —
каждый шаг интерполяции = кадр, где вебвью отстаёт от рамки (смаз/тёмные края).
Затмение и выход — ОДИН атомарный SetWindowPos (DWM растягивает старый кадр на
1-2 кадра, вебвью не перерисовывается в полёте). animate_bounds удалена,
set_window_bounds остался. Если владельцу захочется «подвижности» — компромисс
2-3 крупными шагами, но по умолчанию чистый прыжок.

### ЗАТМЕНИЕ: TOPMOST + КОМПЕНСАЦИЯ ГРАНИЦ; ПОИСК СО СКРОЛЛОМ К ПУНКТУ (27.09)
- F11-затмение: окно теперь set_always_on_top(true) НА ВСЁ затмение (таскбар
  сам topmost — обычному окну под него не зайти, было «ЗА таскбаром»), на
  выходе снимается. Целевой прямоугольник расширяется на невидимые DWM-границы
  безрамочного окна (outer-inner ×2 — expand_by_borders) — «отступы по бокам».
- Поиск настроек: клик по результату теперь withViewTransition(goto) +
  pendingItem(label) → effect ищет в контентной колонке самый короткий элемент
  с этим текстом, scrollIntoView(center, smooth) + .search-hit (вспышка
  акцентом 1.6s через color-mix). Работает в обеих областях и внутри текущей
  секции. Панель контента получила contentPaneRef. До этого клик из области
  «Только в кастомизации» «не переносил» — goto в ту же секцию был no-op.
- Краш поиска (прошлый раунд) долечен: guard t(key) ?? "" (undefined.toLowerCase).

### F11 = «ЗАТМЕНИЕ» ГЕОМЕТРИЕЙ (27.09, verify all 54.4s)
Native set_fullscreen на безрамочных окнах Windows бит апстримом (tauri#7473 —
тайтлбар+таскбар не исчезают; #7328 — таскбар поверх; #8383 — restore теряется)
— потому F11 «скачет» и не прячет таскбар. Переписано: F11 больше НЕ трогает
set_fullscreen. Семантика «затмения» (как просил владелец — «только закрытие
или нет панели задач»): вход — окно анимированно (animate_bounds, 13×15мс,
атомарный SetWindowPos) накрывает ВЕСЬ монитор (rcMonitor; shell сам прячет
таскбар для сфокуссированного окна в границах монитора — проверено на машине
владельца «чёрным блоком»), выход — возврат к сохранённым границам (+maximize,
если оттуда пришли). FS_SAVE: Mutex<Option<SavedBounds>> (type alias для
clippy type_complexity). Кнопка □ во время «затмения» → тот же toggle.
Вернулась машинерия: WinRect/monitor_rects/set_window_bounds/animate_bounds/
window_rect (v5-версии были вырезаны в v6).
- Поиск по настройкам КРАШ при вводе (ErrorBoundary «reading 'toLowerCase'»):
  индекс содержал непроверенные ключи локалей (browser.enabled, net.proxy,
  themes.gStyle и ещё ~20) — t(key) давал undefined. Индекс переписан на
  ВЕРИФИЦИРОВАННЫЕ ключи (скрипт-сверка против ru.ts, missing: []), в поиске
  guard «?? '' + typeof label === string» — протухший ключ больше не роняет.
  Правило: при пополнении searchIndex сверять ключи со словарями.
- «Лениво» (печатная скорость) — оставлено по решению владельца (50/50 тон).
- Плавная печать — ТОЛЬКО для вывода ИИ (AssistantCard); на ввод пользователя
  в композере не распространяется (ввод по природе мгновенный; добавление
  задержки = латентность в печати).

### HARD-MODE ПЕРЕДЕЛАН ПО ТУМБЛЕРУ (27.09, verify all 29.5s, коммит 4f962b7→новый)
Фидбек владельца: /hard и /q не место в палитре «/» (она про чат), вход — по
хоткею. Переписано: тумблер в «Основном» только РАЗРЕШАЕТ режим (выключение
снимает скин), вход/выход терминального скина — назначаемое действие
hard_mode (SHORTCUT_ACTIONS, дефолт Ctrl+Shift+H, SHORTCUT_LABEL_KEYS sc.hardMode).
Два стейта: haloui-hard-mode (разрешение) + haloui-hard-skin (активен);
класс html.hard-mode = hardMode && hardSkin. Без тумблера хоткей тостит
hard.needEnable. /hard и /q из реестра команд удалены, cmd.hard/cmd.q — ключи
локалей не используются (оставлены в словарях).

### AMBIENT-СЛОИ + HARD-MODE (27.09, verify all 38.9s, коммит ab05de3)
- Ритуал коммитов изменён владельцем: агент коммитит локально сам (AGENTS.md
  ритуал 3 переписан), пуш — владелец. .zcode/ в .gitignore.
- Сводный коммит ab05de3 (127 файлов, +18109/-2462) — вся пачка фич.
- Обои чата («Своя картинка») подняты с колонки чата на уровень окна
  (fixed z-0 в App) — раньше «не уходили за сайдбар». html.has-wallpaper:
  .bg-halo-bg и aside.bg-halo-deep → color-mix 86% прозрачности (фон виден
  сквозь). Ambient «за интерфейсом»: то же для aside (был обрыв на границе).
  ChatArea-проп chatWallpaper удалён (переехал в App + convertFileSrc).
- HARD-MODE v1: преф haloui-hard-mode, html.hard-mode — --halo-radius-scale:0
  (прямые углы через радиус-токены), моношрифт, .glass-pane/.msg-glass без
  backdrop-filter + плоский фон, ambient скрыт. Команды /hard (toggle) и /q
  (выход) в реестре App. Баннер .hard-banner снизу (не перекрывает кнопки
  окна): «HARD MODE · /hard — выход». Тумблер в «Основном».
- НЕ сделано (осознанно): блокировка мыши (пасхалка в баннере, не в
  поведении), Ctrl+K-палитра (отдельная фича), Vim-навигация, «:q» без
  слэша (палитра триггерится на «/»).

### САПЁР: СЧЁТЧИК И БАННЕР КОНЦА (27.09, verify all 39.3s)
- Счётчик мин показывал 🚩19 при 10 минах: формула двойного учёта (мины -
  чужие флажки + непомеченные мины). Классика: MINES - поставленные флажки
  (в минус — как в оригинале).
- Оверлей конца игры затемнял поле на 85% — мины после проигрыша не видны
  (весь смысл). Заменён на баннер под шапкой (зелёный/красный + «Заново»),
  поле полностью видимо, клетки защищены guard'ами click/flag.
- ГРАБЛИ: heredoc обрезался на полдороги (файл порван) — длинные файлы
  перезаписывать Write-инструментом, не cat-heredoc'ом.

### САПЁР: КЛАССИЧЕСКИЙ ВИД (27.09, verify all 45s)
Доска была невидимой целиком (тёмное-на-тёмном на прозрачном контенте).
Классический вид как на референсе владельца (cane.gom): рамка с шапкой —
счётчик мин (🚩00, mono red), смайлик-кнопка рестарта (🙂/😵/😎), таймер (⏱000);
поле из ФИКСИРОВАННЫХ клеток 36px (grid repeat(9,36px) — без fr/aspect), клетки:
нераскрытые — «выпуклые» (bg-halo-raised + inset-тени свет/тень — каскадные
border-цвета в Tailwind перекрывают друг друга, бевел собран тенями),
раскрытые — утопленные bg-halo-deep + ring, цифры в классической гамме,
мины 💣 на красном. ГРАБЛЯ: python-патч с якорем "  return (" совпал с
cleanup-строкой таймера ВНУТРИ useEffect и вырезал reset/click/flag/flagsLeft —
восстановлены; якоря патчей должны быть уникальными многострочными.

### ФИКСЫ ИГР (27.09)
- 2048 «все блоки разом»: (а) off-by-one в move() — после слияния target
  инкрементировался, оставляя ДЫРКИ в линии (плитки не компактились, доска
  ломалась); слияние НЕ двигает target. (б) сайд-эффекты (spawn/setScore/
  setOver) внутри setTiles-updater — StrictMode звал их ДВАЖДЫ, ход
  применялся по два раза; расчёт вынесен наружу через tilesRef-зеркало.
- Змейка «всегда Игра окончена»: первый dt rAF = времени жизни страницы
  (тысячи тиков за кадр → стена), после паузы/фона — то же; «Заново» не
  помогало — аккумулятор не сбрасывался. Фикс: clamp dt ≤ 200мс + accRef=0
  в reset.
- Сапёр: доска была невидимой (тёмное-на-тёмном, контент-панель прозрачна) —
  плотная обёртка (bg-halo-deep + p-3) и клетки: нераскрытые bg-halo-raised +
  ring, раскрытые bg-halo-deep + ring, цифры цветные.
- Карточки «Отдыха»: hover — подъём (-translate-y-1 + shadow, БЕЗ
  transition-all — [transform,box-shadow,border-color]); превью змейки
  «ползёт» на hover (CSS snake-crawl, глушится motion-reduced).

### ОТДЫХ: ВКЛАДКА МИНИ-ИГР (27.09, verify all 39.1s)
Вкладка «Отдых» (Section "rest", своя NAV-группа nav.rest МЕЖДУ данными и
справкой, иконка gamepad в SectionIcon). По решению владельца: игры играются
ПРЯМО ВНУТРИ вкладки — при входе в игру настройки скрываются, остаётся игра и
подсказка «ESC — вернуться к мини-играм» (+ кнопка «К играм»); Esc-иерархия в
SettingsModal: restGame → закрыть игру, иначе закрыть модалку (setState в
Esc-обработчике через функциональную форму, onClose вызывается из неё).

- src/games/: Game2048 (плитки с id, transform-анимация движения 110мс, pop на
  слияние/появление, WASD/стрелки (capture+preventDefault+stopPropagation),
  свайпы pointer-событиями, одна отмена хода (historyRef), победа на 2048 с
  «Продолжить», проигрыш-детект «нет ходов»), GameMines (9×9/10 мин, ПЕРВЫЙ
  клик безопасен — мины после него без клетки и соседей, flood-fill нулей,
  ПКМ-флажки (onContextMenu), таймер с первого клика (setInterval, чистится),
  лучшее время), GameSnake (canvas 21×21 CELL 16, DPR-scale, rAF+аккумулятор,
  ускорение 150→70мс, очередь направлений с запретом разворота, пауза
  пробелом И по blur окна, рекорд, змейка/еда в --halo-accent).
- RestSection: 3 карточки (CSS-превью: плитки/флажки/змейка на токенах, hover
  scale), «Рекорд: N» (localStorage haloui-game-*, перечитывается при выходе
  из игры), кнопка «Играть». Гейм-режим скрывает всё содержимое настроек.
- noUncheckedIndexedAccess: во всех играх гаранды на индексы (next[i], snake[i],
  line[target]...). Глобальные хоткеи приложения не глушатся (стрелки —
  preventDefault в capture-фазе игры), стрелки не скроллят настройки.
- searchIndex += rest. Локали game.* ×4 (game.back, game.spacePause и др.).

### ИТОГ РАЗВОРОТА: НАТИВНЫЙ MAXIMIZE + NUDGE ПОСЛЕ RESTORE (27.09, verify all 58s)
Пользователь: анимированная версия всё равно дёргает (один монитор 1920×1200 на
75Гц — GPU-scaling добавляет кадр). Вывод: ЛЮБОЙ живой ресайз окна заставляет
WebView2 отставать (тёмные края «ползут») — интерполяция шагами принципиально
не лечится на нашем слое; плавный морф делает только DWM на нативных
maximize/restore (масштабирует СТАРЫЙ кадр, вебвью в полёте не перерисовывается).
Переписано: window_toggle_maximize = нативный maximize/unmaximize + ПОСЛЕ
unmaximize одноразовый nudge (сдвиг 1px на 16мс и обратно) — стряхивает
рассинхрон WebView2/shell (чёрная полоса таскбара, съехавший контент).
minimized → unminimize; fullscreen → выход. Анимационная машинерия (OUR_MAX/
animate_bounds/monitor_work_area/SetWindowPos) удалена. Остаточный ~100мс
settle при restore — перерисовка всего DOM на новом размере, присутствует и в
VS Code; тёмный фон смягчает. Chrome_WidgetWin_0 unregister error — шум teardown.

### РАЗВОРОТ ОКНА: СОБСТВЕННАЯ АНИМАЦИЯ ВМЕСТО НАТИВНОГО MAXIMIZE (27.09, verify all 48s)
Закономерность пользователя: из оконного режима maximize — таскбар виден и
анимация есть (нативная DWM), а restore из maximized — дёргает и чёрная полоса
на месте таскбара; циклы maximize↔restore ломают фулскрин («криво, с линиями,
не перекрывает таскбар»). Подтверждено интернетом: tao#471 (чёрный экран
maximized frameless), WebView2Feedback#2549 (blank, мультимонитор; фикс tao
«fix window size for maximized, undecorated windows» чинит РАЗМЕР, но циклы
состояния tao остаются хрупкими). Решение: нативный maximize не используем
ВООБЩЕ — window_toggle_maximize (async, spawn_blocking не нужен: command(async))
— состояние OUR_MAX + анимация границ: 13 шагов × 15мс, ease-out cubic,
КАЖДЫЙ шаг — атомарный SetWindowPos (move+size одним вызовом; раздельные
set_position/set_size = два разрыва кадра на шаг). maximize = work area
монитора (MonitorFromWindow+GetMonitorInfoW), restore = сохранённые границы.
Ветви: minimized → unminimize; fullscreen → выйти; is_maximized (двойной клик
по шапке/снап системой — нативный maximize через drag-region) → unmaximize
(DWM анимирует сам, tao возвращает pre-maximize границы). WindowControls □ →
invoke("window_toggle_maximize"), фолбэк — нативный toggle. Тёмный
set_background_color остался (мажет непрокрашенные кадры между шагами).
Chrome_WidgetWin_0 «Failed to unregister… Error=1412» в дебаггере — известный
безвредный шум teardown WebView2 при закрытии приложения, не связано.
Fullscreen ⤴ остаётся нативным: из чистого (ненативно-maximized) состояния
tao покрывает монитор целиком и shell прячет таскбар.

### РАЗВОРОТ ОКНА ОТКАЧЕН НА НАТИВНЫЙ + ТЁМНЫЙ ФОН (27.09, verify all зелёный 65s)
Пользователь подтвердил: белый «каркас из Windows 7» при развороте — непрокрашенный
кадр нашего окна (WebView2 дефолтно белый), таскбар статичный. Глубокая проверка
tao 0.35.3: WM_NCCALCSIZE УЖЕ держит безрамочное maximized-окно в rcWork (не
перекрывает таскбар, авто-скрытие обработано) — ручной work-area maximize был
борьбой с уже решённым и приносил: мгновенный телепорт без DWM-анимации, два
отдельных set_position/set_size (два разрыва), белый кадр WebView2, гост старого
кадра, промежуточный unmaximize-прыжок. Исходный «чёрный таскбар» — скорее всего
кнопка ⤢ fullscreen (скрывается по определению ОС). Откат: WindowControls →
нативный win.toggleMaximize(), window_maximize_toggle + FAKE_MAX удалены.
lib.rs setup: set_background_color(Color(0x26,0x26,0x24,255)) (#262624 = --halo-bg
тёмной темы) на main-окно и вебвью — непрокрашенные кадры больше не белые.
Опционально на будущее: nudge после выхода из fullscreen, если «чёрный таскбар»
проявится снова; не путать пользовательские ⤢ (fullscreen) и □ (maximize).

### АНИМАЦИИ МОДАЛКИ ПЕРЕПИСАНЫ НА VIEW TRANSITIONS (27.09, verify all зелёный)
Жалоба: разворот/сворачивание «дёрганное». Причина: transition-[width,height] —
reflow ВСЕГО контента модалки каждый кадр (layout thrashing; web.dev/FLIP:
анимировать только transform/opacity). Переписано:
- Разворот/сворачивание: View Transitions API с feature-detect
  (setExpandedSmooth: doc.startViewTransition(() => flushSync(() => setExpanded)))
  — снапшоты старого/нового состояния, анимация на композиторе. Scoped-морф:
  .settings-vt { view-transition-name: settings-panel } + ::view-transition-
  old/new(settings-panel) 240ms; root-кроссфейд 150ms. Фолбэки: нет VT
  (старый WebKitGTK) или prefers-reduced-motion → мгновенная смена размера.
  transition-[width,height] удалён полностью.
- Закрытие: панель anim-pop-out (scale+fade 160ms) + backdrop-filter:none на
  время выхода (живой blur пересчитывался каждый кадр — дорого), оверлей
  anim-fade-out вместо мгновенного исчезновения затемнения.
- Открытие — прежний anim-pop. Глушение reduce-motion: JS-проверка для VT,
  CSS-правило для anim-pop-out/fade-out.

### ФИКС «мёртвой» кнопки развернуть (27.09, verify all зелёный)
window_maximize_toggle имел тихий no-op: ранний Ok(()) при is_fullscreen() —
застрявшее fullscreen-состояние (F11 меняет его мимо нас) делало клик мёртвым,
фолбэк не срабатывал (ошибки нет). Теперь ранних Ok нет: minimized → unminimize,
fullscreen → set_fullscreen(false) + продолжаем; restore-ветка снимает нативный
maximize перед set_position/set_size (иначе игнорируются); захват прежних
границ — после unmaximize. Любая ошибка команды → фолбэк нативного toggle на
фронте (видимый эффект гарантирован во всех путях).

### БЫСТРЫЕ ФИКСЫ ОТЧЁТА (27.09, verify all зелёный 59s)
- Роль в профиле снимается повторным кликом (как язык/тон); «для модели» →
  «Для модели» (ru/en с заглавной).
- Анимации SettingsModal: контейнер transition-[width,height] 300ms ease-out —
  плавный разворот/сворачивание (expanded ↔ оконный режим, включая settingsLarge);
  ПЛАВНОЕ ЗАКРЫТИЕ: renderOpen/closing-состояние — при open=false модалка
  доигрывает anim-pop-out (0.16s scale+fade, keyframes добавлены, глушится
  motion-reduced) и только потом размонтируется.
- ФИКС «чёрная панель задач» (Windows): нативный maximize БЕЗРАМОЧНОГО окна
  перекрывает таскбар (кадр убран — рабочая область не учитывается, вместо
  панели виден тёмный фон приложения). window_maximize_toggle (lib.rs):
  вручную разворачивает в work area монитора (MonitorFromWindow +
  GetMonitorInfoW через raw extern user32 — как shell32-трюк), прежние границы
  в static FAKE_MAX для отката; нативный maximize (снап системой) снимается
  перед установкой; в fullscreen кнопка игнорируется; не-Windows — нативный
  toggle. WindowControls «развернуть» → invoke + фолбэк toggleMaximize.

### ПРОФИЛЬ ПОЛЬЗОВАТЕЛЯ (27.09, verify all зелёный; идея владельца — «local-account»
как онбординг Claude Desktop, но без облака и С ПЕРФИЛЬДНЫМИ share-тумблерами)
Принцип анонимности (жёстко): по умолчанию НИЧЕГО не уходит модели; каждое
личное поле имеет собственный тумблер «для модели»; аватар — чистый UI и в
промт не попадает никогда.

- src/userProfile.ts: UserProfile{name/nameShare, avatar(UI-only), role
  (RoleId: se/product/design/data/student/other)+roleCustom/roleShare,
  answersLang/langShare, tone/toneShare, stack/focus/instructions + share}.
  localStorage haloui-user-profile (один JSON), saveProfile пишет, аватар
  кэшируется модулем (getUserAvatar — без localStorage на каждый рендер
  ленты). buildProfileBlock(): system-блок ТОЛЬКО из расшаренных полей,
  null если пусто; роли/языки/тон — канонические английские подписи для
  модели (ROLE_EN/LANG_EN/TONE_EN), UI — локализованные.
- Вкладка «Профиль пользователя» (Section "profile", NAV Basics после main,
  иконка users): блок «Кто ты» (аватар upload → canvas downscale 256px JPEG
  в localStorage + имя), блок «Как агенту работать» (роль сегментами + свой
  вариант, язык ответов ru/en/zh/ja, тон neutral/concise/detailed/friendly/
  formal, стек, фокус, свободные инструкции — КАЖДОЕ с ShareToggle «для
  модели»), подпись прозрачности. Сохранение мгновенное, без кнопки.
- Инъекция: useAgentRun после правил проекта (buildProfileBlock → system).
  UI-эффекты: приветствие пустой ленты «{greeting}, {имя}» (только к
  time-приветствию; кастомное из appearance не трогаем), аватар слева от
  user-карточки (UserCard — flex-обёртка, снапшоты перегенерированы -u).
- НЕ сделано (сознательно): шаги в онбординге (владелец просил «не навязывать»)
  — можно добавить позже с skip-ом; редактирование remote-MCP (удалить/заново).
- Грабли: heredoc СЪЕЛ 
 в python-патче (дважды!) — только chr(92);
  локали-якоря с многострочными значениями (planNotice/importHint) — вставлять
  перед СЛЕДУЮЩИМ ключом, не после строки якоря.

### СЛИЯНИЕ «ОБЗОР» + «СТАТИСТИКА» (27.09, verify all зелёный)
Решение владельца: две похожие вкладки → одна. Вкладка usage удалена из NAV и
Section-типа; объединённая «Обзор» (id reflect, иконка chart) в nav.data:
период 7/30 (ОДИН селектор) → метрики периода → UsageSection (showHeader=false,
rangeDays/onRangeChange — управляемый диапазон, внутренний селектор «Диапазон»
скрыт при управлении снаружи) → незавершённые планы → Рефлексия.
UsageSection: range = rangeDays ?? innerRange, setRange → onRangeChange ?? inner.
Stale-ссылок на "usage" нет. Ключ usage.* остались (используются блоком).

### КОНКУРЕНТНЫЕ ФИЧИ №2/3/4/6 ИЗ PLAN §7 (27.09, verify all зелёный 45s)
- №2 ВЕБ-ПОИСК: новый модуль websearch.rs — тул web_search (SearXNG своим
  инстансом без ключа или Brave API по ключу юзера; urlencode вручную, потолок
  JSON 8МБ, сниппеты 300 симв, count 1-10 дефолт 5, дедуп не нужен). Конфиг
  websearch.json + снапшот CONFIG (по образцу imagegen), ключ Brave на диск
  шифруется (websearch_get/set_config в tooling.rs). Роутинг в
  execute_tool_inner: async напрямую (reqwest + прокси/CA из network.rs),
  abort-проверка на входе, дубль-проверка тумблера. Схема в get_tool_schemas
  только при enabled. UI: WebSearchSection (тумблер + сегмент провайдера +
  url/ключ) — вкладка «Веб-поиск» в nav.agent рядом с imagegen. Ключи ws.* ×4.
- №3 ПРАВИЛА ПРОЕКТА: files.rs project_rules_read(root) — AGENTS.md или
  CLAUDE.md из корня (имена фиксированы, traversal исключён, потолок 32КБ).
  useAgentRun: перед блоком памяти инъекция system «agent.rulesBlock» +
  содержимое, если projectRootRef задан. Паттерн CLAUDE.md закрыт.
- №4 RAG-LITE: (а) тул fs_grep — рекурсивный поиск по СОДЕРЖИМОМУ файлов
  (case-insensitive, file:line: text, потолки 512КБ/файл, 4000 файлов, 50
  результатов; skip .git/node_modules/target/dist/...; бинарники по нулевому
  байту). Схема в builtin, perm.rs: fs_tool → path-контроль в plan/edit (не
  mutating). (б) Текстовые документы-вложения в чат: Attachment {dataUrl?,
  text?} — readFile ветвит image/text (текстовые ≤5МБ принимаются, кап 512КБ
  + «[file truncated]»), accept += text/* и коды файлов, превью — чип 📄, в
  модели: toApiContent инлайнит «--- Attached file: name ---» + fenced-блок
  (без картинок — строкой, с картинками — text-частью). vision-предупреждение
  только при наличии dataUrl. Тесты: fs_grep (tools.rs), history (13/13),
  websearch (3).
- №6 MCP REMOTE: mcp.rs — McpServerConfig += transport("http"/"sse")/url/
  headers; RemoteConnection (async reqwest): streamable HTTP (POST JSON-RPC,
  Accept json+sse, ответ JSON ИЛИ SSE — extract_rpc_response берёт data: с
  нашим id; сессия Mcp-Session-Id запоминается), initialize→initialized→
  tools/list. McpHandle{Stdio(Arc),Remote(Arc)} — единая поверхность
  (tools_clone/kill/call_tool async; stdio внутри spawn_blocking). Реестр на
  Arc<McpHandle>; tooling: call_tool async, select! с таймаутом 120с и
  wait_for_abort (Stop убивает и remote-вызовы). mcp_connect: remote — await
  напрямую; autoconnect: stdio в потоках + remote параллельно join_all.
  OAuth-танца нет: статические заголовки (Authorization: Bearer …) покрывают
  hosted-серверы; легаси HTTP+SSE-транспорт не реализован (метка sse ходит
  streamable HTTP). mcp.json: токены ПЛАГИНОМ НЕ ШИФРУЮТСЯ — предупреждение
  в UI. McpSection: сегмент транспорта, url + textarea заголовков («Name:
  value» построчно), импорт понимает {"type":"http","url","headers"}; строка
  списка показывает «http · url». Тесты: extract_rpc_response (SSE/JSON/miss),
  parse_rpc_result. Грабли: McpHandle::call_tool — tool: &str в 'static
  замыкание spawn_blocking не живёт → String; тест fs_grep — путь Windows в
  JSON требует экранирования бэкслэшей.
- tool_schemas_valid: 5 → 6 схем (fs_grep).

### АУДИТ STOP→KILL + РАЗБОР ОШИБОК АУДИТОРА (27.09)
Проверка «Stop убивает процессы агента?» — ДА, трасса: handleStop →
abortChat(requestId) → флаг в AbortRegistry; run_tool на время тулл-кола
ставит свежий флаг (AbortGuard стрима уже вычистил свой) → proc::finish
поллит флаг каждые 50мс → kill_tree (taskkill /T /F на Windows, kill -pgid на
Unix). Добавлен регресс-тест proc::abort_kills_process_immediately (abort за
500мс убивает 30-секундный sleep мгновенно). Известное миллисекундное окно:
Stop МЕЖДУ концом стрима и стартом инстру — abortChat не находит записи
(флаг ещё не создан), тулл доработает; фронтовый abortedRef не даст
СЛЕДУЮЩИЕ инструменты. PTY-терминалы и MCP-серверы Stop не гасит (сознательно:
пользовательский терминал и долгоживущие серверы; MCP гасятся на выходе).

Разбор скриншота аудитора (exit 1, кракозябры в stderr): аудитор прислал
BASH-синтаксис (`cat /proc/mounts 2>nul || mount ...`) — shell_run на Windows
исполняет через powershell (5.1), где `||` между пайплайнами — ParserError
(появился только в PS7). Из-за ПАРС-ошибки не выполнился и наш префикс
[Console]::OutputEncoding=UTF8 (весь -Command валидируется целиком) → PowerShell
написал ошибку в OEM cp866 → clip() декодирует from_utf8_lossy → U+FFFD-кракозябры.
ВАРИАНТ ФИКСА (не делан, ждёт решения): fallback-декодирование stderr/stdout
через encoding_rs::IBM866 при невалидном UTF-8 (или валидация команды до запуска).

### ФИКСЫ ПО РЕЗУЛЬТАТАМ БАГРЕПОРТА (27.09, verify all зелёный)
- «Работал N сек» крутился сам и завышался (646с на ~84с прогона): markWorked
  в агентном цикле мерял КАЖДЫЙ шаг от старта ПРОГОНА (startedAt), а
  groupTurns-мердж СУММИРУЕТ workedMs шагов → квадратичный рост. Фикс:
  markWorked(assistantId, fromMs = startedAt) + stepStartedAt на шаг (рядом с
  assistantId в цикле); одиночный режим — дефолт (сообщение = весь прогон).
  usage-лог (workedMs прогона в finalize) не тронут — там от прогона и правильно.
- Трей «Open Nocturn» не поднимал окно: hide→show на Windows без unminimize
  не восстанавливает свёрнутое/скрытое окно (в single-instance unminimize был,
  в трее — нет). Добавлен unminimize во все три места: пункт меню open,
  clear-data и левый клик по иконке.

### REFLECT — ВКЛАДКА «ОБЗОР» (27.09, verify all зелёный)
Решение владельца: делать Reflect, Whisper — «подумать» (оценка: локальный
whisper-rs — сильный дифференциатор, но самая дорогая фича; Web Speech API
в WebView2 НЕ работает; сначала дистрибуция/Reflect).

- Размещение: НОВАЯ СЕКЦИЯ SettingsModal «Обзор» (settings.reflect, иконка
  spark) в группе Data рядом со «Статистикой» — вкладки = секции настроек.
- Rust: chat.rs chat_once (base_url/api_key/model/provider/system/user/
  max_tokens) — разовый non-streaming вызов БЕЗ инструментов, адаптер
  провайдера тот же (anthropic: system топ-уровнем + content-блоки type=text;
  openai: choices[0].message.content), total timeout 180 c, пустой ответ —
  ошибка. Зарегистрирован в lib.rs рядом с test_connection.
- src/reflect.ts — ЧИСТАЯ агрегация (nowMs параметром, тесты детерминированы):
  buildReflect (задачи создано/активных по createdAt/updatedAt/последнему ts
  сообщения, user-сообщения по ts, токены из usageLog по day-key строке
  (граница включительно), факты ms / заметки СЕКУНДЫ (notes_list!),
  stalled-планы: plan с не-done, сортировка по свежести, топ-5, архив мимо)
  + buildReflectPrompt (плоский текст с локализованными подписями — labels
  передаёт вызывающий). Тесты src/reflect.test.ts (7 шт).
- components/settings/ReflectSection.tsx: период 7/30, сетка чисел,
  stalled-список с чипами «в работе/ждут», кнопка «Рефлексия» (chatOnce,
  maxTokens 600) + «Скопировать» и «В заметки» (notesWrite
  reflect-YYYY-MM-DD-HHMM.md, счётчик заметок обновляется через tick-эффект).
  Приватность-строка: модели уходит только локальная сводка.
- Wiring: Section += "reflect"; SettingsModal — проп usageLog (App передаёт
  usageLog={usageLog}), NAV data-group += reflect, render ReflectSection
  (sessions + usageLog + apiSettings — для chatOnce).
- ФИКС QE «обводка по бокам»: (1) shadow:true у ПРОЗРАЧНОГО окна рисует
  DWM-рамку по прямоугольнику окна → quickentry shadow:false в conf; (2)
  панельная shadow-2xl обрезалась границами окна → shadow-lg + внешние поля
  p-2.5 (PAD=10) под разлёт тени; (3) focus-within-акцент-рамка снята — поле
  в QE всегда в фокусе, в композере её видят только при фокусе. Тема теперь
  перечитывается на КАЖДЫЙ показ окна (onFocusChanged → applyTheme():
  loadAppearance+applyAppearance+html.light): окно живёт скрытым с старта,
  смена темы/радиусов в главном окне иначе подтягивалась бы только после
  рестарта. Углы (rounded-2xl) идут через var(--radius-2xl) =
  calc(...*--halo-radius-scale) — масштабируются автоматически. Высота окна —
  по контенту: ResizeObserver панели → setSize(540, h+PAD*2) (масштаб шрифта
  и переносы не обрезаются; защита от дребезга lastH).
- РЕДАЙЗН Quick Entry «как композер»: панель glass-pane rounded-2xl +
  скрепка + круглая кнопка ↑ (bg-halo-accent, hover deep, disabled при пустом
  поле) + нижний ряд «подсказка слева / модель справа» (loadSettings →
  ProviderIcon + shortModelName). Placeholder — общий composer.placeholder.
  ТЕМА: у окна QE нет App — main.tsx в ветке isQuickEntry применяет
  loadAppearance()+applyAppearance() и html.light (haloui-theme, forceDark
  при official) ДО первого рендера. Высота окна 64→96 (conf + fallback в
  position_quickentry). ГРАБЛЯ: клик по кнопке отправки гасил фокус поля →
  onBlur прятал окно ДО отправки — лечится onMouseDown preventDefault на
  кнопке (клик не уводит фокус). quickentry.placeholder заменён на
  quickentry.hint («Enter — отправить · Esc — закрыть») ×4.
- ФИКС Quick Entry «появляется на миг»: with_handler глобального хоткея
  зовётся и на Pressed, и на Released (GlobalHotKeyEvent.state) — toggle
  дёргался на обоих, окно показывалось на нажатии и гасло на отпускании.
  Реагируем только на ShortcutState::Pressed. Плюс QuickEntry.tsx: после
  каждого показа окна фокус возвращается в поле через onFocusChanged
  (вебвью мог погасить фокус при hide), StrictMode-паттерн отписки.
- Грабли в тестах: Date.UTC + локальный dayKey — сверять через helper;
  helper-дефолт createdAt: NOW сломал сортировку stalled; прецеденс
  NOW - 30*DAY/1000; input() нужен дефолт {} (TS2554); tick в deps useMemo —
  лишняя зависимость (eslint error), он нужен только эффекту перезагрузки.
- НЕ забыть (Whisper, если владелец решит): захват MediaRecorder на фронте
  работает в WebView2; локальный путь — whisper-rs + менеджер моделей +
  пункт в Storage-менеджере; push-to-talk через глобальный хоткей (инфра есть).

### MEMORY — ФАКТЫ АГЕНТА (27.09, verify all зелёный)
Фича из отложенных: долговременная память агента поверх существующего тумблера
«Память проектов» (memoryEnabled, haloui-memory). Продуктовое решение: факты —
ОТДЕЛЬНОЕ хранилище memory.json в app_config_dir, а не заметки vault (список
заметок плоский, субдиректории sanitize запрещает; авто-факты затопили бы
авторские). Сессии-«память проектов» осталась как была (buildMemoryBlock).

- Rust (новый модуль memory.rs): MemoryFact{id,text,ts}, потолки MAX_FACTS=200
  (вытеснение старейшего) и MAX_TEXT_LEN=512 (truncate_at_char_boundary);
  дедуп по to_lowercase (НЕ eq_ignore_ascii_case — кириллица). add_fact возвращает
  «saved/updated + total» для модели. Команды memory_list/add/delete/clear
  (config_file(&app, "memory.json")). Инструменты: memory_save (описание схемы
  прямо запрещает сохранять секреты) и memory_recall (пустой запрос = новейшие,
  40 строк). Схемы — memory_tool_schemas(), включаются в get_tool_schemas всегда,
  фронт фильтрует. Роутинг: execute_tool_inner получил memory_file: Option<PathBuf>
  (по образцу notes_dir — резолвится только для memory_*), исполнение в
  spawn_blocking. perm.rs: memory_save в mutating-списке (Plan блокирует, Ask
  спрашивает). lib.rs: mod memory + 4 команды в generate_handler.
- Грабли: тесты memory гонялись параллельно в ОДНОМ temp-файле и валили друг
  друга — уникальный tmp на тест.
- Фронт: api.ts memoryList/Add/Delete/Clear (+MemoryFact); toolFilter — опция
  removeMemory (name.startsWith("memory_")), тест добавлен; useAgentRun —
  mutating-лист += memory_save, filterToolSchemas removeMemory: !memoryEnabled;
  инъекция при memoryEnabled: факты глобально (40 фактов / ~4КБ бюджет,
  новейшие первыми) + system-hint про memory_save/memory_recall (isAgent);
  memoryList попадает в handleSend перед стримом (локальный файл — мгновенно).
- UI (MemorySection): блок «Сохранённые факты» — список (текст, дата, ✕ при
  hover), ручное добавление (input + Enter), «Забыть всё» двухшаговое
  («Точно?»). Виден при выключенном тумблере — управлять можно всегда,
  инъекция только при включённом. Ключи memory.factsTitle/factsEmpty/
  factsAddPh/factsHint/forgetAll/forgetConfirm/forgetOne/factsBlock/hintAgent
  ×4; memory.how2 обновлён (факты глобальны, история — внутри проектов).
- Не забыть: hook PreToolUse покрывает memory_save автоматически (общий путь
  run_tool); storage-менеджер считает memory.json в «Конфиги и задачи» сам.

### ВОЛНЫ 3–6 — ВЫПОЛНЕНЫ (26.09, вторая сессия, verify all зелёный 52s)
- Волна 3 (панель плана Plan Mode): components/PlanSidePanel.tsx — правая
  панель по образцу DiffPanel (fixed right, anim-slide-left, w-440px): задачи
  session.plan со статус-иконками (готово/в работе/ожидает), счётчик done/
  total, футер — «Одобрить план → Спрашивать» (setPermissionMode("ask") +
  закрытие) и «Скопировать план» ([x]/[~]/[ ] в буфер + тост plan.copied).
  App: state planPanelOpen; авто-открытие при переходе в «plan» на ОБОИХ путях
  смены режима — поповер ChatArea (onPermissionModeChange) и шорткат
  cycle_perm_mode. Мини-PlanPanel у композера не тронут. Ключи plan.panelTitle/
  panelHint/approve/copy/copied/empty ×4 (рядом с plan.progress).
- Волна 4 (Quick Entry): Cargo += tauri-plugin-global-shortcut = "2";
  tauri.conf.json — второе окно label "quickentry" (540×64, decorations off,
  transparent, alwaysOnTop, visible off, skipTaskbar, url
  index.html?window=quickentry), главное окно получил явный label "main";
  capabilities: windows += quickentry, permissions += global-shortcut:default.
  lib.rs: плагин с with_handler → toggle_quickentry (показ у верхнего центра
  текущего монитора — position_quickentry по current_monitor), в setup
  регистрируется дефолт "ctrl+alt+space"; команды quickentry_set_bind
  (unregister_all + register, парсер плагина case-insensitive) и
  quickentry_submit (спрятать QE, сфокусировать main, emit_to("main",
  "quickentry-task", text)). Фронт: QuickEntry.tsx (поле на всё окно, Enter →
  quickentrySubmit, Esc/blur → hide, body.background=transparent); main.tsx —
  ветка ?window=quickentry; App — слушатель onQuickEntryTask (StrictMode-паттерн
  clear-data-request): при живом прогоне тост quickentry.busy (guard движка
  отбросил бы текст молча), иначе stableHandleSend(text) — создаст новую задачу;
  эффект применяет сохранённый ремап из localStorage haloui-quickentry-bind.
  MainSection: Row «Быстрый ввод» с кнопкой-записью (capture-phase keydown,
  Esc — отмена; quickentryComboFromEvent в shortcuts.ts — только буквы/цифры/
  F/Space + минимум один модификатор, формат "ctrl+alt+space";
  prettyQuickentryCombo для показа); неудача регистрации — откат к прежнему.
  Ключи main.quickEntry(+Desc, Recording), quickentry.placeholder/busy ×4.
- Волна 5 (Fallback-модель): settings.rs — ApiSettings.fallback_model и
  ApiProfile.fallback_model (Option<String>, #[serde(default)] — старые JSONы
  читаются); api.ts — поля в ApiSettings/ApiProfile; useApiSettings:
  applyProfileSettings + handleAddProfile копируют fallback_model. ApiSection:
  текстовое поле после выбора модели (пустое = выключено). useAgentRun:
  chatWithRetry принял fallbackModel/onFallback; после исчерпания ретраев при
  429/≥500 (parseHttpCode; сетевые сбои НЕ фолбэчим), до первого токена и без
  отмены — второй прогон chatStream с model=fb, при успехе onFallback(fb)
  обновляет сообщение {model: fb, switchedTo: fb}; ошибка фолбэка не
  затирает исходную. AssistantCard: янтарный бейдж «⇄ X» (title
  card.switchedTo) рядом с именем модели. Message.switchedTo в types.ts.
  Ключи api.fallbackModel(+Ph,+Hint), card.switchedTo, activity.fallback ×4.
- Волна 6 (цитата из диффа): DiffView — опц. onQuoteLine(lineNo, text):
  строки add/ctx кликабельны (hover + title agent.diffQuote), колонка newNo
  показывается ТОЛЬКО в Review-режиме (карточки диффов не разъехались).
  DiffPanel прокидывает onQuote(path, line, text); App: handleDiffQuote →
  state diffQuote {text: "path:line\n<строка>", nonce} → ChatArea проп
  pendingQuote: эффект по nonce заполняет существующий quoteDraft (та же
  механика, что выделение в ленте). Панель не закрывается — можно цитить
  несколько строк. Ключ agent.diffQuote ×4.
- Грабли: ApiSettings-инициализатор в тесте imagegen (E0063 — добавить
  fallback_model: None); ternary-statement в колбэке = eslint
  no-unused-expressions (if/else); tok[0] под noUncheckedIndexedAccess →
  charAt(0).

### ДАЛЬШЕ ПО ПЛАНУ (после волны 2) — ВЫПОЛНЕНО, см. блок выше
- Волна 3: Панель плана Plan Mode — правая панель по образцу
  src/components/DiffPanel.tsx (fixed right, anim-slide-left), auto-open при
  переключении режима в "plan" (permissionMode живёт в сессии, переключение
  через setPermissionMode в useSessions.ts + QuickSettings/поповер режимов в
  ChatArea), данные session.plan (PlanTask {title,status}, обновляется
  tool-ом plan_update на фронте), кнопка «Одобрить план → Спрашивать» =
  setPermissionMode("ask"), «Скопировать план» в буфер. Мини-PlanPanel
  (cards/PlanPanel.tsx) у композера остаётся.
- Волна 4: Quick Entry — tauri-plugin-global-shortcut = "2" (Cargo + plugin
  init в lib.rs + capability "global-shortcut:default"), второе
  WebviewWindow (frameless, always-on-top, у верхнего центра), Enter →
  скрыть окно, фокус главного, новая задача с текстом (через emit event →
  App, паттерн clear-data-request). Ремап комбо в «Основном».
- Волна 5: Fallback-модель: поле в профиле API (profiles.json + ApiSection
  форма), в chat.rs при исчерпании ретраев на 429/5xx — второй прогон с
  fallback-моделью, бейдж в карточке «переключено на X».
- Волна 6: Review-панель (DiffPanel.tsx): клик по строке диффа → цитата
  «file:line» в композер (механика quote есть в ChatArea), + verify all,
  финальный отчёт владельцу.

### ГРАБЛИ ЭТОЙ СЕССИИ (актуально для продолжения)
- heredoc-катс съедает бэкслеши в регэкспах — проверки после вставки.
- Скриптовые перестановки ThemeSection: все find() — ТОЛЬКО от returnIdx;
  границы slice — exclusive (upto(a, bExcl) с trim хвостовых пустых);
  баланс каждого блока проверять (bal === 0 для самодостаточных карточек).
- Патчи в /tmp/reorder*.mjs из bash-сессий node'ом не читаются (C:\tmp) —
  править sed-ом по номерам строк или переписывать файл целиком.
- SettingsModal/ThemeSection пережили много правок — перед правками
  сверяться с фактическими строками (rg по якорям), не по памяти.
