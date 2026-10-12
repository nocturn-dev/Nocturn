export type Effort = "off" | "low" | "high" | "max";

/**
 * Уровни размышлений, поддерживаемые моделью.
 *
 * Отдельного API «какие уровни есть у модели» у провайдеров нет — как и в
 * ZCode, уровни живут статической метадатой по семействам моделей. Таблица
 * скрывает селектор там, где модель размышления не регулирует: ручка
 * «low/high/max» на модели без reasoning — та же заглушка, от которой
 * избавляемся.
 *
 * off = не отправлять поле effort вовсе (модель работает в дефолте).
 */

/** Reasoning всегда включён и не регулируется effort-ручкой */
const ALWAYS_ON: RegExp[] = [
  /deepseek-r1/i,
  /deepseek-reasoner/i,
  /qwq/i,
  /^o1-mini/i,
  /^o1-preview/i,
];

/** Модель без режима размышлений — селектор смысла не имеет */
const NO_REASONING: RegExp[] = [
  /^gpt-4o(-|$)/i,
  /^gpt-4(\.|-|\b)/i,
  /^gpt-3/i,
  /^claude-2/i,
  /^claude-3-(haiku|opus)/i,
  /^claude-(instant|haiku|opus)/i,
  /^gemini-1(\.|-)/i,
  /^gemini-(pro|flash)-\d/i,
  /^llama/i,
  /^mistral/i,
  /^qwen2?(\.|-|$)/i,
  /^phi/i,
  /^gemma/i,
];

export function reasoningLevels(modelId: string): Effort[] {
  const m = modelId.toLowerCase();
  if (NO_REASONING.some((r) => r.test(m))) return [];
  if (ALWAYS_ON.some((r) => r.test(m))) return ["off"];
  // OpenAI o-серия/gpt-5, Claude (thinking-бюджет), GLM-4.6+ и прочие
  // reasoning-семейства: ручка off/low/high/max валидна
  return ["off", "low", "high", "max"];
}
