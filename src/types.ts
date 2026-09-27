export type Role = "user" | "assistant" | "tool";

export interface Attachment {
  /** Стабильный key для превью-списка: индексные key на удаляемом списке
   *  переиспользовали DOM-узлы чужих картинок */
  id?: string;
  name: string;
  /** Картинка (data URL); для текстовых документов не задан */
  dataUrl?: string;
  /** Текстовый документ (RAG-lite): содержимое уходит в контекст модели */
  text?: string;
}

export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: string;
}

/** Вопрос пользователю от агента (инструмент ask_user) */
export interface AskQuestion {
  question: string;
  /** Короткий ярлык-заголовок карточки */
  header?: string;
  options: { label: string; description?: string; preview?: string }[];
  /** Разрешить выбор нескольких вариантов */
  multiSelect?: boolean;
  /** Ответ пользователя. null/undefined — ответа ещё нет */
  answer?: { answers: string[]; custom?: string } | null;
  /** Вопрос закрыт без ответа (Stop / конец прогона) */
  cancelled?: boolean;
}

export interface Message {
  id: string;
  role: Role;
  content: string;
  /** Раскрываемый блок размышлений модели */
  thought?: string;
  /** Подпись thinking-блока Anthropic: без неё блок нельзя вернуть в историю
   *  (Messages API при extended thinking + tool_use требует thinking первым) */
  thoughtSignature?: string;
  /** Redacted-thinking блоки Anthropic (base64-данные провайдера) */
  thoughtRedacted?: string[];
  /** Сколько «думала» модель, мс — выводится как "Worked for N сек" */
  workedMs?: number;
  /** Прикреплённые изображения (скриншоты, файлы) */
  attachments?: Attachment[];
  /** Расход токенов от провайдера */
  usage?: { prompt: number; completion: number; total: number };
  /** Вызовы инструментов (агентный режим) */
  toolCalls?: ToolCallInfo[];
  /** Вопрос пользователю (ask_user): задан этим сообщением */
  ask?: AskQuestion;
  /** Для role: "tool" — id вызова, к которому относится результат */
  toolCallId?: string;
  /** Для role: "tool" — имя исполнявшегося инструмента (старые сообщения — без него, ищем по toolCallId) */
  toolName?: string;
  /** Машиный статус результата инструмента: отказ пользователя или ошибка.
   *  Раньше "denied" распознавался сравнением с локализованной строкой —
   *  смена языка перекрашивала историю. Старые сообщения — без поля. */
  status?: "denied" | "error";
  /** Время создания (мс). Старые сообщения — без поля: статистика тогда
   *  падает на день создания сессии (прежнее поведение) */
  ts?: number;
  /** Ошибка запроса: человекочитаемый заголовок + сырое тело провайдера для просмотра */
  error?: { title: string; raw: string };
  /** Модель, сгенерировавшая ответ (иначе в шапке показывается текущая выбранная) */
  model?: string;
  /** Прогон переключён на fallback-модель (429/5xx после ретраев) — бейдж на карточке */
  switchedTo?: string;
  /** Цитата из другого сообщения: вопрос задаётся по выделенному фрагменту */
  quote?: string;
  /** Поправка пользователя: отправлена агенту во время его работы, не прерывая её */
  correction?: boolean;
}

/** Задача плана агента: виджет Progress в чате (аналог TodoWrite) */
export interface PlanTask {
  title: string;
  status: "pending" | "in_progress" | "done";
}

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  /** Последняя активность в задаче (для авто-архива); старые сессии — без поля */
  updatedAt?: number;
  messages: Message[];
  pinned?: boolean;
  projectId?: string;
  /** Системный промт — инструкция для модели на всю задачу */
  systemPrompt?: string;
  /** Агентный режим: модели доступны инструменты */
  agentMode?: boolean;
  /** Разрешённые команды (кнопка «Всегда для задачи») */
  allowedCommands?: string[];
  /** Режим разрешений агента; отсутствие = "ask" */
  permissionMode?: PermissionMode;
  /** Инструменты, скрытые пользователем из этой задачи: не отдаются модели
   *  в схемах и отклоняются сервером при вызове (run_tool) */
  disabledTools?: string[];
  /** Привязанный профиль API: при открытии чата подставляется его связка ключ+URL+модель */
  profileId?: string;
  /** Чат убран в архив (скрыт из списка, доступен через тумблер архива) */
  archived?: boolean;
  /** Метка чата: короткое слово-тег, показывается бейджем в списке */
  tag?: string;
  /** План задач агента: перезаписывается только вызовом plan_update */
  plan?: PlanTask[];
  /** Происхождение ветки (edit-and-resend): сессия и сообщение, от которых
   *  форкнулись. Оригинальная сессия при форке не меняется */
  branchedFrom?: { sessionId: string; messageId: string };
}

export interface Project {
  id: string;
  name: string;
  /** Привязанный профиль API: новые чаты проекта наследуют его */
  profileId?: string;
  /** Акцент проекта (кастомизация «акцент проекта», opt-in) */
  accent?: string;
}

export type Theme = "dark" | "light";

/**
 * Режим разрешений агента (кнопка в нижней панели композера):
 * plan — только чтение и план, ask — подтверждать правки и команды (по умолчанию),
 * edit — правки файлов без подтверждения, full — исполнять всё без вопросов.
 */
export type PermissionMode = "plan" | "ask" | "edit" | "full";

/** Файл, изменённый агентом за ход: снимок до/после для карточки «N файлов изменено» */
export interface ChangedFile {
  path: string;
  /** Файл создан заново (before = null) */
  created: boolean;
  before: string | null;
  after: string;
}

/** Событие использования: одна отправка (запрос) — для раздела «Статистика» */
export interface UsageEvent {
  /** День локальной даты "YYYY-MM-DD" */
  day: string;
  prompt: number;
  completion: number;
  model: string;
  /** Длительность задачи, мс */
  workedMs: number;
}
