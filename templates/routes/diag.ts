// src/routes/diag.ts
import { Router, Status } from "jsr:@oak/oak";
import { getRestaurant, type WeeklySchedule } from "../database.ts";
import { dlog } from "../lib/debug.ts";

function toMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "");
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

function getWindowsForDate(weekly: WeeklySchedule|undefined|null, date: string) {
  if (!weekly) return { hasDay:false, windows:[] as Array<{open:string;close:string}> };
  const d = new Date(date + "T00:00:00");
  const dow = d.getDay();
  const raw = (weekly as any)[dow] ?? (weekly as any)[String(dow)] ?? null;
  const hasDay = Object.prototype.hasOwnProperty.call(weekly as any, dow) ||
                 Object.prototype.hasOwnProperty.call(weekly as any, String(dow));
  let windows: Array<{open:string;close:string}> = [];
  if (Array.isArray(raw)) {
    windows = raw.filter(Boolean).map((x:any)=>({ open: x.open, close: x.close }))
                 .filter(x => !!toMinutes(x.open) && !!toMinutes(x.close));
  } else if (raw && typeof raw === "object" && raw.open && raw.close) {
    windows = [raw];
  }
  return { hasDay, windows };
}

export const diagRouter = new Router();

diagRouter.get("/api/diag/restaurants/:id/hours", async (ctx) => {
  const id = String(ctx.params.id ?? "");
  const date = ctx.request.url.searchParams.get("date") || new Date().toISOString().slice(0,10);
  const r = await getRestaurant(id);

  if (!r) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "not found";
    return;
  }

  const { hasDay, windows } = getWindowsForDate(r.weeklySchedule as WeeklySchedule, date);

  const out = {
    id: r.id,
    name: r.name,
    date,
    serverNow: new Date().toISOString(),
    serverTZ: Intl.DateTimeFormat().resolvedOptions().timeZone,
    weeklyKeys: r.weeklySchedule ? Object.keys(r.weeklySchedule as any) : [],
    weeklySchedule: r.weeklySchedule ?? null,
    hasDay,
    windows,
    photosShape: Array.isArray(r.photos) ? r.photos.map((p:any)=> typeof p === "string" ? "string" : (p && typeof p === "object" ? Object.keys(p) : typeof p)) : null,
  };

  dlog("diag", "hours", out);

  ctx.response.status = Status.OK;
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = JSON.stringify(out, null, 2);
});

export default diagRouter;
