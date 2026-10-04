/**
 * Субагенты (M1): изолированные агентные прогоны с ролью, своим контекстом
 * и allowlist-ом инструментов. Главный агент вызывает их инструментом
 * subagent_run({ role, task }); итоговый отчёт возвращается как tool result.
 * Глубина ровно 1: субагенту схема subagent_run не выдаётся.
 */

import {
  abortChat,
  chatStream,
  getToolSchemas,
  runTool,
  type ChatMsgParam,
  type ToolCallInfo,
} from "./api";
import { filterToolSchemas } from "./agent/toolFilter";

export interface SubagentRole {
  id: string;
  name: string;
  desc?: { ru: string; en: string };
  /** Системный промт роли */
  systemPrompt: string;
  /** Allowlist инструментов; null — все, кроме subagent_run */
  tools: string[] | null;
  /** Потолок шагов model→tools→model */
  maxSteps: number;
  /** Override модели (пусто — модель главного агента) */
  model?: string;
}

export interface SubagentsConfig {
  /** Главный тумблер: выдавать ли subagent_run агенту */
  enabled: boolean;
  /** Запускать субагентов без подтверждения; false — каждый запуск
   * subagent_run спрашивает подтверждения, как mutating-инструмент */
  autonomous: boolean;
  /** Максимум субагентов в одном параллельном прогоне */
  maxParallel: number;
  /** Переопределения/дополнения ролей (по id поверх встроенных) */
  roles: SubagentRole[];
}

export const DEFAULT_SUBAGENTS_CONFIG: SubagentsConfig = {
  enabled: true,
  autonomous: true,
  maxParallel: 3,
  roles: [],
};

export const SUBAGENT_ROLES: SubagentRole[] = [
  {
    id: "researcher",
    name: "Researcher",
    desc: {
      ru: "Ищет в интернете/доках, только чтение — без записи файлов",
      en: "Searches the web/docs, read-only — no file writes",
    },
    systemPrompt:
      "Ты — субагент-исследователь. Твоя задача — собрать информацию по брифу и вернуть компактный отчёт: краткий ответ, ключевые факты со ссылками-источниками, спорные моменты. Ты НЕ пишешь файлы и НЕ выполняешь команды — только browser_read/browser_search-класс инструментов и чтение. Отвечай по делу, без воды, до 400 слов.",
    tools: ["browser_navigate", "browser_read", "browser_screenshot", "browser_close", "browser_click", "browser_type", "browser_scroll", "fs_list", "fs_read"],
    maxSteps: 8,
  },
  {
    id: "coder",
    name: "Coder",
    desc: {
      ru: "Пишет/правит код: fs_write, shell_run — внутри своего прогона",
      en: "Writes/edits code: fs_write, shell_run within its run",
    },
    systemPrompt:
      "Ты — субагент-кодер. Тебе дан узкий бриф: реализуй его, используя fs_write/shell_run/fs_read. Работай атомарно: минимум лишних правок, стиль окружающего кода. В конце верни отчёт: какие файлы изменены (пути), что сделано, как проверить. Не задавай вопросов — принимай разумные решения сам.",
    tools: ["fs_list", "fs_read", "fs_write", "shell_run"],
    maxSteps: 12,
  },
  {
    id: "critic",
    name: "Critic",
    desc: {
      ru: "Ревизор: без инструментов, возвращает замечания на текст/дифф",
      en: "Reviewer: no tools, returns findings on text/diff",
    },
    systemPrompt:
      "Ты — субагент-ревизор. Тебе дают текст, план или дифф — найди слабые места: логические ошибки, пропущенные случаи, противоречия, риски. Без инструментов. Формат ответа: список замечаний с приоритетом (P0 блокер … P3 nit) и конкретным предложением исправления; если замечаний нет — так и скажи. До 300 слов.",
    tools: [],
    maxSteps: 2,
  },
  {
    id: "librarian",
    name: "Librarian",
    desc: {
      ru: "Навигатор по репозиторию: fs_list/fs_read, находит нужный код",
      en: "Repo navigator: fs_list/fs_read, locates relevant code",
    },
    systemPrompt:
      "Ты — субагент-библиотекарь. По брифу найди в репозитории релевантные файлы и фрагменты (fs_list/fs_read). Верни: список путей с однострочным описанием каждого, ключевые строки/функции с номерами, как они связаны. Без правок и команд записи.",
    tools: ["fs_list", "fs_read"],
    maxSteps: 10,
  },
];

export interface SubagentStep {
  type: "thought" | "text" | "tool";
  text: string;
}

/** Живое состояние прогона для UI-карточки (ключ — tool call id) */
export interface SubRunState {
  roleId: string;
  roleName: string;
  /** Задача (первая строка промта) — для монитора в композере */
  task?: string;
  /** Накопленный поток мыслей (сбрасывается на каждом tool-шаге) */
  thought: string;
  /** Выполненные вызовы инструментов ("name args…") */
  tools: string[];
  /** Финальный отчёт (null — ещё работает) */
  report: string | null;
}

export interface SubagentRunOpts {
  role: SubagentRole;
  task: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Живые события шагов (для UI-карточки в M2) */
  onStep?: (step: SubagentStep) => void;
  /** Usage каждого шага — наверх, в копилку Hard Limit главной задачи */
  onUsage?: (usage: { prompt: number; completion: number; total: number }) => void;
  /** Усилие размышлений (наследуется от главной задачи) */
  effort?: "off" | "low" | "high" | "max";
  /** Кооперативная отмена (abort главной задачи) */
  aborted?: () => boolean;
  /** requestId главного прогона: Stop гасит и стрим субагента (watcher
   *  вызывает chat_abort по его sub-* id), и его исполняющиеся инструменты
   *  (runTool регистрируется на abort-флаг прогона) */
  runRequestId?: string;
  /** Инструменты, отключённые пользователем в главной задаче: субагент
   *  наследует их и не может расширить набор (схемы + серверный гардал) */
  disabledTools?: string[];
}

/** Вложенный агентный цикл: model → tools → … → финальный отчёт */
export async function runSubagent(opts: SubagentRunOpts): Promise<string> {
  const { role, task, baseUrl, apiKey, model } = opts;
  const messages: ChatMsgParam[] = [
    { role: "system", content: role.systemPrompt },
    { role: "user", content: task },
  ];

  // Schemas: allowlist роли, subagent_run субагентам не выдаётся.
  // Роль без явного allowlist получает только read-only набор.
  // [SECURITY] vault_write и mcp__* в дефолтный пул больше НЕ входят:
  // vault_write мутирует хранилище (лежал в «READ_ONLY» — имя набора лгало),
  // а семантика MCP-инструментов произвольна (запись/удаление/внешние
  // транзакции) — выдаются только явным allowlist в role.tools
  const all = (await getToolSchemas()) as Array<{
    function: { name: string };
  }>;
  // Родительский чёрный список: скрытые инструменты не попадают к субагенту
  const pool = filterToolSchemas(Array.isArray(all) ? all : [], {
    disabled: opts.disabledTools,
  }) as Array<{ function: { name: string } }>;
  const READ_ONLY = new Set([
    "fs_list",
    "fs_read",
    "vault_search",
    "vault_read",
    "browser_navigate",
    "browser_read",
    "browser_screenshot",
  ]);
  // ask_user субагентам не выдаётся: вопрос блокирует только свой вложенный
  // цикл, а отвечать на него должен пользователь в чате главного агента.
  // subagent_run/subagent_status — тоже: глубина 1, реестр фоновых задач
  // живёт в чате главного агента
  const withoutAsk = pool.filter(
    (t) => t.function.name !== "ask_user" && !t.function.name.startsWith("subagent_"),
  );
  const allowed = role.tools
    ? withoutAsk.filter((t) => role.tools?.includes(t.function.name))
    : withoutAsk.filter((t) => READ_ONLY.has(t.function.name));

  for (let step = 0; step < role.maxSteps; step++) {
    if (opts.aborted?.()) return "(subagent aborted)";

    let content = "";
    // holder: TS не видит присваивание в колбэке и сужает let до null
    const holder: { calls: ToolCallInfo[] | null } = { calls: null };
    // Watcher: Stop главного прогона раньше не касался субагента — его стрим
    // и shell-процессы продолжали жечь токены до конца текущего шага
    const subRequestId = `sub-${crypto.randomUUID()}`;
    let watcherStop = false;
    const watcher = opts.runRequestId
      ? (async () => {
          while (!watcherStop) {
            if (opts.aborted?.()) {
              await abortChat(subRequestId).catch(() => {});
              return;
            }
            await new Promise((r) => setTimeout(r, 200));
          }
        })()
      : null;
    try {
      await chatStream({
        requestId: subRequestId,
        baseUrl,
        apiKey,
        model,
        messages,
        tools: allowed.length > 0 ? allowed : undefined,
        onDelta: (d) => {
          content += d;
        },
        onThought: (t) => opts.onStep?.({ type: "thought", text: t }),
        onUsage: (u) => opts.onUsage?.(u),
        reasoningEffort: opts.effort,
        onToolCalls: (c) => {
          holder.calls = c;
        },
      });
    } catch (e) {
      return `subagent stream error: ${e}`;
    } finally {
      watcherStop = true;
      void watcher;
    }

    // Финальный ответ без вызовов инструментов — это и есть отчёт
    const calls = holder.calls as ToolCallInfo[] | null;
    if (!calls || calls.length === 0) {
      opts.onStep?.({ type: "text", text: content });
      return content.trim() || "(subagent returned empty report)";
    }

    messages.push({
      role: "assistant",
      content: content || null,
      tool_calls: (calls as ToolCallInfo[]).map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      })),
    });
    for (const call of calls) {
      if (opts.aborted?.()) return "(subagent aborted)";
      opts.onStep?.({ type: "tool", text: `${call.name} ${call.arguments.slice(0, 80)}` });
      // requestId главного прогона: бэкенд поднимает/заводит abort-флаг
      // по нему — Stop прерывает и инструмент субагента
      const res = await runTool(
        call.name,
        call.arguments,
        opts.runRequestId,
        opts.disabledTools,
      ).catch((e) => `tool error: ${e}`);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: String(res).slice(0, 20000),
      });
    }
  }
  return "(subagent reached its step limit without a final report)";
}


/**
 * Слитый список ролей: встроенные пресеты, поверх — сохранённые
 * переопределения/кастомные роли (совпадение по id).
 */
export function mergeRoles(stored: SubagentRole[]): SubagentRole[] {
  const byId = new Map(SUBAGENT_ROLES.map((r) => [r.id, r]));
  for (const r of stored) byId.set(r.id, r);
  return [...byId.values()];
}

/** Последний фолбэк обеих цепочек выбора роли: SUBAGENT_ROLES непустой
 *  по построению, но строгие индексы требуют явности. Жил литералом в
 *  ДВУХ местах useAgentRun (subagent_run и workflow_run) — при изменении
 *  списка ролей копии разъезжались (PLAN §24 ш.4в) */
export const FALLBACK_ROLE: SubagentRole = {
  id: "researcher",
  name: "Researcher",
  tools: null,
  maxSteps: 8,
  systemPrompt: "",
};

/** Роль для subagent_run: запрошенная → первая → фолбэк (цепочка
 *  вызывающего сохранена дословно — экстракция без изменения поведения) */
export function resolveSubagentRole(
  preferredId: string | undefined,
  roles: SubagentRole[],
): SubagentRole {
  return (
    roles.find((r) => r.id === preferredId) ?? SUBAGENT_ROLES[0] ?? FALLBACK_ROLE
  );
}

/** Роль для шага workflow: шаговая → coder → первая → фолбэк. Отличается
 *  от subagent-цепочки предпочтением coder — сохранено как было. stepRole
 *  опционален в WorkflowDef: undefined никогда не матчится по id — как и
 *  в исходной цепочке */
export function resolveWorkflowRole(
  stepRole: string | undefined,
  roles: SubagentRole[],
): SubagentRole {
  return (
    roles.find((r) => r.id === stepRole) ??
    roles.find((r) => r.id === "coder") ??
    roles[0] ??
    SUBAGENT_ROLES[0] ??
    FALLBACK_ROLE
  );
}

/** Разобрать сырой JSON из subagents.json */
export function parseSubagentsConfig(raw: Record<string, unknown>): SubagentsConfig {
  const roles = Array.isArray(raw.roles)
    ? (raw.roles as SubagentRole[]).filter(
        (r) => r && typeof r.id === "string" && typeof r.systemPrompt === "string",
      ).map((r) => ({
        ...r,
        // FIX: maxSteps приходит из JSON, и тип «number» здесь лживый —
        // сохранённая роль без поля давала `step < undefined` → false на первой
        // итерации: субагент возвращал «reached its step limit», не сделав
        // ни одного вызова модели. Значения <1 и NaN отбрасываем, дефолт 8.
        maxSteps:
          typeof r.maxSteps === "number" && r.maxSteps >= 1
            ? Math.floor(r.maxSteps)
            : DEFAULT_SUBAGENTS_CONFIG.roles.find((d) => d.id === r.id)?.maxSteps ?? 8,
      }))
    : [];
  return {
    enabled: raw.enabled !== false,
    autonomous: raw.autonomous !== false,
    maxParallel:
      typeof raw.maxParallel === "number" && raw.maxParallel >= 1
        ? Math.min(6, Math.floor(raw.maxParallel))
        : DEFAULT_SUBAGENTS_CONFIG.maxParallel,
    roles,
  };
}
