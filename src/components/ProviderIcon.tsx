import { PROVIDER_ICONS } from "./providerIconsData";

/**
 * Логотип провайдера: локальный брендовый SVG (данные simple-icons, CC0),
 * затем цветная буква-фолбэк. D2: раньше SVG тянулся с cdn.simpleicons.org,
 * а favicon нишевых провайдеров — с icons.duckduckgo.com, но CSP
 * `img-src 'self' data: blob:` блокировала оба — в проде фича была мертва,
 * а в dev модельные имена утекали сторонним CDN. Теперь всё локально.
 */
const BRANDS: Record<string, { slug?: string; color?: string }> = {
  deepseek: { slug: "deepseek", color: "4D6BFE" },
  openai: { slug: "openai", color: "74AA9C" },
  google: { slug: "googlegemini", color: "4796E3" },
  anthropic: { slug: "anthropic", color: "D97757" },
  claude: { slug: "anthropic", color: "D97757" },
  meta: { slug: "meta", color: "0866FF" },
  mistralai: { slug: "mistralai", color: "FF7000" },
  mistral: { slug: "mistralai", color: "FF7000" },
  nvidia: { slug: "nvidia", color: "76B900" },
  microsoft: { slug: "microsoft", color: "5E5E5E" },
  xai: { color: "E8E6DC" },
  qwen: { slug: "qwen", color: "615CED" },
  zhipu: { color: "3B82F6" },
  glm: { color: "3B82F6" },
  thudm: { color: "3B82F6" },
  moonshot: { slug: "moonshotai", color: "1B1B1B" },
  kimi: { slug: "moonshotai", color: "1B1B1B" },
  cohere: { color: "39594D" },
  perplexity: { slug: "perplexity", color: "20808D" },
  ai21: { color: "E03C31" },
  liquid: { color: "8B5CF6" },
  grok: { color: "E8E6DC" },
  minimax: { color: "E8402A" },
  baichuan: { color: "E8402A" },
  internlm: { color: "B33A3A" },
  stepfun: { color: "4D6BFE" },
  together: { color: "0F6FFF" },
  fireworks: { color: "FF7000" },
  groq: { color: "F55036" },
  cerebras: { color: "FF7A00" },
  openrouter: { slug: "openrouter", color: "8B5CF6" },
  huggingface: { slug: "huggingface", color: "FFD21E" },
};

export function familyOf(modelId: string): string {
  return (modelId.split("/")[0] ?? "").toLowerCase();
}

/** Короткое имя модели без семейства: "deepseek/deepseek-r1:free" → "deepseek-r1:free" */
export function shortModelName(modelId: string): string {
  return modelId.split("/").pop() ?? modelId;
}

/** Брендовое имя для компактных мест: "deepseek/deepseek-v4-flash-0731:free" → "DeepSeek" */
export function brandName(modelId: string): string {
  const m = modelId.toLowerCase();
  const brands: [RegExp, string][] = [
    [/deepseek/, "DeepSeek"],
    [/gpt|^o[134]-/, "OpenAI"],
    [/claude/, "Claude"],
    [/gemini/, "Gemini"],
    [/grok/, "Grok"],
    [/llama/, "Llama"],
    [/mistral|mixtral/, "Mistral"],
    [/qwen/, "Qwen"],
    [/glm/, "GLM"],
    [/kimi|moonshot/, "Kimi"],
    [/gemma/, "Gemma"],
    [/phi/, "Phi"],
  ];
  for (const [re, name] of brands) {
    if (re.test(m)) return name;
  }
  // Неизвестное семейство: сегмент до "/" с заглавной буквы
  const seg = modelId.split("/")[0] ?? modelId;
  return seg.charAt(0).toUpperCase() + seg.slice(1, 14);
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
  const brand = BRANDS[family];
  const icon = brand?.slug ? PROVIDER_ICONS[brand.slug] : undefined;

  const circleStyle = {
    width: size,
    height: size,
    fontSize: Math.max(9, Math.round(size * 0.5)),
  };

  if (!icon) {
    // Фолбэк: первая буква семейства в фирменном цвете бренда
    const color = brand?.color ? `#${brand.color}` : undefined;
    return (
      <span
        style={circleStyle}
        // title только при известном семействе: жёсткая русская заглушка
        // «провайдер» показывалась на всех языках
        title={family || undefined}
        className="flex shrink-0 items-center justify-center rounded-full bg-halo-raised font-semibold uppercase text-halo-text"
      >
        <span style={color ? { color } : undefined}>{(family || "?").charAt(0)}</span>
      </span>
    );
  }

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
        <path d={icon.path} fill={`#${brand?.color ?? icon.hex}`} />
      </svg>
    </span>
  );
}
