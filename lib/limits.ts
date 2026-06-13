// src/lib/limits.ts
// Subscription tier limits — SOFT-LAUNCH ONLY.
// These numbers drive usage displays and warnings in the UI; nothing in the
// app hard-blocks on them (business decision until payments exist).

export type Tier = "free" | "pro" | "enterprise";

export interface TierLimits {
  reservationsPerMonth: number; // Infinity = unlimited
  staff: number;                // Infinity = unlimited
}

export const TIER_LIMITS: Record<Tier, TierLimits> = {
  free: { reservationsPerMonth: 100, staff: 1 },
  pro: { reservationsPerMonth: Infinity, staff: 10 },
  enterprise: { reservationsPerMonth: Infinity, staff: Infinity },
};

const TIER_FALLBACK_LABELS: Record<Tier, string> = {
  free: "Free",
  pro: "Pro",
  enterprise: "Enterprise",
};

function normalizeTier(tier: unknown): Tier {
  const t = String(tier ?? "").trim().toLowerCase();
  return (t === "pro" || t === "enterprise") ? t : "free";
}

/**
 * Human-readable tier name. Looks up `billing.tier.<tier>` via the provided
 * i18n `t` function (when present in the page/base dict) and falls back to
 * the English label.
 */
export function tierLabel(
  tier: unknown,
  t?: (key: string, vars?: Record<string, unknown>) => string,
): string {
  const norm = normalizeTier(tier);
  if (typeof t === "function") {
    try {
      const key = `billing.tier.${norm}`;
      const s = t(key);
      if (typeof s === "string" && s && s !== key && s !== `(${key})`) return s;
    } catch {
      // fall through to fallback label
    }
  }
  return TIER_FALLBACK_LABELS[norm];
}

/** True only when the limit is finite and usage exceeds it. */
export function isOverLimit(used: number, limit: number): boolean {
  return Number.isFinite(limit) && Number(used) > Number(limit);
}
