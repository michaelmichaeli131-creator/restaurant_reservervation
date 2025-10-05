// src/routes/owner_hours.ts
// ניהול שעות פתיחה שבועיות למסעדה — לבעלים בלבד

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { getRestaurant, updateRestaurant, type Restaurant, type WeeklySchedule } from "../database.ts";
import { requireOwner } from "../lib/auth.ts";

const ownerHoursRouter = new Router();

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

function parseWeeklyFromForm(form: URLSearchParams): WeeklySchedule {
  const out: WeeklySchedule = {};
  for (let d = 0 as 0|1|2|3|4|5|6; d <= 6; d = (d+1) as 0|1|2|3|4|5|6) {
    const open = toHHMM(form.get(`d${d}_open`));
    const close = toHHMM(form.get(`d${d}_close`));
    const enabled = form.get(`d${d}_enabled`) === "on" || (!!open && !!close);
    out[d] = (enabled && open && close) ? { open, close } : null;
  }
  return out;
}

const DAY_LABELS = ["ראשון","שני","שלישי","רביעי","חמישי","שישי","שבת"] as const;

ownerHoursRouter.get("/owner/restaurants/:id/hours", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  if (!r || r.ownerId !== (ctx.state as any)?.user?.id) {
    ctx.response.status = Status.NotFound;
    await render(ctx, "error", { title: "לא נמצא", message: "מסעדה לא נמצאה או שאין הרשאה." });
    return;
  }

  const weekly: WeeklySchedule = {};
  for (let d = 0 as 0|1|2|3|4|5|6; d <= 6; d = (d+1) as 0|1|2|3|4|5|6) {
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

ownerHoursRouter.post("/owner/restaurants/:id/hours", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  if (!r || r.ownerId !== (ctx.state as any)?.user?.id) {
    ctx.response.status = Status.NotFound;
    await render(ctx, "error", { title: "לא נמצא", message: "מסעדה לא נמצאה או שאין הרשאה." });
    return;
  }

  const form = await (ctx.request.body({ type: "form" }).value) as URLSearchParams;
  const weekly = parseWeeklyFromForm(form);

  const patch: Partial<Restaurant> = { weeklySchedule: weekly };
  await updateRestaurant(id, patch);

  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", `/owner/restaurants/${encodeURIComponent(id)}/hours?saved=1`);
});

export default ownerHoursRouter;
export { ownerHoursRouter };
