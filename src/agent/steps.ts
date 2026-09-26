import type { Message } from "../types";
import { diffStats, diffLines, parseWriteResult } from "../diff";

/**
 * Шаги прогона для аккордеона в merged-карточке хода (фидбек 26.09):
 * плоские ряды Edit/Terminal/Explore/Asked с живыми деталями (+N −N,
 * команды, пути). Чистая фаза без React — собирается из сообщений хода.
 *
 * Thought в ряды не входит: мысли рендерит существующий раскрывающийся
 * блок «Размышления» в AssistantCard (пользователь просил его сохранить).
 * subagent_run тоже не здесь — живые субагенты показывают SubagentCard.
 */

export type StepKind = "edit" | "terminal" | "explore" | "asked";

export interface StepRow {
  id: string;
  kind: StepKind;
  /** имя инструмента как есть (fs_write, mcp__srv__tool) */
  tool: string;
  /** главная часть ряда: файл/команда/путь/вопрос */
  label: string;
  /** вторая часть: путь/URL (Edit: путь, Explore: путь/URL) */
  detail: string;
  /** секунды шага (workedMs владельца-сообщения) */
  secondsMs?: number;
  failed?: "denied" | "error" | "exit";
  exitCode?: number;
  /** Edit: пара до/после для диффа при раскрытии */
  diff?: { before: string; after: string };
  /** добавлено/удалено строк (Edit, уже посчитанные на этапе сборки) */
  stats?: { added: number; removed: number };
  /** Terminal/Explore: вывод инструмента при раскрытии */
  output?: string;
  /** Asked: вопрос и ответ */
  question?: string;
  answer?: string;
}

/** Классификация инструмента в тип шага. Граница совпадает с mutating-списком
 *  useAgentRun: пишущие на диск/хранилище — Edit, shell — Terminal,
 *  вопрос — Asked, всё читающее/внешнее — Explore. */
export function classifyTool(name: string): StepKind {
  if (
    name === "fs_write" ||
    name === "fs_delete" ||
    name === "vault_write" ||
    name === "image_generate"
  ) {
    return "edit";
  }
  if (name === "shell_run") return "terminal";
  if (name === "ask_user") return "asked";
  return "explore";
}

const basename = (p: string): string =>
  p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? p;

const truncate = (s: string, n: number): string =>
  s.length > n ? s.slice(0, n - 1) + "…" : s;

function firstString(raw: string, keys: string[]): string {
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    for (const k of keys) {
      const val = v[k];
      if (typeof val === "string" && val.trim()) return val.trim();
    }
  } catch {
    return raw;
  }
  return raw;
}

/** Строка выхода shell: код возврата считается фейлом, кроме 0 */
function shellExit(content: string): number | null {
  const m = content.match(/exit code: (-?\d+)/);
  return m?.[1] != null ? parseInt(m[1], 10) : null;
}

export function buildStepRows(assistants: Message[], toolMsgs: Message[]): StepRow[] {
  const resultByCall = new Map<string, Message>();
  for (const m of toolMsgs) {
    if (m.toolCallId) resultByCall.set(m.toolCallId, m);
  }
  const rows: StepRow[] = [];
  for (const a of assistants) {
    for (const tc of a.toolCalls ?? []) {
      // Субагенты живут своими карточками — в аккордеоне им не место
      if (tc.name === "subagent_run") continue;
      const res = resultByCall.get(tc.id);
      const content = res?.content ?? "";
      const kind = classifyTool(tc.name);
      const row: StepRow = {
        id: tc.id,
        kind,
        tool: tc.name,
        label: "",
        detail: "",
        secondsMs: a.workedMs != null && a.workedMs > 0 ? a.workedMs : undefined,
      };
      if (res?.status === "denied") row.failed = "denied";
      else if (res?.status === "error") row.failed = "error";

      if (kind === "edit" && tc.name === "fs_write") {
        const w = parseWriteResult(content);
        if (w?.path) {
          row.label = basename(w.path);
          row.detail = w.path.replace(/[\\/][^\\/]+$/, "");
          row.diff = { before: w.before ?? "", after: w.after };
          if (w.before != null) {
            row.stats = diffStats(diffLines(w.before, w.after));
          }
        } else {
          row.label = truncate(firstString(tc.arguments, ["path"]), 60);
          row.output = content;
        }
      } else if (kind === "terminal") {
        const cmd = firstString(tc.arguments, ["command"]);
        row.label = truncate(cmd, 80);
        const code = shellExit(content);
        if (code != null) {
          row.exitCode = code;
          if (code !== 0) row.failed = "exit";
        }
        row.output = content;
      } else if (kind === "asked") {
        const q = firstString(tc.arguments, ["question", "q"]);
        row.label = truncate(q, 80);
        row.question = q;
        row.answer = content;
      } else {
        // Explore: путь/URL/запрос как лейбл, объём результата — в детали
        row.label = truncate(
          firstString(tc.arguments, ["path", "url", "query", "file"]) || tc.name,
          60,
        );
        if (tc.name === "fs_list") {
          const n = content.split("\n").filter((l) => l.trim() && !l.startsWith("type\t")).length;
          row.detail = String(n);
        } else if (content) {
          row.detail = String(content.split("\n").length);
        }
        row.output = content;
      }
      rows.push(row);
    }
  }
  return rows;
}
