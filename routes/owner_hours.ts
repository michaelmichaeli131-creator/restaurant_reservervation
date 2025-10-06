// src/routes/owner_hours.ts
// ניהול שעות פתיחה שבועיות למסעדה — לבעלים בלבד
// נקודות מפתח:
// 1) render(ctx, ...) כדי למנוע wantsJSON על undefined
// 2) קורא גוף היברידי: oak.body(...) או Fetch API (json()/formData())
// 3) normalizeWeeklySchedule מקבל גם {open,close} וגם {ranges:[{open,close}]}
// 4) Redirect/JSON בהתאם ל-Accept

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

type FlatDay = { open?: string; close?: string; closed?: boolean };
type DayPatch = { closed?: boolean; ranges?: Array<{ open: string; close: string }> };
type IncomingPayload = {
  capacity?: number | string;
  slotIntervalMinutes?: number | string;
  weeklySchedule?: Record<string, DayPatch | FlatDay | null>;
};

// ---------- Utils ----------
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
function timeLT(t1: string, t2: string): boolean {
  const [h1, m1] = t1.split(":").map(Number);
  const [h2, m2] = t2.split(":").map(Number);
  return h1 < h2 || (h1 === h2 && m1 < m2);
}

/** ממיר את weeklySchedule הנכנס לפורמט הקנוני: יום = null (סגור) או מערך טווחים חוקי */
function normalizeWeeklySchedule(input?: IncomingPayload["weeklySchedule"]): WeeklySchedule | undefined {
  if (!input || typeof input !== "object") return undefined;

  const out: WeeklySchedule = {} as any;

  for (let d = 0 as DayOfWeek; d <= 6; d++) {
    const key = String(d);
    if (!(key in input)) continue; // לא נגענו ביום הזה → לא משנים
    const raw = input[key];

    if (raw === null) { out[d] = null; continue; }

    // תמיכה גם במבנה "שטוח" מה-UI וגם במבנה עם ranges
    const asFlat = raw as FlatDay;
    const asRanges = raw as DayPatch;

    // סגור מפורש?
    if (asFlat?.closed === true || asRanges?.closed === true) {
      out[d] = null;
      continue;
    }

    // אם הגיע שטוח {open,close}
    if ((asFlat?.open || asFlat?.close) && !Array.isArray((asRanges as any)?.ranges)) {
      const o = toHHMM(asFlat.open);
      const c = toHHMM(asFlat.close);
      out[d] = (o && c && timeLT(o, c)) ? [{ open: o, close: c }] : null;
      continue;
    }

    // אם הגיע עם ranges
    const arr = Array.isArray(asRanges?.ranges) ? asRanges!.ranges! : [];
    const norm: Array<{ open: string; close: string }> = [];
    for (const r of arr) {
      const o = toHHMM(r?.open);
      const c = toHHMM(r?.close);
      if (!o || !c) continue;
      if (!timeLT(o, c)) continue;
      norm.push({ open: o, close: c });
    }
    out[d] = norm.length ? norm : null;
  }

  return out;
}

// ---------- Body Reader (Oak ו/או Fetch) ----------
async function readSafePayload(ctx: any): Promise<IncomingPayload> {
  // 1) Oak: ctx.request.body קיים?
  try {
    if (typeof ctx.request?.body === "function") {
      // JSON
      try {
        const j = ctx.request.body({ type: "json" });
        const data = await j.value;
        if (data && typeof data === "object") {
          debugLog("[owner_hours] parsed JSON(oak)", data);
          return data as IncomingPayload;
        }
      } catch {}
      // x-www-form-urlencoded
      try {
        const f = ctx.request.body({ type: "form" });
        const form = await f.value;
        const obj: any = {};
        for (const [k, v] of form.entries()) obj[k] = v;
        if (typeof obj.weeklySchedule === "string") {
          try { obj.weeklySchedule = JSON.parse(obj.weeklySchedule); } catch {}
        }
        debugLog("[owner_hours] parsed form(oak)", obj);
        return obj as IncomingPayload;
      } catch {}
      // form-data (multipart)
      try {
        const fd = ctx.request.body({ type: "form-data" });
        const formData = await fd.value.read();
        const obj: any = { ...(formData?.fields ?? {}) };
        if (typeof obj.weeklySchedule === "string") {
          try { obj.weeklySchedule = JSON.parse(obj.weeklySchedule); } catch {}
        }
        debugLog("[owner_hours] parsed form-data(oak)", obj);
        return obj as IncomingPayload;
      } catch {}
      // text → ננסה JSON
      try {
        const t = ctx.request.body({ type: "text" });
        const txt = await t.value;
        if (txt && txt.trim().startsWith("{")) {
          try {
            const data = JSON.parse(txt);
            debugLog("[owner_hours] parsed text->json(oak)", data);
            return data as IncomingPayload;
          } catch {}
        }
      } catch {}
    }
  } catch (e) {
    debugLog("[owner_hours] body(oak) read failed", String(e));
  }

  // 2) Fetch-like: request.json()/formData()
  try {
    const ct = ctx.request?.headers?.get?.("content-type") || "";
    if (ct.includes("application/json") && typeof ctx.request?.json === "function") {
      const data = await ctx.request.json();
      if (data && typeof data === "object") {
        debugLog("[owner_hours] parsed JSON(fetch)", data);
        return data as IncomingPayload;
      }
    }
  } catch (e) {
    debugLog("[owner_hours] json(fetch) failed", String(e));
  }
  try {
    if (typeof ctx.request?.formData === "function") {
      const fd = await ctx.request.formData();
      const obj: any = {};
      for (const [k, v] of fd.entries()) obj[k] = v;
      if (typeof obj.weeklySchedule === "string") {
        try { obj.weeklySchedule = JSON.parse(obj.weeklySchedule); } catch {}
      }
      debugLog("[owner_hours] parsed formData(fetch)", obj);
      return obj as IncomingPayload;
    }
  } catch (e) {
    debugLog("[owner_hours] formData(fetch) failed", String(e));
  }

  return {};
}

// ---------- GET ----------
ownerHoursRouter.get("/owner/restaurants/:id/hours", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const id = ctx.params.id!;
  debugLog("[owner_hours][GET]", { path: ctx.request.url.pathname, id });

  const r = await getRestaurant(id);
  debugLog("[owner_hours][GET] restaurant", { id, found: !!r, ownerId: r?.ownerId, userId: (ctx.state as any)?.user?.id });

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
    weekly: r.weeklySchedule,
    saved,
    dayLabels: DAY_LABELS,
    title: `שעות פתיחה — ${r.name}`,
    page: "owner_hours",
  });
});

// ---------- POST ----------
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
  debugLog("[owner_hours][POST] payload", payload);

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
  if (weekly) {
    patch.weeklySchedule = weekly;
    debugLog("[owner_hours][POST] normalized weeklySchedule", weekly);
  }

  await updateRestaurant(id, patch as any);

  const accept = ctx.request.headers.get("accept") || "";
  if (accept.includes("application/json")) {
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
