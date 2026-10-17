import type { AskUserSpec, ToolCallInfo } from "./types";
export type { AskUserSpec };

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

  /** Решить по id. false — взаимодействия с таким id уже нет.
   *  Удаление из реестра происходит до вызова функции разрешения,
   *  а сам вызов обёрнут в try/finally, чтобы ошибки потребителя
   *  не оставляли реестр в несогласованном состоянии */
  resolve(id: string, resolution: InteractionResolution): boolean {
    const r = this.resolvers.get(id);
    if (!r) return false;
    this.resolvers.delete(id);
    try {
      r(resolution);
    } finally {
      // Резолвер удалён до вызова — состояние реестра очищено гарантированно
    }
    return true;
  }

  /** Закрыть все (Stop / finalize прогона). Возвращает id закрытых.
   *  Сначала снимаем копию резолверов и очищаем карту, чтобы возможные
   *  побочные эффекты или рекурсивные вызовы внутри колбэков не мутировали
   *  коллекцию во время итерации */
  cancelAll(): string[] {
    const entries = [...this.resolvers.entries()];
    this.resolvers.clear();
    for (const [, r] of entries) {
      try {
        r({ kind: "cancel" });
      } catch {
        // Ошибка отдельного резолвера не должна препятствовать отмене остальных
      }
    }
    return entries.map(([id]) => id);
  }

  has(id: string): boolean {
    return this.resolvers.has(id);
  }
}

/** Таймаут ожидания подтверждения инструмента (по аналогии с ASK_AUTO_CONTINUE_MS) —
 *  15 минут: если пользователь отошёл, задача не остаётся навечно в подвешенном состоянии */
export const CONFIRM_TIMEOUT_MS = 15 * 60_000;

/** Первое confirm-взаимодействие из списка (карточка [y/n/a] в чате/терминале) */
export function firstConfirm(interactions: Interaction[]): Interaction | null {
  return interactions.find((i) => i.kind === "confirm") ?? null;
}
