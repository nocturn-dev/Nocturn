import { PROVIDER_ICONS } from "./providerIconsData";

/**
 * Логотип провайдера: локальный брендовый SVG (данные simple-icons, CC0),
 * затем цветная буква-фолбэк. D2: раньше SVG тянулся с cdn.simpleicons.org,
 * а favicon нишевых провайдеров — с icons.duckduckgo.com, но CSP
 * `img-src 'self' data: blob:` блокировала оба — в проде фича была мертва,
 * а в dev модельные имена утекали сторонним CDN. Теперь всё локально.
 *
 * Волна иконок-фиксов: матчинг стал двухступенчатым. Раньше семья бралась
 * как точный ключ «до слэша» — бесслэшные id кастомных провайдеров
 * (claude-3-5-haiku, gpt-6-astra) и вариации OpenRouter (meta-llama, x-ai)
 * промахивались мимо имеющихся иконок и рисовали букву-заглушку. Теперь:
 * точный ключ семьи → скан полного id по regex-карте → буква-фолбэк.
 * Иконки и подписи (brandName) считают бренд по ОДНОЙ таблице — раньше
 * рассинхронились.
 */

export interface BrandDef {
  /** Точный ключ семьи (familyOf) — для слэш-префиксов OpenRouter и т.п. */
  key: string;
  /** Скан полного id модели (lowercase) — ловит бесслэшные id и вариации */
  match: RegExp;
  /** Подпись (brandName) */
  name: string;
  /** slug в PROVIDER_ICONS; нет — цветная буква-фолбэк */
  slug?: string;
  color: string;
}

/** Порядок важен: первый совпавший паттерн выигрывает */
const BRAND_DEFS: BrandDef[] = [
  { key: "deepseek", match: /deepseek/, name: "DeepSeek", slug: "deepseek", color: "4D6BFE" },
  { key: "openai", match: /gpt|^o[134](-|$)|openai/, name: "OpenAI", slug: "openai", color: "74AA9C" },
  { key: "claude", match: /claude/, name: "Claude", slug: "anthropic", color: "D97757" },
  { key: "anthropic", match: /anthropic|sonnet|opus|haiku/, name: "Anthropic", slug: "anthropic", color: "D97757" },
  { key: "google", match: /gemini|google/, name: "Google", slug: "googlegemini", color: "4796E3" },
  { key: "gemma", match: /gemma/, name: "Gemma", slug: "googlegemini", color: "4796E3" },
  { key: "xai", match: /grok|x-ai|^xai/, name: "Grok", color: "E8E6DC" },
  { key: "meta", match: /llama|meta/, name: "Llama", slug: "meta", color: "0866FF" },
  { key: "mistralai", match: /mistral|mixtral/, name: "Mistral", slug: "mistralai", color: "FF7000" },
  { key: "mistral", match: /mistral/, name: "Mistral", slug: "mistralai", color: "FF7000" },
  { key: "qwen", match: /qwen/, name: "Qwen", slug: "qwen", color: "615CED" },
  { key: "glm", match: /glm|zhipu|z-ai/, name: "GLM", color: "3B82F6" },
  { key: "zhipu", match: /zhipu/, name: "GLM", color: "3B82F6" },
  { key: "thudm", match: /thudm/, name: "GLM", color: "3B82F6" },
  { key: "moonshotai", match: /kimi|moonshot/, name: "Kimi", slug: "moonshotai", color: "1B1B1B" },
  { key: "moonshot", match: /moonshot/, name: "Kimi", slug: "moonshotai", color: "1B1B1B" },
  { key: "kimi", match: /kimi/, name: "Kimi", slug: "moonshotai", color: "1B1B1B" },
  { key: "nvidia", match: /nvidia|nemotron/, name: "NVIDIA", slug: "nvidia", color: "76B900" },
  { key: "microsoft", match: /\bphi|microsoft/, name: "Phi", slug: "microsoft", color: "5E5E5E" },
  { key: "perplexity", match: /perplexity|sonar/, name: "Perplexity", slug: "perplexity", color: "20808D" },
  { key: "minimax", match: /minimax/, name: "MiniMax", color: "E8402A" },
  { key: "baichuan", match: /baichuan/, name: "Baichuan", color: "E8402A" },
  { key: "internlm", match: /internlm/, name: "InternLM", color: "B33A3A" },
  { key: "stepfun", match: /stepfun/, name: "StepFun", color: "4D6BFE" },
  { key: "ai21", match: /ai21/, name: "AI21", color: "E03C31" },
  { key: "liquid", match: /liquid/, name: "Liquid", color: "8B5CF6" },
  { key: "cohere", match: /cohere|command-r/, name: "Cohere", color: "39594D" },
  { key: "together", match: /together/, name: "Together", color: "0F6FFF" },
  { key: "fireworks", match: /fireworks/, name: "Fireworks", color: "FF7000" },
  { key: "groq", match: /groq/, name: "Groq", color: "F55036" },
  { key: "cerebras", match: /cerebras/, name: "Cerebras", color: "FF7A00" },
  { key: "openrouter", match: /openrouter/, name: "OpenRouter", slug: "openrouter", color: "8B5CF6" },
  { key: "huggingface", match: /hugging/, name: "Hugging Face", slug: "huggingface", color: "FFD21E" },
  { key: "ollama", match: /ollama/, name: "Ollama", slug: "ollama", color: "000000" },
];

/** Точный ключ семьи → бренд (семья "kimi" матчится и regex'ом, но ключ
 *  дешевле и не зависит от остальной части id) */
const BY_KEY: Map<string, BrandDef> = new Map(BRAND_DEFS.map((b) => [b.key, b]));

/** Бренд по id модели: точный ключ семьи → скан полного id → null.
 *  match-паттерны тестируют ВЕСЬ id в нижнем регистре, поэтому ловят и
 *  бесслэшные id кастомных провайдеров (claude-3-5-haiku), и вариации
 *  слэш-префиксов (meta-llama, x-ai) */
export function matchBrand(modelId: string): BrandDef | null {
  const family = familyOf(modelId);
  const byKey = BY_KEY.get(family);
  if (byKey) return byKey;
  const m = modelId.toLowerCase();
  for (const def of BRAND_DEFS) {
    if (def.match.test(m)) return def;
  }
  return null;
}

export function familyOf(modelId: string): string {
  return (modelId.split("/")[0] ?? "").toLowerCase();
}

/** Короткое имя модели без семейства: "deepseek/deepseek-r1:free" → "deepseek-r1:free" */
export function shortModelName(modelId: string): string {
  return modelId.split("/").pop() ?? modelId;
}

/** Брендовое имя для компактных мест: "deepseek/deepseek-r1:free" → "DeepSeek" */
export function brandName(modelId: string): string {
  const def = matchBrand(modelId);
  if (def) return def.name;
  // Неизвестное семейство: сегмент до "/" с заглавной буквы
  const seg = modelId.split("/")[0] ?? modelId;
  return seg.charAt(0).toUpperCase() + seg.slice(1, 14);
}

/** Детерминированный оттенок аватара из имени семьи (волна иконок-фиксов):
 *  у нишевого провайдера кружок выглядит умышленным (как аватары в
 *  мессенджерах), а не «данные не приехали» */
function hueOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) % 360;
  }
  return h;
}

/** Относительная яркость hex-цвета: бренд-заливки вроде #1B1B1B (Kimi/
 *  Moonshot) и #000 (Ollama) невидимы на тёмной теме — такие глифы
 *  рисуются цветом текста темы */
function hexLuminance(hex: string): number {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

interface ProviderIconProps {
  modelId: string;
  size?: number;
}

/**
 * Логотип провайдера модели: локальный брендовый SVG, иначе цветная буква.
 */
export default function ProviderIcon({ modelId, size = 18 }: ProviderIconProps) {
  const family = familyOf(modelId);
  const brand = matchBrand(modelId);
  const icon = brand?.slug ? PROVIDER_ICONS[brand.slug] : undefined;

  const circleStyle = {
    width: size,
    height: size,
    fontSize: Math.max(9, Math.round(size * 0.5)),
  };

  if (!icon) {
    // Фолбэк: первая буква семейства. Цвет: фирменный бренда, у нишевых —
    // детерминированный hue из имени (кружок-аватар, а не серая заглушка)
    const hue = hueOf(family || modelId || "?");
    const color = brand?.color ? `#${brand.color}` : `hsl(${hue} 72% 72%)`;
    const bg = brand ? undefined : `hsl(${hue} 38% 24%)`;
    return (
      <span
        style={{ ...circleStyle, ...(bg ? { background: bg } : {}) }}
        // title только при известном семействе: жёсткая русская заглушка
        // «провайдер» показывалась на всех языках
        title={family || undefined}
        className="flex shrink-0 items-center justify-center rounded-full bg-halo-raised font-semibold uppercase text-halo-text"
      >
        <span style={color ? { color } : undefined}>{(family || "?").charAt(0)}</span>
      </span>
    );
  }

  const fillHex = `#${brand?.color ?? icon.hex}`;
  return (
    <span
      style={circleStyle}
      title={family}
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-halo-raised"
    >
      <svg
        role="img"
        aria-label={family}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        className="size-full"
      >
        <path
          d={icon.path}
          // Тёмные бренд-заливки (Kimi #1B1B1B, Ollama #000) на тёмной теме
          // невидимы — глиф рисуется цветом текста темы (var адаптируется)
          fill={hexLuminance(fillHex) < 0.2 ? "var(--halo-text)" : fillHex}
        />
      </svg>
    </span>
  );
}
