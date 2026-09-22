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
