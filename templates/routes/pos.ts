// src/routes/pos.ts
// POS: תפריט, מלצרים, מטבח, בר, ו-API להזמנות.

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { requireOwner, requireStaff } from "../lib/auth.ts";
import { requireRestaurantAccess } from "../services/authz.ts";
import { getRestaurant } from "../database.ts";
import { isTableSeated } from "../services/seating_service.ts";
import {
  listItems,
  listCategories,
  upsertItem,
  deleteItem,
  upsertCategory,
  deleteCategory,
  listOpenOrdersByRestaurant,
  listOrderItemsForTable,
  computeTotalsForTable,
  cancelOrderItem,
  closeOrderForTable,
  addOrderItem,
  getItem,
  updateOrderItemStatus,
  listBillsForRestaurant, // ✅ לסטטיסטיקות + חשבונות
  getBill,                // ✅ להצגת חשבונית
  deleteBill,             // ✅ למחיקת חשבונית
} from "../pos/pos_db.ts";
import {
  handlePosSocket,
  notifyOrderItemAdded,
  notifyOrderItemUpdated,
  notifyOrderClosed,
} from "../pos/pos_ws.ts";

export const posRouter = new Router();

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

// WS endpoint
posRouter.get("/ws/pos", handlePosSocket);

/* ------------ Owner: menu editor ------------ */

posRouter.get("/owner/:rid/menu", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const rid = ctx.params.rid!;
  const r = await getRestaurant(rid);
  if (!r) ctx.throw(Status.NotFound);

  const [cats, items] = await Promise.all([
    listCategories(rid),
    listItems(rid),
  ]);

  await render(ctx, "owner_menu", {
    page: "owner_menu",
    title: `Edit Menu · ${r.name}`,
    restaurant: r,
    cats,
    items,
  });
});

posRouter.post("/owner/:rid/menu/item", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const rid = ctx.params.rid!;
  const form = await ctx.request.body.formData();

  const name_en = (form.get("name_en")?.toString() ?? "").trim();
  const name_he = (form.get("name_he")?.toString() ?? "").trim();
  const price = Number(form.get("price")?.toString() ?? "0");
  const destination = (form.get("destination")?.toString() ??
    "kitchen") as any;
  const categoryId = (form.get("categoryId")?.toString() ?? "") || null;

  await upsertItem({
    restaurantId: rid,
    name_en,
    name_he,
    price,
    destination,
    categoryId: categoryId || null,
  });

  ctx.response.redirect(`/owner/${rid}/menu`);
});

posRouter.post("/owner/:rid/menu/item/:id/delete", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const rid = ctx.params.rid!;
  const id = ctx.params.id!;
  await deleteItem(rid, id);
  ctx.response.redirect(`/owner/${rid}/menu`);
});

posRouter.post("/owner/:rid/menu/category", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const rid = ctx.params.rid!;
  const form = await ctx.request.body.formData();
  const name_en = (form.get("name_en")?.toString() ?? "").trim();
  const name_he = (form.get("name_he")?.toString() ?? "").trim();

  await upsertCategory({ restaurantId: rid, name_en, name_he });
  ctx.response.redirect(`/owner/${rid}/menu`);
});

posRouter.post("/owner/:rid/menu/category/:id/delete", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const rid = ctx.params.rid!;
  const id = ctx.params.id!;
  await deleteCategory(rid, id);
  ctx.response.redirect(`/owner/${rid}/menu`);
});

/* ------------ Owner: bills (חשבונות אחרונים) ------------ */
/* מסך רשימת החשבוניות + הדפסה/מחיקה                           */

posRouter.get("/owner/:rid/bills", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const rid = ctx.params.rid!;

  console.log("[BILLS] GET /owner/:rid/bills", {
    rid,
    user: ctx.state.user?.id,
  });

  const restaurant = await getRestaurant(rid);
  if (!restaurant) ctx.throw(Status.NotFound, "restaurant_not_found");

  // לוקחים את החשבוניות האחרונות (0 => ללא הגבלה, אפשר לשים למשל 200)
  const bills = await listBillsForRestaurant(rid, 200);

  let totalRevenue = 0;
  for (const b of bills) {
    const t = b.totals || ({} as any);
    const billTotal = typeof t.total === "number"
      ? t.total
      : (t.subtotal || 0);
    totalRevenue += billTotal;
  }

await render(ctx, "owner/owner_bills", {
    page: "owner_bills",
    title: `חשבונות אחרונים · ${restaurant.name}`,
    restaurant,
    bills,
    summary: {
      totalRevenue,
      billsCount: bills.length,
    },
  });
});

posRouter.get("/owner/:rid/bills/:billId/print", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const rid = ctx.params.rid!;
  const billId = ctx.params.billId!;

  console.log("[BILLS] GET /owner/:rid/bills/:billId/print", {
    rid,
    billId,
  });

  const restaurant = await getRestaurant(rid);
  if (!restaurant) ctx.throw(Status.NotFound, "restaurant_not_found");

  const bill = await getBill(rid, billId);
  if (!bill) ctx.throw(Status.NotFound, "bill_not_found");

  await render(ctx, "owner_bill_print", {
    page: "owner_bill_print",
    title: `חשבונית · שולחן ${bill.table} · ${restaurant.name}`,
    restaurant,
    bill,
  });
});

posRouter.post("/owner/:rid/bills/:billId/delete", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const rid = ctx.params.rid!;
  const billId = ctx.params.billId!;

  console.log("[BILLS] POST /owner/:rid/bills/:billId/delete", {
    rid,
    billId,
  });

  await deleteBill(rid, billId);
  ctx.response.redirect(`/owner/${rid}/bills`);
});

/* ------------ Owner: stats dashboard ------------ */

posRouter.get("/owner/:rid/stats", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const rid = ctx.params.rid!;
  const restaurant = await getRestaurant(rid);
  if (!restaurant) ctx.throw(Status.NotFound);

  // לוקחים את כל החשבוניות למסעדה (limit=0 => ללא הגבלה)
  const bills = await listBillsForRestaurant(rid, 0);

  // אגרגציה
  let totalRevenue = 0;
  const menuMap = new Map<
    string,
    { id: string; name: string; qty: number; revenue: number; pct?: number }
  >();
  const dailyMap = new Map<string, number>();
  const hourly: { count: number; revenue: number }[] = Array.from(
    { length: 24 },
    () => ({ count: 0, revenue: 0 }),
  );
  const weekday: { count: number; revenue: number }[] = Array.from(
    { length: 7 },
    () => ({ count: 0, revenue: 0 }),
  );

  let minTs = Number.POSITIVE_INFINITY;
  let maxTs = 0;

  for (const bill of bills as any[]) {
    const ts = typeof bill.createdAt === "number"
      ? bill.createdAt
      : Date.now();
    if (ts < minTs) minTs = ts;
    if (ts > maxTs) maxTs = ts;

    const dt = new Date(ts);
    const dayKey = dt.toISOString().slice(0, 10); // YYYY-MM-DD
    const hour = dt.getHours();
    const wd = dt.getDay(); // 0-6

    const t = bill.totals || {};
    const billTotal = typeof t.total === "number"
      ? t.total
      : (t.subtotal || 0);

    totalRevenue += billTotal;

    dailyMap.set(dayKey, (dailyMap.get(dayKey) ?? 0) + billTotal);

    if (hourly[hour]) {
      hourly[hour].count += 1;
      hourly[hour].revenue += billTotal;
    }
    if (weekday[wd]) {
      weekday[wd].count += 1;
      weekday[wd].revenue += billTotal;
    }

    if (Array.isArray(bill.items)) {
      for (const it of bill.items) {
        if (it.status === "cancelled") continue;
        const id = String(it.menuItemId || it.id || "");
        if (!id) continue;
        const key = id;
        const prev = menuMap.get(key) ?? {
          id: key,
          name: it.name || "פריט ללא שם",
          qty: 0,
          revenue: 0,
        };
        const q = Number(it.quantity ?? 0);
        const up = Number(it.unitPrice ?? 0);
        prev.qty += q;
        prev.revenue += q * up;
        menuMap.set(key, prev);
      }
    }
  }

  const billsCount = bills.length;
  const menuTopArr = Array.from(menuMap.values());
  menuTopArr.sort((a, b) => b.qty - a.qty);
  const totalQty = menuTopArr.reduce((s, it) => s + it.qty, 0);
  for (const it of menuTopArr) {
    it.pct = totalQty ? (it.qty / totalQty) * 100 : 0;
  }

  const revenuePerDay = Array.from(dailyMap.entries())
    .map(([date, revenue]) => ({ date, revenue }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const dayNames = [
    "ראשון",
    "שני",
    "שלישי",
    "רביעי",
    "חמישי",
    "שישי",
    "שבת",
  ];
  const weekdayArr = weekday.map((v, idx) => ({
    dayIndex: idx,
    dayName: dayNames[idx],
    revenue: v.revenue,
    count: v.count,
  }));
  const strongDays = [...weekdayArr].sort((a, b) => b.revenue - a.revenue);

  // שעות חלשות ל-HAPPY HOUR: 3 השעות עם הכי מעט הכנסות בין 10:00–23:00
  const hhCandidates: { hour: number; count: number; revenue: number }[] = [];
  for (let h = 10; h <= 23; h++) {
    const v = hourly[h];
    if (!v) continue;
    hhCandidates.push({ hour: h, count: v.count, revenue: v.revenue });
  }
  hhCandidates.sort((a, b) => a.revenue - b.revenue);
  const weakHours = hhCandidates.slice(0, 3);

  const stats = {
    totals: {
      revenue: totalRevenue,
      billsCount,
      avgBill: billsCount ? totalRevenue / billsCount : 0,
      from: isFinite(minTs) ? minTs : null,
      to: maxTs || null,
    },
    menuTop: {
      totalQty,
      items: menuTopArr,
    },
    revenuePerDay,
    revenuePerHour: hourly.map((v, hour) => ({
      hour,
      revenue: v.revenue,
      count: v.count,
    })),
    weekday: weekdayArr,
    strongDays,
    weakHours,
  };

  await render(ctx, "owner_stats", {
    page: "owner_stats",
    title: `סטטיסטיקות · ${restaurant.name}`,
    restaurant,
    stats,
  });
});

/* ------------ Generic POS table page (למסך הזמנה) ------------ */
/* נכנסים אליו מהמלצר / מהיכן שצריך: /pos/:rid/table/:tableNumber */

posRouter.get("/pos/:rid/table/:tableNumber", async (ctx) => {
  if (!requireStaff(ctx)) return;

  const user = ctx.state.user;
  const rid0 = ctx.params.rid!;
  const rid = resolveRestaurantIdForStaff(ctx, rid0);
  if (!rid) return;
  if (!(await requireRestaurantAccess(ctx, rid))) return;
  const tableParam = ctx.params.tableNumber;
  const tableNumber = Number(tableParam);

  console.log("[POS] GET /pos/:rid/table/:tableNumber", {
    rid,
    tableParam,
    tableNumber,
    userId: user?.id,
    role: user?.role,
  });

  if (!Number.isFinite(tableNumber) || tableNumber <= 0) {
    ctx.throw(Status.BadRequest, "invalid table number");
  }

  const restaurant = await getRestaurant(rid);
  if (!restaurant) {
    ctx.throw(Status.NotFound, "restaurant not found");
  }

  const items = await listOrderItemsForTable(rid, tableNumber);
  const totals = await computeTotalsForTable(rid, tableNumber);

  await render(ctx, "pos_waiter", {
    page: "pos_waiter",
    title: `Waiter · Table ${tableNumber} · ${restaurant.name}`,
    rid,
    table: tableNumber,
    restaurant,
    orderItems: items,
    totals,
    user,
  });
});

/* ------------ Waiter lobby ------------ */

// Convenience routes for staff: restaurantId is inferred from the locked staff membership.
// These routes redirect to the canonical URLs that include :rid, so existing templates keep working.
posRouter.get("/waiter", async (ctx) => {
  if (!requireStaff(ctx)) return;
  const rid = resolveRestaurantIdForStaff(ctx, "");
  if (!rid) return;
  ctx.response.redirect(`/waiter/${rid}`);
});

posRouter.get("/waiter-map", async (ctx) => {
  if (!requireStaff(ctx)) return;
  const rid = resolveRestaurantIdForStaff(ctx, "");
  if (!rid) return;
  ctx.response.redirect(`/waiter-map/${rid}`);
});

posRouter.get("/kitchen", async (ctx) => {
  if (!requireStaff(ctx)) return;
  const rid = resolveRestaurantIdForStaff(ctx, "");
  if (!rid) return;
  ctx.response.redirect(`/kitchen/${rid}`);
});

posRouter.get("/bar", async (ctx) => {
  if (!requireStaff(ctx)) return;
  const rid = resolveRestaurantIdForStaff(ctx, "");
  if (!rid) return;
  ctx.response.redirect(`/bar/${rid}`);
});

posRouter.get("/pos/table/:tableNumber", async (ctx) => {
  if (!requireStaff(ctx)) return;
  const rid = resolveRestaurantIdForStaff(ctx, "");
  if (!rid) return;
  const tn = ctx.params.tableNumber!;
  ctx.response.redirect(`/pos/${rid}/table/${tn}`);
});




posRouter.get("/waiter/:rid", async (ctx) => {
  if (!requireStaff(ctx)) return;
  const rid0 = ctx.params.rid!;
  const rid = resolveRestaurantIdForStaff(ctx, rid0);
  if (!rid) return;
  if (!(await requireRestaurantAccess(ctx, rid))) return;

  const r = await getRestaurant(rid);
  if (!r) ctx.throw(Status.NotFound);

  const open = await listOpenOrdersByRestaurant(rid);

  const enriched: any[] = [];
  for (const row of open) {
    const totals = await computeTotalsForTable(rid, row.table);
    enriched.push({
      table: row.table,
      order: row.order,
      itemsCount: totals.itemsCount,
      subtotal: totals.subtotal,
      // קישור ישיר למסך ההזמנה לשולחן הזה
      posUrl: `/pos/${rid}/table/${row.table}`,
    });
  }

  await render(ctx, "pos_waiter_lobby", {
    page: "pos_waiter_lobby",
    title: `מסך מלצרים · ${r.name}`,
    restaurant: r,
    rid,
    openTables: enriched,
  });
});


/* ------------ Waiter table page (נתיב ישן /waiter/:rid/:table) ------------ */

posRouter.get("/waiter/:rid/:table", async (ctx) => {
  if (!requireStaff(ctx)) return;
  const rid0 = ctx.params.rid!;
  const rid = resolveRestaurantIdForStaff(ctx, rid0);
  if (!rid) return;
  if (!(await requireRestaurantAccess(ctx, rid))) return;

  const table = Number(ctx.params.table!);
  const r = await getRestaurant(rid);
  if (!r) ctx.throw(Status.NotFound);

  const items = await listOrderItemsForTable(rid, table);
  const totals = await computeTotalsForTable(rid, table);

  await render(ctx, "pos_waiter", {
    page: "pos_waiter",
    title: `Waiter · Table ${table} · ${r.name}`,
    rid,
    table,
    restaurant: r,
    orderItems: items,
    totals,
  });
});


/* ------------ Waiter map (click table to open) ------------ */

posRouter.get("/waiter-map/:rid", async (ctx) => {
  if (!requireStaff(ctx)) return;
  const rid0 = ctx.params.rid!;
  const rid = resolveRestaurantIdForStaff(ctx, rid0);
  if (!rid) return;
  if (!(await requireRestaurantAccess(ctx, rid))) return;

  const r = await getRestaurant(rid);
  if (!r) ctx.throw(Status.NotFound);
  await render(ctx, "pos_waiter_map", {
    page: "pos_waiter_map",
    title: `מפת מסעדה · ${r.name}`,
    rid,
    restaurant: r,
  });
});


/* ------------ Kitchen & Bar dashboards ------------ */

posRouter.get("/kitchen/:rid", async (ctx) => {
  if (!requireStaff(ctx)) return;
  const rid0 = ctx.params.rid!;
  const rid = resolveRestaurantIdForStaff(ctx, rid0);
  if (!rid) return;
  if (!(await requireRestaurantAccess(ctx, rid))) return;

  const r = await getRestaurant(rid);
  if (!r) ctx.throw(Status.NotFound);

  await render(ctx, "pos_kitchen", {
    page: "pos_kitchen",
    title: `Kitchen · ${r.name}`,
    rid,
    restaurant: r,
  });
});


posRouter.get("/bar/:rid", async (ctx) => {
  if (!requireStaff(ctx)) return;
  const rid0 = ctx.params.rid!;
  const rid = resolveRestaurantIdForStaff(ctx, rid0);
  if (!rid) return;
  if (!(await requireRestaurantAccess(ctx, rid))) return;
  const r = await getRestaurant(rid);
  if (!r) ctx.throw(Status.NotFound);

  await render(ctx, "pos_bar", {
    page: "pos_bar",
    title: `Bar · ${r.name}`,
    rid,
    restaurant: r,
  });
});

/* ------------ Public menu API ------------ */

posRouter.get("/api/pos/menu/:rid", async (ctx) => {
  const rid = ctx.params.rid!;
  const items = await listItems(rid);
  ctx.response.headers.set(
    "Content-Type",
    "application/json; charset=utf-8",
  );
  ctx.response.body = JSON.stringify(items);
});

// Staff convenience: menu API without :rid (restaurant inferred from locked staff membership)
posRouter.get("/api/pos/menu", async (ctx) => {
  if (!requireStaff(ctx)) return;
  const rid = resolveRestaurantIdForStaff(ctx, "");
  if (!rid) return;
  if (!(await requireRestaurantAccess(ctx, rid))) return;

  const items = await listItems(rid);
  ctx.response.headers.set(
    "Content-Type",
    "application/json; charset=utf-8",
  );
  ctx.response.body = JSON.stringify(items);
});



/* ------------ API: waiter adds item ------------ */

posRouter.post("/api/pos/order-item/add", async (ctx) => {
  if (!requireStaff(ctx)) return;

  const body = await ctx.request.body.json();
  const restaurantId0 = String(body.restaurantId ?? "");
  const restaurantId = resolveRestaurantIdForStaff(ctx, restaurantId0);
  if (!restaurantId) return;
  if (!(await requireRestaurantAccess(ctx, restaurantId))) return;
  const table = Number(body.table ?? 0);
  const menuItemId = String(body.menuItemId ?? "");
  const quantity = Number(body.quantity ?? 1);

  if (!restaurantId || !table || !menuItemId) {
    ctx.throw(Status.BadRequest, "missing fields");
  }

  // Waiters can add only when table is seated by host
  if (!(await isTableSeated(restaurantId, table))) {
    ctx.throw(Status.Forbidden, "table_not_seated");
  }

  const menuItem = await getItem(restaurantId, menuItemId);
  if (!menuItem) ctx.throw(Status.NotFound, "menuItem not found");

  const { order, orderItem } = await addOrderItem({
    restaurantId,
    table,
    menuItem,
    quantity,
  });
  const totals = await computeTotalsForTable(restaurantId, table);

  notifyOrderItemAdded(orderItem);

  ctx.response.headers.set(
    "Content-Type",
    "application/json; charset=utf-8",
  );
  ctx.response.body = JSON.stringify({
    ok: true,
    order,
    item: orderItem,
    totals,
  });
});

/* ------------ API: cancel item (waiter) ------------ */

posRouter.post("/api/pos/order-item/cancel", async (ctx) => {
  if (!requireStaff(ctx)) return;
  const body = await ctx.request.body.json();
  const restaurantId0 = String(body.restaurantId ?? "");
  const restaurantId = resolveRestaurantIdForStaff(ctx, restaurantId0);
  if (!restaurantId) return;
  if (!(await requireRestaurantAccess(ctx, restaurantId))) return;
  const orderId = String(body.orderId ?? "");
  const orderItemId = String(body.orderItemId ?? "");
  const table = Number(body.table ?? 0);

  if (!restaurantId || !orderId || !orderItemId || !table) {
    ctx.throw(Status.BadRequest, "missing fields");
  }

  const updated = await cancelOrderItem(orderId, orderItemId);
  const totals = await computeTotalsForTable(restaurantId, table);

  if (updated) {
    notifyOrderItemUpdated(updated);
  }

  ctx.response.headers.set(
    "Content-Type",
    "application/json; charset=utf-8",
  );
  ctx.response.body = JSON.stringify({
    ok: !!updated,
    item: updated,
    totals,
  });
});

/* ------------ API: mark item served (waiter) ------------ */

posRouter.post("/api/pos/order-item/serve", async (ctx) => {
  if (!requireStaff(ctx)) return;

  const body = await ctx.request.body.json();
  const restaurantId0 = String(body.restaurantId ?? "");
  const restaurantId = resolveRestaurantIdForStaff(ctx, restaurantId0);
  if (!restaurantId) return;
  if (!(await requireRestaurantAccess(ctx, restaurantId))) return;
  const orderId = String(body.orderId ?? "");
  const orderItemId = String(body.orderItemId ?? "");
  const table = Number(body.table ?? 0);

  if (!restaurantId || !orderId || !orderItemId || !table) {
    ctx.throw(Status.BadRequest, "missing fields");
  }

  const updated = await updateOrderItemStatus(
    orderItemId,
    orderId,
    "served",
  );
  const totals = await computeTotalsForTable(restaurantId, table);

  if (updated) {
    notifyOrderItemUpdated(updated);
  }

  ctx.response.headers.set(
    "Content-Type",
    "application/json; charset=utf-8",
  );
  ctx.response.body = JSON.stringify({
    ok: !!updated,
    item: updated,
    totals,
  });
});

/* ------------ API: close order ------------ */

posRouter.post("/api/pos/order/close", async (ctx) => {
  if (!requireStaff(ctx)) return;
  const body = await ctx.request.body.json();
  const restaurantId0 = String(body.restaurantId ?? "");
  const restaurantId = resolveRestaurantIdForStaff(ctx, restaurantId0);
  if (!restaurantId) return;
  if (!(await requireRestaurantAccess(ctx, restaurantId))) return;
  const table = Number(body.table ?? 0);

  if (!restaurantId || !table) {
    ctx.throw(Status.BadRequest, "missing fields");
  }

  const order = await closeOrderForTable(restaurantId, table);
  const totals = await computeTotalsForTable(restaurantId, table);

  if (order) {
    notifyOrderClosed(restaurantId, table);
  }

  ctx.response.headers.set(
    "Content-Type",
    "application/json; charset=utf-8",
  );
  ctx.response.body = JSON.stringify({
    ok: !!order,
    order,
    totals,
  });
});

export default posRouter;
