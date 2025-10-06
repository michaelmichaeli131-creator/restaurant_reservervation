// src/routes/owner_hours.ts
// ניהול שעות פתיחה שבועיות למסעדה — לבעלים בלבד (בחירה ושמירה פר-יום)

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import {
  getRestaurant,
  updateRestaurant,
  type Restaurant,
  type WeeklySchedule,
} from "../database.ts";
import { requireOwner } from "../lib/auth.ts";
import { debugLog } from "../lib/debug.ts";

const ownerHoursRouter = new Router();

const DAY_LABELS = ["ראשון","שני","שלישי","רביעי","חמישי","שישי","שבת"] as const;

function toHHMM(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const s2 = s.includes(".") ? s.replace(".", ":") : s;
  const m = s2.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Math.max(0, Math.min(23, Number(m[1])));
  const mi = Math.max(0, Math.min(59, Number(m[2])));
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

function parseWeeklyFromPayload(payload: Record<string, unknown>): WeeklySchedule {
  const out: WeeklySchedule = {};
  for (let d = 0 as 0|1|2|3|4|5|6; d <= 6; d = (d + 1) as 0|1|2|3|4|5|6) {
    const open = toHHMM(payload[`d${d}_open`]);
    const close = toHHMM(payload[`d${d}_close`]);
    const enabledRaw = payload[`d${d}_enabled`];
    const enabled = enabledRaw === "on" || enabledRaw === true || (!!open && !!close);
    out[d] = (enabled && open && close) ? { open, close } : null;
  }
  return out;
}

// Strong body reader (form/json/text/bytes)
async function readBodyStrong(ctx: any): Promise<{ payload: Record<string, unknown>; dbg: Record<string, unknown> }> {
  const out: Record<string, unknown> = {};
  const dbg: Record<string, unknown> = { ct: (ctx.request.headers.get("content-type") ?? "").toLowerCase(), phases: [] as any[] };
  const phase = (name: string, data?: unknown) => { try { (dbg.phases as any[]).push({ name, data }); } catch {} };
  const merge = (src: Record<string, unknown>) => { for (const [k, v] of Object.entries(src)) if (v !== undefined && v !== null && v !== "") out[k] = v; };

  const fromEntries = (iter: Iterable<[string, FormDataEntryValue]> | URLSearchParams) => {
    const o: Record<string, unknown> = {};
    for (const [k, v0] of (iter as any).entries()) o[k] = typeof v0 === "string" ? v0 : (v0?.name ?? "");
    return o;
  };

  async function tryOak(type: "form"|"json"|"form-data"|"text"|"bytes") {
    try {
      const b = await (ctx.request as any).body?.({ type });
      if (!b) return;
      const t = b.type;
      if (t === "form") {
        const v = await b.value as URLSearchParams;
        const o = fromEntries(v);
        phase("oak.form", o); merge(o);
      } else if (t === "form-data") {
        const v = await b.value; const r = await v.read(); const o = (r?.fields ?? {}) as Record<string, unknown>;
        phase("oak.form-data", o); merge(o);
      } else if (t === "json") {
        const j = await b.value as Record<string, unknown>;
        phase("oak.json", j); merge(j || {});
      } else if (t === "text") {
        const txt = await b.value as string;
        phase("oak.text", txt.length > 200 ? txt.slice(0,200) + "…" : txt);
        try { const j = JSON.parse(txt); phase("oak.text->json", j); merge(j as any); }
        catch { const sp = new URLSearchParams(txt); const o = fromEntries(sp); if (Object.keys(o).length) { phase("oak.text->urlencoded", o); merge(o); } }
      } else if (t === "bytes") {
        const u8 = await b.value as Uint8Array; const txt = new TextDecoder().decode(u8);
        phase("oak.bytes", txt.length > 200 ? txt.slice(0,200) + "…" : txt);
        try { const j = JSON.parse(txt); phase("oak.bytes->json", j); merge(j as any); }
        catch { const sp = new URLSearchParams(txt); const o = fromEntries(sp); if (Object.keys(o).length) { phase("oak.bytes->urlencoded", o); merge(o); } }
      }
    } catch (e) { phase(`oak.${type}.error`, String(e)); }
  }

  await tryOak("form");
  await tryOak("json");
  await tryOak("form-data");
  await tryOak("text");
  await tryOak("bytes");

  // Native fallbacks (Deno Deploy)
  const reqAny: any = ctx.request as any;
  try { if (typeof reqAny.formData === "function") { const fd = await reqAny.formData(); const o = fromEntries(fd); if (Object.keys(o).length) { phase("native.formData", o); merge(o); } } } catch (e) { phase("native.formData.error", String(e)); }
  try { if (typeof reqAny.json === "function")     { const j = await reqAny.json(); if (j && typeof j === "object") { phase("native.json", j); merge(j as any); } } } catch (e) { phase("native.json.error", String(e)); }
  try {
    if (typeof reqAny.text === "function") {
      const t = await reqAny.text(); if (t) {
        phase("native.text", t.length > 200 ? t.slice(0,200) + "…" : t);
        try { const j = JSON.parse(t); phase("native.text->json", j); merge(j as any); }
        catch { const sp = new URLSearchParams(t); const o = fromEntries(sp); if (Object.keys(o).length) { phase("native.text->urlencoded", o); merge(o); } }
      }
    }
  } catch (e) { phase("native.text.error", String(e)); }

  return { payload: out, dbg };
}

// ---------- GET ----------
ownerHoursRouter.get("/owner/restaurants/:id/hours", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const id = ctx.params.id!;
  const r = await getRestaurant(id);

  debugLog("[owner_hours][GET] load", { id, found: !!r, ownerId: r?.ownerId, userId: (ctx.state as any)?.user?.id });

  if (!r || r.ownerId !== (ctx.state as any)?.user?.id) {
    ctx.response.status = Status.NotFound;
    await render(ctx, "error", { title: "לא נמצא", message: "מסעדה לא נמצאה או שאין הרשאה." });
    return;
  }

  debugLog("[owner_hours][GET] current.weeklySchedule", r.weeklySchedule ?? null);

  const weekly: WeeklySchedule = {};
  for (let d = 0 as 0|1|2|3|4|5|6; d <= 6; d = (d + 1) as 0|1|2|3|4|5|6) {
    const cur = (r.weeklySchedule ?? {})[d] as any;
    weekly[d] = (cur && cur.open && cur.close) ? { open: cur.open, close: cur.close } : null;
  }

  await render(ctx, "owner_hours", {
    title: `שעות פתיחה — ${r.name}`,
    page: "owner_hours",
    restaurant: r,
    weekly,
    labels: DAY_LABELS,
    saved: ctx.request.url.searchParams.get("saved") === "1",
  });
});

// ---------- POST ----------
ownerHoursRouter.post("/owner/restaurants/:id/hours", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  if (!r || r.ownerId !== (ctx.state as any)?.user?.id) {
    ctx.response.status = Status.NotFound;
    await render(ctx, "error", { title: "לא נמצא", message: "מסעדה לא נמצאה או שאין הרשאה." });
    return;
  }

  const { payload, dbg } = await readBodyStrong(ctx);
  debugLog("[owner_hours][POST] body", { ct: dbg.ct, keys: Object.keys(payload) });

  const weekly = parseWeeklyFromPayload(payload);
  debugLog("[owner_hours][POST] parsed.weekly", weekly);

  const cap = Number(payload["capacity"]);
  const slot = Number(payload["slotIntervalMinutes"]);
  const dur  = Number(payload["serviceDurationMinutes"]);

  const patch: Partial<Restaurant> = {
    weeklySchedule: weekly,
    capacity: Number.isFinite(cap) && cap > 0 ? cap : r.capacity,
    slotIntervalMinutes: Number.isFinite(slot) && slot > 0 ? slot : r.slotIntervalMinutes,
    serviceDurationMinutes: Number.isFinite(dur) && dur > 0 ? dur : r.serviceDurationMinutes,
  };

  try {
    await updateRestaurant(id, patch);
    debugLog("[owner_hours][POST] updateRestaurant.ok", { id });
  } catch (e) {
    debugLog("[owner_hours][POST] updateRestaurant.error", { error: String(e) });
    ctx.response.status = Status.InternalServerError;
    await render(ctx, "error", { title: "שגיאה בשמירה", message: "אירעה תקלה בשמירת שעות הפתיחה." });
    return;
  }

  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", `/owner/restaurants/${encodeURIComponent(id)}/hours?saved=1`);
});

export default ownerHoursRouter;
export { ownerHoursRouter };
