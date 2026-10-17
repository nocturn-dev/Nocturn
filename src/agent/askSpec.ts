/**
 * Валидация ask_user — вынесена из useAgentRun без
 * изменения поведения: модель присылает JSON спецификации вопроса, мусор
 * (нет question, меньше двух осмысленных опций) → null, и модели уходит
 * ошибка с указанием контракта.
 */

import type { AskUserSpec } from "../interactions";

/** Валидация аргументов ask_user: вопрос + 2–4 опции с непустым label,
 *  сохранение description и preview, безопасная обрезка header до 24 символов
 *  (с учётом суррогатных пар) */
export function parseAskSpec(argsJson: string): AskUserSpec | null {
  try {
    const parsed = JSON.parse(argsJson) as Partial<AskUserSpec>;
    const options: AskUserSpec["options"] = [];
    if (Array.isArray(parsed.options)) {
      for (const item of parsed.options as unknown[]) {
        if (!item) continue;
        if (typeof item === "object") {
          const raw = item as Record<string, unknown>;
          const label = typeof raw.label === "string" ? raw.label.trim() : "";
          if (!label) continue;
          const opt: AskUserSpec["options"][number] = { label };
          if (typeof raw.description === "string" && raw.description.trim()) {
            opt.description = raw.description.trim();
          }
          if (typeof raw.preview === "string" && raw.preview.trim()) {
            opt.preview = raw.preview;
          }
          options.push(opt);
          if (options.length === 4) break;
        } else if (typeof item === "string" && item.trim()) {
          options.push({ label: item.trim() });
          if (options.length === 4) break;
        }
      }
    }
    if (
      typeof parsed.question === "string" &&
      parsed.question.trim() !== "" &&
      options.length >= 2
    ) {
      return {
        question: parsed.question,
        header:
          typeof parsed.header === "string" && parsed.header.trim()
            ? Array.from(parsed.header.trim()).slice(0, 24).join("")
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

