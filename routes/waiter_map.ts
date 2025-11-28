// src/routes/waiter_map.ts
// מפת מלצרים: תצוגה בלבד. קליק על שולחן תפוס פותח את מסך ההזמנה הקיים.

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { requireStaff } from "../lib/auth.ts";
import { getRestaurant } from "../database.ts";
import { listOpenOrdersByRestaurant } from "../pos/pos_db.ts";
import { listFloorSections } from "../services/floor_service.ts";

export const waiterMapRouter = new Router();

waiterMapRouter.get("/waiter-map/:rid", async (ctx) => {
  if (!requireStaff(ctx)) return;

  const rid = ctx.params.rid!;
  const r = await getRestaurant(rid);
  if (!r) ctx.throw(Status.NotFound, "restaurant not found");

  const sections = await listFloorSections(rid);

  // סטטוס תפוס/פנוי
  const openOrders = await listOpenOrdersByRestaurant(rid);
  const occupiedSet = new Set<number>((openOrders ?? []).map((o: any) => Number(o.tableNumber)));

  // נעטוף statuses כדי שהתבנית תהיה זהה לזו של המארחת
  const statuses: Array<{ tableId: string; tableNumber: number; status: string }> = [];
  for (const s of sections ?? []) {
    for (const t of (s.tables ?? [])) {
      const tn = Number(t.tableNumber);
      statuses.push({
        tableId: t.id,
        tableNumber: tn,
        status: occupiedSet.has(tn) ? "occupied" : "empty",
      });
    }
  }

  await render(ctx, "pos_waiter_map", {
    page: "pos_waiter_map",
    title: `מפת מלצרים · ${r.name}`,
    rid,
    restaurant: r,
    sections,
    statuses,
  });
});
