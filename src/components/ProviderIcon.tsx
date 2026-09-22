import { useEffect, useState } from "react";

/**
 * Бренды: simple-icons (slug + фирменный цвет) и/или домен официального
 * сайта — из него через favicon-CDN достаётся логотип для нишевых провайдеров.
 */
const BRANDS: Record<string, { slug?: string; color?: string; domain?: string }> = {
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
  xai: { slug: "xai", color: "E8E6DC" },
  qwen: { slug: "qwen", color: "615CED", domain: "qwen.ai" },
  zhipu: { slug: "zhipu", color: "3B82F6", domain: "zhipuai.cn" },
  moonshot: { slug: "moonshotai", color: "1B1B1B", domain: "moonshot.cn" },
  kimi: { slug: "moonshotai", color: "1B1B1B", domain: "moonshot.cn" },
  cohere: { slug: "cohere", color: "39594D" },
  perplexity: { slug: "perplexity", color: "20808D" },
  ai21: { slug: "ai21", color: "E03C31", domain: "ai21.com" },
  liquid: { slug: "liquidai", color: "8B5CF6", domain: "liquid.ai" },
  // Нишевые провайдеры — логотип через favicon официального сайта
  grok: { domain: "x.ai" },
  thudm: { domain: "zhipuai.cn" },
  glm: { domain: "zhipuai.cn" },
  inclusionai: { domain: "inclusionai.com" },
  ling: { domain: "inclusionai.com" },
  minimax: { domain: "minimax.io" },
  baichuan: { domain: "baichuan.com" },
  internlm: { domain: "intern-ai.org.cn" },
  stepfun: { domain: "stepfun.com" },
  "01ai": { domain: "01.ai" },
  upstage: { domain: "upstage.ai" },
  nousresearch: { domain: "nousresearch.com" },
  nous: { domain: "nousresearch.com" },
  together: { domain: "together.ai" },
  fireworks: { domain: "fireworks.ai" },
  groq: { domain: "groq.com" },
  cerebras: { domain: "cerebras.ai" },
  featherless: { domain: "featherless.ai" },
  arliai: { domain: "arliai.com" },
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

function candidateUrls(modelId: string): string[] {
  const family = familyOf(modelId);
  const brand = BRANDS[family];
  const urls: string[] = [];
  if (brand?.slug) {
    urls.push(
      `https://cdn.simpleicons.org/${brand.slug}/${brand.color ?? "E8E6DC"}`,
    );
  }
  if (brand?.domain) {
    urls.push(`https://icons.duckduckgo.com/ip3/${brand.domain}.ico`);
  }
  return urls;
}

interface ProviderIconProps {
  modelId: string;
  size?: number;
}

/**
 * Логотип провайдера модели: сначала брендовый SVG (simple-icons),
 * затем favicon официального сайта (нишевые провайдеры),
 * затем буквенный фолбэк — если ничто не загрузилось.
 */
export default function ProviderIcon({ modelId, size = 18 }: ProviderIconProps) {
  const family = familyOf(modelId);
  const candidates = candidateUrls(modelId);
  const [idx, setIdx] = useState(0);
  const [failed, setFailed] = useState(false);

  // Сброс цепочки при смене модели
  useEffect(() => {
    setIdx(0);
    setFailed(false);
  }, [modelId]);

  const circleStyle = {
    width: size,
    height: size,
    fontSize: Math.max(9, Math.round(size * 0.5)),
  };

  const url = candidates[idx];

  if (failed || !url) {
    return (
      <span
        style={circleStyle}
        title={family || "провайдер"}
        className="flex shrink-0 items-center justify-center rounded-full bg-halo-raised font-semibold uppercase text-halo-text"
      >
        {(family || "?").charAt(0)}
      </span>
    );
  }

  return (
    <span
      style={circleStyle}
      title={family}
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-halo-raised"
    >
      <img
        src={url}
        alt={family}
        width={size}
        height={size}
        loading="lazy"
        onError={() => setIdx((i) => i + 1)}
        className="size-full object-contain"
      />
    </span>
  );
}
