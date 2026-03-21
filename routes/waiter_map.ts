// src/routes/waiter_map.ts
// מפת מלצרים: תצוגה בלבד. קליק על שולחן תפוס פותח את מסך ההזמנה הקיים.

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { requireStaff } from "../lib/auth.ts";
import { requireRestaurantAccess } from "../services/authz.ts";
import { getRestaurant } from "../database.ts";
import { listFloorSections, computeAllTableStatuses as computeLiveTableStatuses } from "../services/floor_service.ts";

export const waiterMapRouter = new Router();

function resolveRestaurantIdForStaff(ctx: any, rid: string): string | null {
  const user = ctx.state.user;
  if (user?.role === "staff") {
    const locked = (ctx.state as any).staffRestaurantId as string | null;
    const effective = rid || locked || "";
    if (!effective) {
      ctx.response.status = Status.Forbidden;
      ctx.response.body = "No restaurant access";
      return null;
    }
    if (rid && locked && rid !== locked) {
      ctx.response.status = Status.Forbidden;
      ctx.response.body = "No restaurant access";
      return null;
    }
    return effective;
  }
  return rid;
}


waiterMapRouter.get("/waiter-map", async (ctx) => {
  if (!requireStaff(ctx)) return;
  const rid = resolveRestaurantIdForStaff(ctx, "");
  if (!rid) return;
  ctx.response.redirect(`/waiter-map/${rid}`);
});

waiterMapRouter.get("/waiter-map/:rid", async (ctx) => {
  if (!requireStaff(ctx)) return;

  const rid0 = ctx.params.rid!;
  const rid = resolveRestaurantIdForStaff(ctx, rid0);
  if (!rid) {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = "No restaurant access";
    return;
  }
  if (!(await requireRestaurantAccess(ctx, rid))) return;
  const r = await getRestaurant(rid);
  if (!r) ctx.throw(Status.NotFound, "restaurant not found");

  const sections = await listFloorSections(rid);

  const tablesFlat: Array<{ id: string; tableNumber: number }> = [];
  for (const s of sections ?? []) {
    for (const t of (s.tables ?? [])) {
      tablesFlat.push({ id: t.id, tableNumber: Number(t.tableNumber) });
    }
  }
  const statuses = await computeLiveTableStatuses(rid, tablesFlat);

  await render(ctx, "pos_waiter_map", {
    page: "pos_waiter_map",
    title: `מפת מלצרים · ${r.name}`,
    rid,
    restaurant: r,
    sections,
    statuses,
  });
});
