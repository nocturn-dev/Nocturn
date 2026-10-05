/**
 * Встроенные скилы: готовые инструкции-«усилители» для модели.
 * Вызов: «&» в поле ввода открывает палитру; выбор вставляет шаблон
 * скила в черновик — пользователь дописывает задачу и отправляет.
 * Полный список — Настройки → Скилы.
 */

export interface Skill {
  /** Идентификатор после &: &review */
  id: string;
  name: string;
  desc?: { ru: string; en: string };
  /** Шаблон, вставляемый в черновик (инструкция для модели) */
  prompt: string;
  /** [P12] Когда модели звать скилл через skill_run (английский, для
   *  модели): попадает в system-блок доступных скиллов */
  whenToUse?: string;
  /** [P12] Override модели форк-прогона (пусто — модель главного агента) */
  model?: string;
  /** [P12] Allowlist инструментов форк-прогона; пусто — read-only набор
   *  по умолчанию (контракт runSubagent) */
  allowedTools?: string[];
}

/** [P12] Сборка форк-прогона скилла (CC skills context:fork своими
 *  словами): instruction скилла = задача, args — материал пользователя.
 *  Чистая функция — тесты рядом */
export function buildSkillRun(
  skills: Skill[],
  id: string,
  args: string,
): { name: string; systemPrompt: string; tools: string[] | null; model?: string; task: string } | { error: string } {
  const needle = id.trim().toLowerCase();
  const skill = skills.find((s) => s.id.toLowerCase() === needle);
  if (!skill) return { error: `unknown skill "${id.trim()}"` };
  const rest = args.trim();
  return {
    name: skill.name,
    systemPrompt:
      "You execute one specific skill task. Follow the skill instruction precisely; return the complete result as your final report.",
    tools: skill.allowedTools ?? null,
    model: skill.model || undefined,
    task: rest ? `${skill.prompt}${rest}` : skill.prompt,
  };
}

export const BUILTIN_SKILLS: Skill[] = [
  {
    id: "review",
    name: "Code Review",
    desc: {
      ru: "Ревью кода: баги, безопасность, стиль, производительность — с приоритетами",
      en: "Code review: bugs, security, style, performance — with priorities",
    },
    whenToUse:
      "The user asks to review or audit code, a diff or recent changes before merge.",
    prompt:
      "[Скил: Code Review]\nПроведи ревью кода ниже. Разбери: 1) баги и логические ошибки, 2) безопасность, 3) производительность, 4) читаемость и стиль. По каждой находке — приоритет (P0..P3), файл/строка, конкретное исправление. В конце — сводка из топ-3 действий.\n\nКод:\n",
  },
  {
    id: "debug",
    name: "Debug",
    desc: {
      ru: "Системная отладка: гипотезы → проверка → фикс",
      en: "Systematic debugging: hypotheses → checks → fix",
    },
    prompt:
      "[Скил: Debug]\nОтладь проблему по описанию ниже. Действуй системно: 1) восстанови ожидаемое и фактическое поведение, 2) сформулируй 3–5 гипотез причины по убыванию вероятности, 3) для каждой — как проверить (команда/лог/точка останова), 4) предложи минимальный фикс и регрессионный тест.\n\nПроблема:\n",
  },
  {
    id: "tests",
    name: "Tests",
    desc: {
      ru: "Покрыть код тестами: happy path, края, ошибки",
      en: "Cover code with tests: happy path, edge cases, errors",
    },
    prompt:
      "[Скил: Tests]\nНапиши тесты для кода ниже. Покрой: 1) основной сценарий, 2) граничные случаи, 3) обработку ошибок, 4) при необходимости — моки зависимостей. Используй подходящий фреймворк проекта; если неясно — предложи варианты. К каждому тесту — однострочный комментарий «что проверяет».\n\nКод:\n",
  },
  {
    id: "refactor",
    name: "Refactor",
    desc: {
      ru: "Рефакторинг без изменения поведения: шаги и дифф",
      en: "Behavior-preserving refactor: steps and diff",
    },
    prompt:
      "[Скил: Refactor]\nОтрефактори код ниже, НЕ меняя поведение. План: 1) перечисли проблемы структуры (дубли, связность, именование), 2) предложи пошаговый рефакторинг (каждый шаг — отдельно и безопасно), 3) покажи итоговый код, 4) укажи, как убедиться, что поведение сохранилось (тесты/ручная проверка).\n\nКод:\n",
  },
  {
    id: "docs",
    name: "Docs",
    desc: {
      ru: "Документация: README, API, примеры использования",
      en: "Documentation: README, API, usage examples",
    },
    prompt:
      "[Скил: Docs]\nНапиши документацию для кода/проекта ниже. Структура: 1) что это и зачем — 2–3 предложения, 2) быстрый старт (установка/запуск), 3) основное использование с примерами, 4) API/конфигурация таблицей, 5) частые вопросы/грабли. Тон — сухой и конкретный, без маркетинга.\n\nМатериал:\n",
  },
  {
    id: "explain",
    name: "Explain",
    desc: {
      ru: "Объяснить код: архитектура, поток данных, неочевидные места",
      en: "Explain code: architecture, data flow, gotchas",
    },
    prompt:
      "[Скил: Explain]\nОбъясни код ниже так, чтобы разобраться смог разработчик среднего уровня: 1) что делает и какую задачу решает, 2) архитектура и ключевые абстракции, 3) поток данных по шагам, 4) неочевидные места и подводные камни. Используй аналогии там, где уместно.\n\nКод:\n",
  },
  {
    id: "plan",
    name: "Plan",
    desc: {
      ru: "Архитектурный план фичи: этапы, риски, проверки",
      en: "Feature plan: stages, risks, verification",
    },
    whenToUse:
      "The user asks for an implementation plan of a feature before coding starts.",
    prompt:
      "[Скил: Plan]\nСоставь план реализации задачи ниже. Формат: 1) цель и критерии готовности, 2) этапы (M0, M1, …) с объёмом каждого, 3) какие файлы/модули затрагиваются, 4) риски и как их гасить, 5) что делаем в конце (тесты, сборка, проверка). Не пиши код — только план.\n\nЗадача:\n",
  },
  {
    id: "research",
    name: "Research",
    desc: {
      ru: "Веб-исследование темы с источниками (Browser Use)",
      en: "Web research on a topic with sources (Browser Use)",
    },
    whenToUse:
      "The task needs web research: current facts, documentation, comparisons with sources and links.",
    allowedTools: [
      "web_search",
      "browser_navigate",
      "browser_read",
      "browser_snapshot",
      "browser_click",
      "browser_type",
      "browser_scroll",
    ],
    prompt:
      "[Скил: Research]\nИсследуй тему ниже (если доступен браузер — используй поиск и чтение страниц). Результат: 1) краткий ответ, 2) ключевые факты с источниками-ссылками, 3) спорные моменты/что расходится между источниками, 4) что осталось невыясненным.\n\nТема:\n",
  },
  {
    id: "summarize",
    name: "Summarize",
    desc: {
      ru: "Сжать текст: суть, ключевые пункты, действия",
      en: "Summarize text: gist, key points, action items",
    },
    prompt:
      "[Скил: Summarize]\nСожми текст ниже: 1) суть в одном абзаце, 2) ключевые пункты списком, 3) цифры/факты, которые важно запомнить, 4) что нужно сделать по итогам (если применимо). Сохрани тон оригинала.\n\nТекст:\n",
  },
  {
    id: "translate",
    name: "Translate",
    desc: {
      ru: "Перевод с сохранением терминологии и тона",
      en: "Translation preserving terminology and tone",
    },
    prompt:
      "[Скил: Translate]\nПереведи текст ниже (определи исходный язык и переведи на русский; если он на русском — на английский). Сохрани терминологию, тон и форматирование; технические термины, не имеющие устоявшегося перевода, оставь в оригинале в скобках. В конце — 2–3 примечания о выборе терминов.\n\nТекст:\n",
  },
  {
    id: "optimize",
    name: "Optimize",
    desc: {
      ru: "Оптимизация производительности: замеры, узкие места",
      en: "Performance optimization: measurements, hotspots",
    },
    prompt:
      "[Скил: Optimize]\nОптимизируй по производительности код/описание ниже. Порядок: 1) определи узкие места и почему они узкие (сложность, аллокации, I/O), 2) предложи улучшения по убыванию эффекта, с оценкой выигрыша, 3) как замерить «до/после» (бенчмарк), 4) что НЕ стоит трогать (преждевременная оптимизация).\n\nКод:\n",
  },
  {
    id: "commit",
    name: "Commit",
    desc: {
      ru: "Коммит по Conventional Commits из изменений (git)",
      en: "Conventional Commits message from the changes (git)",
    },
    prompt:
      "[Скил: Commit]\nСоставь сообщение коммита для текущих изменений (посмотри git status/diff). Формат Conventional Commits: type(scope): заголовок до 72 символов; тело — что и зачем; если есть ломающие изменения — BREAKING CHANGE. Предложи 1 основной и 1 альтернативный вариант.\n",
  },
  {
    id: "wiki",
    name: "Repo Wiki",
    desc: {
      ru: "Автогенерация документации по проекту (файлы в docs/). Жёстко локально: код и документы никуда, кроме выбранного вами провайдера API, не уходят — ни своих серверов, ни облака у скила нет",
      en: "Auto-generate project documentation (files in docs/). Strictly local: code and docs go nowhere except the API provider you chose yourself — this skill has no servers or cloud of its own",
    },
    whenToUse:
      "The user asks to generate documentation/wiki for the whole project (overview, modules, index in docs/).",
    allowedTools: ["fs_read", "fs_list", "fs_write", "fs_grep"],
    prompt:
      "[Скил: Repo Wiki]\nСгенерируйте вики-документацию по проекту в папке проекта (используйте fs_list/fs_read; если корень проекта неизвестен — спросите его). Приватность: всё выполняется локально, запросы идут только к API-провайдеру, выбранному в настройках этого приложения. План: 1) осмотрите дерево проекта и определите стек; 2) создайте docs/wiki/ с файлами: overview.md (что за проект, архитектура, схема модулей), по одному <модуль>.md на крупный модуль (назначение, ключевые файлы, потоки данных, грабли), index.md (оглавление со ссылками на остальные файлы); 3) в каждом файле — сухой конкретный тон, ссылки на реальные пути файлов, без маркетинга; 4) в конце — краткий отчёт: какие файлы созданы и что стоит дописать вручную. Не выдумывайте то, чего нет в коде.\n\nПроект:\n",
  },
];
