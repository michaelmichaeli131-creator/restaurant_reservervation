// src/routes/owner_hours.ts
// ניהול שעות פתיחה שבועיות למסעדה — לבעלים בלבד
// תיקון: פרסור גוף JSON/FORM עקבי + ולידציה שמונעת השארת null לא מכוון

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import {
  getRestaurant,
  updateRestaurant,
  type WeeklySchedule,
  type DayOfWeek,
} from "../database.ts";
import { requireOwner } from "../lib/auth.ts";
import { debugLog } from "../lib/debug.ts";

const ownerHoursRouter = new Router();

const DAY_LABELS = ["ראשון","שני","שלישי","רביעי","חמישי","שישי","שבת"] as const;

type DayPatch = {
  closed?: boolean;
  ranges?: Array<{ open: string; close: string }>;
};

type IncomingPayload = {
  capacity?: number | string;
  slotIntervalMinutes?: number | string;
  weeklySchedule?: Record<string, DayPatch>;
};

/** המרה ל-HH:MM או null */
function toHHMM(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const s2 = s.includes(".") ? s.replace(".", ":") : s;
  const m = s2.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Math.max(0, Math.min(23, Number(m[1])));
  const mi = Math.max(0, Math.min(59, Number(m[2])));
  return `${h.toString().padStart(2,"0")}:${mi.toString().padStart(2,"0")}`;
}

/** האם t1 < t2 בזמן */
function timeLT(t1: string, t2: string): boolean {
  const [h1, m1] = t1.split(":").map(Number);
  const [h2, m2] = t2.split(":").map(Number);
  return h1 < h2 || (h1 === h2 && m1 < m2);
}

/** בניית weeklySchedule בטוח */
function normalizeWeeklySchedule(input?: IncomingPayload["weeklySchedule"]): WeeklySchedule | undefined {
  if (!input || typeof input !== "object") return undefined;

  const out: WeeklySchedule = {} as any;
  for (let d = 0 as DayOfWeek; d <= 6; d++) {
    const day = input[String(d)] as DayPatch | undefined;
    if (!day) { 
      // לא נגענו ביום – לא נכפה שינוי
      continue;
    }
    if (day.closed) {
      out[d] = null;
      continue;
    }
    const arr = Array.isArray(day.ranges) ? day.ranges : [];
    const norm = [];
    for (const r of arr) {
      const o = toHHMM(r?.open);
      const c = toHHMM(r?.close);
      if (!o || !c) continue;
      if (!timeLT(o, c)) continue; // פתיחה חייבת להיות לפני סגירה
      norm.push({ open: o, close: c });
    }
    // אם לא נוספו טווחים — נסגור את היום מפורשות (כדי לא להשאיר undefined/ריק)
    out[d] = norm.length ? norm : null;
  }
  return out;
}

/** קריאת גוף בצורה בטוחה: JSON תחילה, נפילה ל-form */
async function readSafePayload(ctx: any): Promise<IncomingPayload> {
  const ct = ctx.request.headers.get("content-type") || "";
  try {
    if (ct.includes("application/json")) {
      const body = ctx.request.body({ type: "json" });
      const data = await body.value;
      if (data && typeof data === "object") return data as IncomingPayload;
    }
  } catch (e) {
    debugLog("[owner_hours][POST] JSON parse failed", String(e));
  }

  // fallback: x-www-form-urlencoded
  try {
    const body = ctx.request.body({ type: "form" });
    const form = await body.value;
    const obj: any = {};
    for (const [k, v] of form.entries()) obj[k] = v;
    // weeklySchedule עשוי להגיע כמחרוזת JSON
    if (obj.weeklySchedule && typeof obj.weeklySchedule === "string") {
      try { obj.weeklySchedule = JSON.parse(obj.weeklySchedule); } catch {}
    }
    return obj as IncomingPayload;
  } catch (e) {
    debugLog("[owner_hours][POST] form parse failed", String(e));
  }

  return {};
}

// ---------- GET ----------
ownerHoursRouter.get("/owner/restaurants/:id/hours", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  debugLog("[owner_hours][GET] load", { id, found: !!r, ownerId: r?.ownerId, userId: (ctx.state?.user?.id ?? null) });

  if (!r) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Restaurant not found";
    return;
  }
  if (r.ownerId !== ctx.state.user.id) {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = "Forbidden";
    return;
  }

  const saved = ctx.request.url.searchParams.get("saved") === "1";
  ctx.response.body = await render("owner_hours.eta", {
    restaurant: r,
    saved,
    dayLabels: DAY_LABELS,
  });
});

// ---------- POST ----------
ownerHoursRouter.post("/owner/restaurants/:id/hours", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  if (!r) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Restaurant not found";
    return;
  }
  if (r.ownerId !== ctx.state.user.id) {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = "Forbidden";
    return;
  }

  const payload = await readSafePayload(ctx);
  debugLog("[owner_hours][POST] raw payload", payload);

  // capacity & slotIntervalMinutes
  const patch: Partial<typeof r> = {};
  if (payload.capacity !== undefined) {
    const n = Number(payload.capacity);
    if (Number.isFinite(n) && n > 0) patch.capacity = Math.floor(n);
  }
  if (payload.slotIntervalMinutes !== undefined) {
    const s = Number(payload.slotIntervalMinutes);
    if (Number.isFinite(s) && s >= 5 && s <= 180) patch.slotIntervalMinutes = Math.floor(s);
  }

  const weekly = normalizeWeeklySchedule(payload.weeklySchedule);
  if (weekly) patch.weeklySchedule = weekly;

  // ולידציה כללית: אל תשאיר ימים undefined אם UI שלח אובייקט יום
  // (normalizeWeeklySchedule כבר הופך יום ללא טווחים ל-null => סגור)
  debugLog("[owner_hours][POST] patch.weeklySchedule", patch.weeklySchedule);

  const accept = ctx.request.headers.get("accept") || "";
  await updateRestaurant(id, patch as any);

  if (accept.includes("application/json") || (payload as any).__json === true) {
    ctx.response.status = Status.OK;
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify({
      ok: true,
      weeklySchedule: patch.weeklySchedule ?? r.weeklySchedule,
      capacity: patch.capacity ?? r.capacity,
      slotIntervalMinutes: patch.slotIntervalMinutes ?? r.slotIntervalMinutes,
    }, null, 2);
  } else {
    ctx.response.status = Status.SeeOther;
    ctx.response.headers.set("Location", `/owner/restaurants/${encodeURIComponent(id)}/hours?saved=1`);
  }
});

export default ownerHoursRouter;
export { ownerHoursRouter };
