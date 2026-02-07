// src/routes/owner_capacity.ts
// ניהול קיבולת/גריד/משך ישיבה — רק למשתמש מחובר (בעל המסעדה)

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { getRestaurant, updateRestaurant, type Restaurant } from "../database.ts";
import { requireOwner } from "../lib/auth.ts";

function toInt(v: unknown, dflt: number) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}
function trim(s?: string) { return (s ?? "").trim(); }

const ownerCapacityRouter = new Router();

// טופס
ownerCapacityRouter.get("/owner/restaurants/:id/capacity", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  if (!r || r.ownerId !== (ctx.state as any)?.user?.id) {
    ctx.response.status = Status.NotFound;
    await render(ctx, "error", { title: "לא נמצא", message: "מסעדה לא נמצאה או שאין הרשאה." });
    return;
  }
  await render(ctx, "owner_restaurant_capacity", {
    title: `קיבולת וזמנים — ${r.name}`,
    page: "owner_capacity",
    restaurant: r,
    saved: ctx.request.url.searchParams.get("saved") === "1",
  });
});

// שמירה
ownerCapacityRouter.post("/owner/restaurants/:id/capacity", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  if (!r || r.ownerId !== (ctx.state as any)?.user?.id) {
    ctx.response.status = Status.NotFound;
    await render(ctx, "error", { title: "לא נמצא", message: "מסעדה לא נמצאה או שאין הרשאה." });
    return;
  }

  // תמיכה ב-urlencoded
  const body = await (ctx.request.body({ type: "form" }).value) as URLSearchParams;
  const capacity = toInt(body.get("capacity") ?? "", r.capacity);
  const slot     = toInt(body.get("slotIntervalMinutes") ?? "", r.slotIntervalMinutes);
  const span     = toInt(body.get("serviceDurationMinutes") ?? "", r.serviceDurationMinutes);
  const phone    = trim(body.get("phone") ?? "") || r.phone;

  const patch: Partial<Restaurant> = {
    capacity,
    slotIntervalMinutes: slot,
    serviceDurationMinutes: span,
    phone,
  };
  await updateRestaurant(id, patch);

  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", `/owner/restaurants/${encodeURIComponent(id)}/capacity?saved=1`);
});

export default ownerCapacityRouter;
export { ownerCapacityRouter };
