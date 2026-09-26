/**
 * Hard Limit: лимиты расхода на одну задачу агента (токены/деньги).
 * Счётчик копится фронтом по usage-событиям стрима; при превышении
 * задача прерывается. Значения — в localStorage («haloui-limits»).
 */

export interface HardLimits {
  /** Лимит токенов на задачу; null = без лимита */
  maxTokens: number | null;
  /** Лимит расходов на задачу, $; null = без лимита */
  maxUsd: number | null;
  /** Цена за 1M токенов (смешанная), $; без неё $-лимит не считается */
  usdPer1M: number | null;
}

const LS_KEY = "haloui-limits";

const DEFAULT_LIMITS: HardLimits = {
  maxTokens: null,
  maxUsd: null,
  usdPer1M: null,
};

/** Число из JSON: конечное неотрицательное — иначе null */
function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

export function loadLimits(): HardLimits {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULT_LIMITS };
    const p = JSON.parse(raw) as Partial<HardLimits>;
    return {
      maxTokens: numOrNull(p.maxTokens),
      maxUsd: numOrNull(p.maxUsd),
      usdPer1M: numOrNull(p.usdPer1M),
    };
  } catch {
    // Битый JSON — начинаем с дефолта «без лимитов»
    return { ...DEFAULT_LIMITS };
  }
}

export function saveLimits(l: HardLimits): void {
  localStorage.setItem(LS_KEY, JSON.stringify(l));
}

/** Ключ локали сработавшего лимита */
export type HardLimitHit = "limits.hitTokens" | "limits.hitUsd";

/**
 * Чистая проверка лимита по накопленному расходу. null — лимит не достигнут.
 * Логика решений раньше была зарыта в handleSend; вынесена сюда для тестов.
 */
export function evalHardLimit(
  lim: HardLimits,
  usage: { prompt: number; completion: number },
): HardLimitHit | null {
  const total = usage.prompt + usage.completion;
  if (lim.maxTokens != null && lim.maxTokens > 0 && total > lim.maxTokens) {
    return "limits.hitTokens";
  }
  if (
    lim.maxUsd != null &&
    lim.maxUsd > 0 &&
    lim.usdPer1M != null &&
    lim.usdPer1M > 0
  ) {
    const usd = (total / 1_000_000) * lim.usdPer1M;
    if (usd > lim.maxUsd) return "limits.hitUsd";
  }
  return null;
}
