/**
 * Валидация ask_user (PLAN §24 шаг 4в) — вынесена из useAgentRun без
 * изменения поведения: модель присылает JSON спецификации вопроса, мусор
 * (нет question, меньше двух осмысленных опций) → null, и модели уходит
 * ошибка с указанием контракта.
 */

import type { AskUserSpec } from "../interactions";

/** Валидация аргументов ask_user: вопрос + 2–4 опции с непустым label
 *  (опции сверх четырёх срезаются, пустые — выкидываются, label НЕ
 *  триммится — как приходил), header обрезается до 24 символов */
export function parseAskSpec(argsJson: string): AskUserSpec | null {
  try {
    const parsed = JSON.parse(argsJson) as Partial<AskUserSpec>;
    const options = Array.isArray(parsed.options)
      ? parsed.options
          .filter(
            (o): o is AskUserSpec["options"][number] =>
              !!o && typeof o.label === "string" && o.label.trim() !== "",
          )
          .slice(0, 4)
      : [];
    if (
      typeof parsed.question === "string" &&
      parsed.question.trim() !== "" &&
      options.length >= 2
    ) {
      return {
        question: parsed.question,
        header:
          typeof parsed.header === "string" && parsed.header.trim()
            ? parsed.header.slice(0, 24)
            : undefined,
        options,
        multiSelect: parsed.multiSelect === true,
      };
    }
    return null;
  } catch {
    return null;
  }
}
