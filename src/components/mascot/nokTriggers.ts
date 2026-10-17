/**
 * Пасхальные команды Ноку из чата: «Эй Нок, полетай».
 * Сообщение НЕ уходит модели — перехватывается до отправки (как
 * slash-команды), это чистая клиентская магия.
 */

export type NokCommand = "fly" | "home";

/**
 * Командные слова сравниваются с токенами ЦЕЛИКОМ, а не подстрокой:
 * «летит» — это не команда «лети», «backend» — не «back». Прежние
 * подстрочные регулярки перехватывали обычную речь про Нока.
 * \p{L}\p{N} вместо \b: ASCII-граница слова с кириллицей не работает.
 */
const FLY_WORDS = new Set([
  "полетай",
  "полетаем",
  "полетать",
  "полети",
  "полетим",
  "летай",
  "летаем",
  "летать",
  "лети",
  "летим",
  "полет",
  "полёт",
  "летает",
  "fly",
  "hover",
  "soar",
]);
const HOME_WORDS = new Set([
  "домой",
  "дом",
  "вернись",
  "стоп",
  "хватит",
  "stop",
  "home",
  "back",
]);
/** Обращения без команды — короткий облёт-приветствие */
const GREETINGS = new Set(["эй", "йо", "окей", "hey", "yo"]);
const BUILTIN_NAMES = new Set(["нок", "nok"]);

/** Команда — короткая реплика-обращение, а не проза с упоминанием */
const MAX_TOKENS = 8;

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Распознаёт команду маскоту в черновике. mascotName — кастомное имя из
 * настроек: переименованный маскот отвечает на своё имя, «нок» продолжает
 * работать как дефолт. null — обычное сообщение, уходит модели.
 */
export function matchNokTrigger(raw: string, mascotName = ""): NokCommand | null {
  const s = raw.trim();
  if (!s || s.length > 64) return null;
  const tokens = tokenize(s);
  if (tokens.length === 0 || tokens.length > MAX_TOKENS) return null;

  const nameTokens = mascotName.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const isAddress = (tok: string) =>
    BUILTIN_NAMES.has(tok) || (nameTokens.length > 0 && nameTokens.includes(tok));

  const rest: string[] = [];
  let addressed = false;
  for (const tok of tokens) {
    if (!addressed && isAddress(tok)) {
      addressed = true;
      continue;
    }
    if (GREETINGS.has(tok)) continue;
    rest.push(tok);
  }
  // Обращения нет — это не Ноку
  if (!addressed) return null;

  // «Эй Нок» / «Нок?» — короткий облёт-приветствие
  if (rest.length === 0) return "fly";
  if (rest.some((tok) => HOME_WORDS.has(tok))) return "home";
  if (rest.some((tok) => FLY_WORDS.has(tok))) return "fly";
  // Остались слова вне командного словаря — обычное предложение, не команда
  return null;
}
