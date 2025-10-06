// src/routes/owner_hours.ts
// ניהול שעות פתיחה שבועיות למסעדה — לבעלים בלבד
// Reader היברידי (Oak body() או Fetch), נרמול weeklySchedule, render(ctx,...), ו-Aliases היסטוריים.

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

type DayPatch = { closed?: boolean; ranges?: Array<{ open: string; close: string }>; };
type IncomingPayload = {
  capacity?: number | string;
  slotIntervalMinutes?: number | string;
  weeklySchedule?: Record<string, DayPatch | null>;
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
function normalizeWeeklySchedule(input?: IncomingPayload["weeklySchedule"]): WeeklySchedule | undefined {
  if (!input || typeof input !== "object") return undefined;
  const out: WeeklySchedule = {} as any;

  for (let d = 0 as DayOfWeek; d <= 6; d++) {
    const key = String(d);
    if (!(key in input)) continue; // לא נגענו ביום הזה → לא משנים
    const day = input[key] as DayPatch | null;

    if (day === null || (day as any)?.closed) { out[d] = null; continue; }

    const arr = Array.isArray(day?.ranges) ? day!.ranges! : [];
    const norm: Array<{open:string;close:string}> = [];
    for (const r of arr) {
      const o = toHHMM(r?.open);
      const c = toHHMM(r?.close);
      if (!o || !c) continue;
      if (!timeLT(o, c)) continue;
      norm.push({ open: o, close: c });
    }
    out[d] = norm.length ? norm : null; // אם לא נשארו טווחים — נסגור מפורשות
  }
  return out;
}

// ---------- Body Reader (Oak ו/או Fetch) ----------
async function readSafePayload(ctx: any): Promise<IncomingPayload> {
  // 1) Oak: ctx.request.body קיים?
  try {
    if (typeof ctx.request?.body === "function") {
      // ננסה קודם JSON
      try {
        const j = ctx.request.body({ type: "json" });
        const data = await j.value;
        if (data && typeof data === "object") return data as IncomingPayload;
      } catch {}
      // אח"כ x-www-form-urlencoded
      try {
        const f = ctx.request.body({ type: "form" });
        const form = await f.value;
        const obj: any = {};
        for (const [k, v] of form.entries()) obj[k] = v;
        if (typeof obj.weeklySchedule === "string") {
          try { obj.weeklySchedule = JSON.parse(obj.weeklySchedule); } catch {}
        }
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
        return obj as IncomingPayload;
      } catch {}
      // text → נסה JSON
      try {
        const t = ctx.request.body({ type: "text" });
        const txt = await t.value;
        if (txt && txt.trim().startsWith("{")) {
          try { return JSON.parse(txt); } catch {}
        }
      } catch {}
    }
  } catch (e) {
    debugLog("[owner_hours][POST] oak body() path failed", String(e));
  }

  // 2) Fetch-like: request.json()/formData()
  try {
    const ct = ctx.request?.headers?.get?.("content-type") || "";
    if (ct.includes("application/json") && typeof ctx.request?.json === "function") {
      const data = await ctx.request.json();
      if (data && typeof data === "object") return data as IncomingPayload;
    }
  } catch (e) {
    debugLog("[owner_hours][POST] fetch json() failed", String(e));
  }
  try {
    if (typeof ctx.request?.formData === "function") {
      const fd = await ctx.request.formData();
      const obj: any = {};
      for (const [k, v] of fd.entries()) obj[k] = v;
      if (typeof obj.weeklySchedule === "string") {
        try { obj.weeklySchedule = JSON.parse(obj.weeklySchedule); } catch {}
      }
      return obj as IncomingPayload;
    }
  } catch (e) {
    debugLog("[owner_hours][POST] fetch formData() failed", String(e));
  }

  return {};
}

// ---------- Aliases היסטוריים ----------
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

// ---------- GET ----------
ownerHoursRouter.get("/owner/restaurants/:id/hours", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const id = ctx.params.id!;
  debugLog("[owner_hours][GET] enter", { path: ctx.request.url.pathname, id });

  const r = await getRestaurant(id);
  debugLog("[owner_hours][GET] load", { id, found: !!r, ownerId: r?.ownerId, userId: (ctx.state as any)?.user?.id });

  if (!r) { ctx.response.status = Status.NotFound; await render(ctx, "error", { title: "לא נמצא", message: "המסעדה לא נמצאה." }); return; }
  if (r.ownerId !== (ctx.state as any)?.user?.id) {
    ctx.response.status = Status.Forbidden; await render(ctx, "error", { title: "אין הרשאה", message: "אין הרשאה למסעדה זו." }); return;
  }

  const saved = ctx.request.url.searchParams.get("saved") === "1";
  await render(ctx, "owner_hours.eta", { restaurant: r, saved, dayLabels: DAY_LABELS });
});

// ---------- POST ----------
ownerHoursRouter.post("/owner/restaurants/:id/hours", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  if (!r) { ctx.response.status = Status.NotFound; await render(ctx, "error", { title: "לא נמצא", message: "המסעדה לא נמצאה." }); return; }
  if (r.ownerId !== (ctx.state as any)?.user?.id) {
    ctx.response.status = Status.Forbidden; await render(ctx, "error", { title: "אין הרשאה", message: "אין הרשאה למסעדה זו." }); return;
  }

  const payload = await readSafePayload(ctx);
  debugLog("[owner_hours][POST] raw payload", payload);

  const patch: Partial<typeof r> = {};
  if (payload.capacity !== undefined) {
    const n = Number(payload.capacity); if (Number.isFinite(n) && n > 0) patch.capacity = Math.floor(n);
  }
  if (payload.slotIntervalMinutes !== undefined) {
    const s = Number(payload.slotIntervalMinutes); if (Number.isFinite(s) && s >= 5 && s <= 180) patch.slotIntervalMinutes = Math.floor(s);
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
