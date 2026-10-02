# components/settings/ — карта разделов

Сплит монолита настроек (блок 4): каждая вкладка левой навигации — свой
файл. Монтируются условно из `SettingsModal.tsx` (он же держит NAV-группы,
breadcrumb-историю и поиск по настройкам). Компоненты получают данные и
колбэки пропсами от App — своего стейта хранения почти нет: локальные
useState только для черновиков форм и mount-снимков конфигов.

## Разделы (по NAV-группам)

**basics**
- `MainSection.tsx` — «Основное»: язык, автостарт, трей/быстрый ввод,
  вид ленты (transcript view), плавная печать, уведомления + свои звуки,
  автопродолжение, панель браузера, авто-архив, Hard-Mode, Hard Limit,
  экспорт/импорт настроек, менеджер хранилища.
- `ProfileSection.tsx` — «Профиль пользователя»: аватар/имя/роль/язык/тон,
  тумблеры «для модели» у каждого поля (local-account без облака).
- `DocsSection.tsx` — «Справка»: встроенные доки (ключи `docs.*`).

**agent**
- `ApiSection.tsx` — «API»: профили провайдеров, модели, fallback-модель,
  reasoning effort, тест подключения, детект Ollama.
- `BrowserUseSection.tsx` — запуск/пути браузера для CDP-инструментов.
- `ComputerUseSection.tsx` — Computer Use (гейт Windows/macOS X11).
- `HooksSection.tsx` — хуки 5 событий: реестр + 6 пресетов (Windows
  powershell), тест хука, decision:block/additionalContext.
- `ImageGenSection.tsx` — генерация изображений (openai-совместимый
  /images/generations + chat-фолбэк).
- `McpSection.tsx` — MCP-серверы: stdio + remote (streamable HTTP,
  заголовки-токены), импорт.
- `MemorySection.tsx` — факты агента (memory.json) + тумблер «память
  проектов».
- `PromptsSection` (в `AgentSection.tsx`) — системный промт и промпт-библиотека.
- `JailbreaksCard.tsx` — карточка джейлбрейков на вкладке «Промпты»
  (название/модель/уровень мышления/год/текст; умный поиск: слова+модель+год;
  предупреждение при применении; применение — только явной кнопкой).
- `JailbreaksLiveSearch.tsx` — живой поиск по белому списку GitHub-репо
  (`src/jbSources.ts`): запрос не уходит в сеть, файлы источников качаются
  по клику, парсятся и фильтруются локально, импорт через предпросмотр.
- `ShortcutsSection.tsx` — перебиндиваемые хоткеи + свои комбо → команды.
- `SkillsSection.tsx` — каталог скилов («&»-палитра), плагинные — read-only.
- `SubagentsSection.tsx` (в корне components/) — роли субагентов.
- `WebSearchSection.tsx` — веб-поиск: SearXNG/Brave, ключ шифруется.
- `CommandsSection.tsx` (в корне components/) — пользовательские команды.

**data**
- `ReflectSection.tsx` — «Обзор»: статистика за период, тепловая карта,
  незавершённые планы, Рефлексия (локальная сводка → модель).

**rest**
- `RestSection.tsx` — мини-игры 2048/Сапёр/Змейка (сам game-canvas в
  `src/games/`), рекорды.

**integrations**
- `IntegrationsSection.tsx` — радио Spotify (SMTC) / YouTube (embed),
  warn про WinAPI, лирика/шиммер.

**прочие вкладки внутри Theme**
- `ThemeSection.tsx` — «Кастомизация» (самый большой файл): профили темы,
  стили/конструктор, акцент, чтение, шрифты, код/терминал, обои, ambient,
  кастомный CSS, жёсткие темы Official/Full Claude со своими настройками.

**сеть/прочее**
- `NetworkSection.tsx` — прокси/CA для исходящих запросов.

## Инфраструктура каталога

- `parts.tsx` — общие контролы: `Row`/`ToggleRow` (паттерн строки настроек),
  `Dropdown` (кастомный select), `LangSwitch`, `SectionIcon`, `StylePattern`
  (SVG-узоры тем), мини-иконки. Новые настройки собирать отсюда.
- `searchIndex.ts` — `SETTINGS_SEARCH_INDEX`: ключи локалей для поиска по
  настройкам; при новой настройке пополнять (ключи сверять со словарями —
  протухший ключ ронял поиск, см. SESSION_NOTES 27.09).
- `types.ts` — тип `Section` (id вкладок); сами группы — NAV в SettingsModal.
