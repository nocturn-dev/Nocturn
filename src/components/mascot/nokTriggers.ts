/**
 * Пасхальные команды Ноку из чата (PLAN.md §21): «Эй Нок, полетай».
 * Сообщение НЕ уходит модели — перехватывается до отправки (как
 * slash-команды), это чистая клиентская магия.
 */

export type NokCommand = "fly" | "home";

// ВАЖНО: \b в JS — ASCII-only, с кириллицей «нок\b» не матчится никогда;
// граница слова — явный lookahead на конец/разделитель
const NOK_RE = /(?:^|[\s,.!?])(?:эй|йо|окей|hey|yo)?[\s,]*(?:мой\s)?(?:нок|nok)(?=$|[\s,.!?])/i;
const FLY_RE = /(полетай|полети|летай|лети|полет\w*|полёт|летает|fly|hover|soar)/i;
const HOME_RE = /(домой|вернись|стоп|хватит|дом\s|stop|home|back)/i;

/**
 * Распознаёт команду маскоту в черновике. null — обычное сообщение.
 * Гвард по длине: длинное осмысленное сообщение, случайно упомянувшее
 * «Нока», уходит модели как обычно.
 */
export function matchNokTrigger(raw: string): NokCommand | null {
  const s = raw.trim();
  if (!s || s.length > 64) return null;
  if (!NOK_RE.test(s)) return null;
  if (HOME_RE.test(s)) return "home";
  if (FLY_RE.test(s)) return "fly";
  // Голое «Эй Нок» — короткий облёт-приветствие
  if (/^(эй|йо|окей|hey|yo)?[\s,]*(нок|nok)[\s,.!]*$/i.test(s)) return "fly";
  return null;
}
