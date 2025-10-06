// src/routes/owner_hours.ts
// ניהול שעות פתיחה שבועיות למסעדה — לבעלים בלבד
// עדכון: התאמה ל-Fetch API של Oak החדש (json()/formData() במקום request.body())
// + ולידציה/נרמול למניעת שמירת weeklySchedule ריק בטעות
// + render(ctx, ...) כדי למנוע wantsJSON על undefined
// + נתיבי Alias היסטוריים

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
      // לא נגענו ביום – לא נכפה שינוי (נשאיר כפי שהיה)
      continue;
    }
    if (day.closed) {
      out[d] = null; // סגור מפורש
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
    // אין טווחים תקינים -> נסגור את היום מפורשות כדי לא להשאיר מצב עמום
    out[d] = norm.length ? norm : null;
  }
  return out;
}

/** קריאת גוף בצורה בטוחה (Fetch API): JSON תחילה, ואז formData */
async function readSafePayload(ctx: any): Promise<IncomingPayload> {
  const req: Request = ctx.request; // Oak 17 משתמש ב-Fetch API
  const ct = req.headers.get("content-type") || "";

  // אם הגוף כבר נצרך ע"י Middleware אחר, אל ננסה שוב
  // (ב-Fetch יש bodyUsed; אם איננו, ננסה כרגיל)
  try {
    if (ct.includes("application/json")) {
      // JSON
      const data = await req.json();
      if (data && typeof data === "object") return data as IncomingPayload;
    }
  } catch (e) {
    debugLog("[owner_hours][POST] JSON parse failed", String(e));
  }

  try {
    // x-www-form-urlencoded או multipart/form-data -> formData()
    if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
      const form = await req.formData();
      const obj: any = {};
      for (const [k, v] of form.entries()) {
        obj[k] = typeof v === "string" ? v : v; // קבצים לא צפויים כאן, אבל נשאיר כללי
      }
      // weeklySchedule עשוי להגיע כמחרוזת JSON
      if (obj.weeklySchedule && typeof obj.weeklySchedule === "string") {
        try { obj.weeklySchedule = JSON.parse(obj.weeklySchedule); } catch {}
      }
      return obj as IncomingPayload;
    }
  } catch (e) {
    debugLog("[owner_hours][POST] form parse failed", String(e));
  }

  // ייתכן ש-ct לא הוגדר/ריק — ננסה קודם JSON ואז formData בניסיון עדין
  try {
    const data = await req.json();
    if (data && typeof data === "object") return data as IncomingPayload;
  } catch {}
  try {
    const form = await req.formData();
    const obj: any = {};
    for (const [k, v] of form.entries()) obj[k] = v;
    if (obj.weeklySchedule && typeof obj.weeklySchedule === "string") {
      try { obj.weeklySchedule = JSON.parse(obj.weeklySchedule); } catch {}
    }
    return obj as IncomingPayload;
  } catch {}

  return {};
}

// ---------------------------
// ALIASES (ללא שינוי UI קיים)
// ---------------------------

ownerHoursRouter.get("/owner/hours/:id", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const id = ctx.params.id!;
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", `/owner/restaurants/${encodeURIComponent(id)}/hours`);
});

ownerHoursRouter.get("/owner/restaurants/:id/opening-hours", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const id = ctx.params.id!;
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", `/owner/restaurants/${encodeURIComponent(id)}/hours`);
});

// ---------------------------
// GET: העמוד עצמו
// ---------------------------
ownerHoursRouter.get("/owner/restaurants/:id/hours", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const id = ctx.params.id!;
  debugLog("[owner_hours][GET] enter", { path: ctx.request.url.pathname, id });

  const r = await getRestaurant(id);

  debugLog("[owner_hours][GET] load", { id, found: !!r, ownerId: r?.ownerId, userId: (ctx.state as any)?.user?.id });

  if (!r) {
    ctx.response.status = Status.NotFound;
    await render(ctx, "error", { title: "לא נמצא", message: "המסעדה לא נמצאה." });
    return;
  }
  if (r.ownerId !== (ctx.state as any)?.user?.id) {
    ctx.response.status = Status.Forbidden;
    await render(ctx, "error", { title: "אין הרשאה", message: "אין הרשאה למסעדה זו." });
    return;
  }

  const saved = ctx.request.url.searchParams.get("saved") === "1";
  await render(ctx, "owner_hours.eta", {
    restaurant: r,
    saved,
    dayLabels: DAY_LABELS,
  });
});

// ---------------------------
// POST: שמירה
// ---------------------------
ownerHoursRouter.post("/owner/restaurants/:id/hours", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  if (!r) {
    ctx.response.status = Status.NotFound;
    await render(ctx, "error", { title: "לא נמצא", message: "המסעדה לא נמצאה." });
    return;
  }
  if (r.ownerId !== (ctx.state as any)?.user?.id) {
    ctx.response.status = Status.Forbidden;
    await render(ctx, "error", { title: "אין הרשאה", message: "אין הרשאה למסעדה זו." });
    return;
  }

  const payload = await readSafePayload(ctx);
  debugLog("[owner_hours][POST] raw payload", payload);

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

  debugLog("[owner_hours][POST] patch.weeklySchedule", patch.weeklySchedule);

  await updateRestaurant(id, patch as any);

  const accept = ctx.request.headers.get("accept") || "";
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
