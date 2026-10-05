import type { AskQuestion, ToolCallInfo } from "./types";

/**
 * Реестр ожидающих взаимодействий агента с пользователем.
 *
 * Раньше подтверждение tool-call держалось на одном глобальном резолвере —
 * второе одновременное взаимодействие (вопрос ask_user, второй confirm
 * параллельного вызова) затирало бы первое. Реестр хранит каждое
 * взаимодействие под своим id: карточка в чате резолвит по id, Stop/finalize
 * гасят все разом.
 */

/** Спецификация вопроса пользователю (без ответа — он появляется в истории) */
export type AskUserSpec = Pick<
  AskQuestion,
  "question" | "header" | "options" | "multiSelect"
>;

/** Ожидающее взаимодействие: подтверждение инструмента или вопрос */
export type Interaction =
  | { id: string; kind: "confirm"; requestId: string; call: ToolCallInfo }
  | {
      id: string;
      kind: "ask";
      requestId: string;
      /** Сообщение-карточка вопроса: в него пишется ответ */
      msgId: string;
      spec: AskUserSpec;
    };

/** Решение по подтверждению инструмента */
export type ConfirmDecision = "once" | "always" | "prefix" | "deny";
/** "prefix" ([P9]) — разрешить префикс команды до конца задачи
 *  (только shell_run; кнопка видна, когда из команды извлекается
 *  безопасный префикс: simple, не dangerous) */

/** Ответ на вопрос: выбранные label'ы + свободный текст «Other» */
export interface AskAnswer {
  answers: string[];
  custom?: string;
}

/** Чем закрылось взаимодействие: решение / ответ / отмена (Stop, finalize) /
 *  тайм-аут (автопродолжение вопроса без ответа) */
export type InteractionResolution =
  | { kind: "confirm"; decision: ConfirmDecision }
  | { kind: "ask"; answer: AskAnswer }
  | { kind: "ask-timeout" }
  | { kind: "cancel" };

export class InteractionRegistry {
  private resolvers = new Map<string, (r: InteractionResolution) => void>();

  /** Открыть взаимодействие. Возвращает id (совпадает с interaction.id) */
  open(interaction: Interaction, resolve: (r: InteractionResolution) => void): string {
    this.resolvers.set(interaction.id, resolve);
    return interaction.id;
  }

  /** Решить по id. false — взаимодействия с таким id уже нет */
  resolve(id: string, resolution: InteractionResolution): boolean {
    const r = this.resolvers.get(id);
    if (!r) return false;
    this.resolvers.delete(id);
    r(resolution);
    return true;
  }

  /** Закрыть все (Stop / finalize прогона). Возвращает id закрытых */
  cancelAll(): string[] {
    const closed = [...this.resolvers.keys()];
    for (const [, r] of this.resolvers) r({ kind: "cancel" });
    this.resolvers.clear();
    return closed;
  }

  has(id: string): boolean {
    return this.resolvers.has(id);
  }
}

/** Первое confirm-взаимодействие из списка (карточка [y/n/a] в чате/терминале) */
export function firstConfirm(interactions: Interaction[]): Interaction | null {
  return interactions.find((i) => i.kind === "confirm") ?? null;
}
