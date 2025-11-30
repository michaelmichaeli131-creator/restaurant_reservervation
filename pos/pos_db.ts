// src/routes/pos.ts
// POS: תפריט, מלצרים, מטבח, בר, ו-API להזמנות.

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { requireOwner, requireStaff } from "../lib/auth.ts";
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
  listBillsForRestaurant,
  getBill,
  deleteBill,
} from "../pos/pos_db.ts";
import {
  handlePosSocket,
  notifyOrderItemAdded,
  notifyOrderItemUpdated,
  notifyOrderClosed,
} from "../pos/pos_ws.ts";

export const posRouter = new Router();

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

/* ------------ Owner: bills (receipts history) ------------ */

posRouter.get("/owner/:rid/bills", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const rid = ctx.params.rid!;
  const restaurant = await getRestaurant(rid);
  if (!restaurant) ctx.throw(Status.NotFound);

  const bills = await listBillsForRestaurant(rid, 200);

  await render(ctx, "owner_bills", {
    page: "owner_bills",
    title: `חשבונות · ${restaurant.name}`,
    restaurant,
    bills,
  });
});

posRouter.post("/owner/:rid/bills/:bid/delete", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const rid = ctx.params.rid!;
  const bid = ctx.params.bid!;

  await deleteBill(rid, bid);
  ctx.response.redirect(`/owner/${rid}/bills`);
});

posRouter.get("/owner/:rid/bills/:bid/print", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const rid = ctx.params.rid!;
  const bid = ctx.params.bid!;

  const restaurant = await getRestaurant(rid);
  if (!restaurant) ctx.throw(Status.NotFound);

  const bill = await getBill(rid, bid);
  if (!bill) ctx.throw(Status.NotFound);

  const base = Deno.env.get("PAYMENT_BASE_URL")
    ?? Deno.env.get("BASE_URL")
    ?? "";
  const safeBase = base.replace(/\/+$/, "");
  const paymentUrl = safeBase
    ? `${safeBase}/pay?bill=${encodeURIComponent(bid)}`
    : `spotbook://pay?bill=${bid}`;

  await render(ctx, "owner_bill_print", {
    page: "owner_bill_print",
    title: `חשבון שולחן ${bill.table} · ${restaurant.name}`,
    restaurant,
    bill,
    paymentUrl,
  });
});

/* ------------ Generic POS table page (למסך הזמנה) ------------ */
/* נכנסים אליו מהמלצר / מהיכן שצריך: /pos/:rid/table/:tableNumber */

posRouter.get("/pos/:rid/table/:tableNumber", async (ctx) => {
  if (!requireStaff(ctx)) return;

  const user = ctx.state.user;
  const rid = ctx.params.rid!;
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

posRouter.get("/waiter/:rid", async (ctx) => {
  if (!requireStaff(ctx)) return;
  const rid = ctx.params.rid!;
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
  const rid = ctx.params.rid!;
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
  const rid = ctx.params.rid!;
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
  const rid = ctx.params.rid!;
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
  const rid = ctx.params.rid!;
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

/* ------------ API: waiter adds item ------------ */

posRouter.post("/api/pos/order-item/add", async (ctx) => {
  if (!requireStaff(ctx)) return;

  const body = await ctx.request.body.json();
  const restaurantId = String(body.restaurantId ?? "");
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
  const restaurantId = String(body.restaurantId ?? "");
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
  const body = await ctx.request.body.json();
  const restaurantId = String(body.restaurantId ?? "");
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
  const restaurantId = String(body.restaurantId ?? "");
  const table = Number(body.table ?? 0);

  if (!restaurantId || !table) {
    ctx.throw(Status.BadRequest, "missing fields");
  }

  // קודם מחשבים totals כשעדיין יש mapping של השולחן
  const totals = await computeTotalsForTable(restaurantId, table);
  const order = await closeOrderForTable(restaurantId, table);

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
