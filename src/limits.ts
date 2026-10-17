/**
 * Hard Limit: лимиты расхода на одну задачу агента (токены/деньги).
 * Счётчик копится фронтом по usage-событиям стрима; при превышении
 * задача прерывается. Значения — в localStorage («haloui-limits»).
 */

import { STORAGE_KEYS } from "./storageKeys";

export interface HardLimits {
  /** Лимит токенов на задачу; null = без лимита */
  maxTokens: number | null;
  /** Лимит расходов на задачу, $; null = без лимита */
  maxUsd: number | null;
  /** Цена за 1M токенов (смешанная), $; без неё $-лимит не считается */
  usdPer1M: number | null;
}

const LS_KEY = STORAGE_KEYS.limits;

const DEFAULT_LIMITS: HardLimits = {
  maxTokens: null,
  maxUsd: null,
  usdPer1M: null,
};

/** Число из JSON: конечное неотрицательное — иначе null.
 *  integerOnly: для счетчиков токенов, дробные значения отсекаются */
function numOrNull(v: unknown, integerOnly = false): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return integerOnly ? Math.floor(v) : v;
}

export function loadLimits(): HardLimits {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULT_LIMITS };
    const p = JSON.parse(raw) as Partial<HardLimits>;
    return {
      maxTokens: numOrNull(p.maxTokens, true),
      maxUsd: numOrNull(p.maxUsd),
      usdPer1M: numOrNull(p.usdPer1M),
    };
  } catch {
    // Битый JSON — начинаем с дефолта «без лимитов»
    return { ...DEFAULT_LIMITS };
  }
}

/** Запись. false — сбой (квота localStorage): вызывающий показывает тост,
 *  иначе лимиты молча откатывались к старым при рестарте */
export function saveLimits(l: HardLimits): boolean {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(l));
    return true;
  } catch {
    return false;
  }
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
