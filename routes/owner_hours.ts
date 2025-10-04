import { Router, Status } from "jsr:@oak/oak";
import { getRestaurant, updateRestaurant, type WeeklySchedule, type OpeningWindow } from "../database.ts";
import { render } from "../lib/view.ts";

const HOUR_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const pad2 = (n: number) => String(n).padStart(2,"0");
function validHHMM(s?: string) { return !!s && HOUR_RE.test(String(s).trim()); }
function asHHMM(s: string) {
  const m = String(s || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return "";
  const h = Math.max(0, Math.min(23, +m[1]));
  const mi = Math.max(0, Math.min(59, +m[2]));
  return `${pad2(h)}:${pad2(mi)}`;
}

function parseScheduleFromPayload(payload: Record<string,string>): WeeklySchedule {
  // נקבל שמות שדות בסגנון:
  // day0_closed=on
  // day0_open1=10:00 day0_close1=14:00
  // day0_open2=18:00 day0_close2=23:00
  // day1_open1=...
  const out: WeeklySchedule = {};
  for (let d = 0; d <= 6; d++) {
    const closed = !!payload[`day${d}_closed`];
    if (closed) { out[d as any] = null; continue; }

    const win1: OpeningWindow | null =
      validHHMM(payload[`day${d}_open1`]) && validHHMM(payload[`day${d}_close1`])
        ? { open: asHHMM(payload[`day${d}_open1`]), close: asHHMM(payload[`day${d}_close1`]) }
        : null;

    const win2: OpeningWindow | null =
      validHHMM(payload[`day${d}_open2`]) && validHHMM(payload[`day${d}_close2`])
        ? { open: asHHMM(payload[`day${d}_open2`]), close: asHHMM(payload[`day${d}_close2`]) }
        : null;

    if (win1 && win2) out[d as any] = [win1, win2];
    else if (win1)    out[d as any] = win1;
    else if (win2)    out[d as any] = win2;
    else              out[d as any] = null; // אין שעות → נחשב כסגור
  }
  return out;
}

export const ownerHoursRouter = new Router();

// TODO: אפשר לעטוף במידלוור אימות בעלים
ownerHoursRouter.get("/owner/restaurants/:id/hours", async (ctx) => {
  const id = String(ctx.params.id ?? "");
  const r = await getRestaurant(id);
  if (!r) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Restaurant not found";
    return;
  }
  await render(ctx, "owner_hours", { page: "owner_hours", title: "שעות פתיחה", restaurant: r });
});

ownerHoursRouter.post("/owner/restaurants/:id/hours", async (ctx) => {
  const id = String(ctx.params.id ?? "");
  const r = await getRestaurant(id);
  if (!r) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Restaurant not found";
    return;
  }

  const body = await ctx.request.body({ type: "form" }).value; // application/x-www-form-urlencoded
  const payload = Object.fromEntries(body.entries()) as Record<string,string>;
  const schedule = parseScheduleFromPayload(payload);

  const updated = await updateRestaurant(id, { weeklySchedule: schedule });
  if (!updated) {
    ctx.response.status = Status.InternalServerError;
    ctx.response.body = "failed to update";
    return;
  }

  // חזרה לדף עם הודעת הצלחה
  const u = new URL(`/owner/restaurants/${encodeURIComponent(id)}/hours`, "http://local");
  u.searchParams.set("saved", "1");
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", u.pathname + u.search);
});

export default ownerHoursRouter;
