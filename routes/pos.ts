// src/routes/pos.ts
// ראוטים ל-POS: עריכת תפריט, מסך מלצרים, מסך מטבח, API לחשבון/ביטולים/סגירה/הוספה.

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { requireOwner } from "../lib/auth.ts";
import { getRestaurant } from "../database.ts";
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
} from "../pos/pos_db.ts";
import {
  handlePosSocket,
  notifyOrderItemAdded,
  notifyOrderItemUpdated,
  notifyOrderClosed,
} from "../pos/pos_ws.ts";

export const posRouter = new Router();

// --- WebSocket endpoint ---
posRouter.get("/ws/pos", handlePosSocket);

// --- Owner menu editor ---
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

// --- Waiter lobby: choose/open tables ---
posRouter.get("/waiter/:rid", async (ctx) => {
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

// --- Waiter interactive page (per table) ---
posRouter.get("/waiter/:rid/:table", async (ctx) => {
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

// --- Kitchen dashboard ---
posRouter.get("/kitchen/:rid", async (ctx) => {
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

// --- Public menu API for embedding in restaurant page ---
posRouter.get("/api/pos/menu/:rid", async (ctx) => {
  const rid = ctx.params.rid!;
  const items = await listItems(rid);
  ctx.response.headers.set(
    "Content-Type",
    "application/json; charset=utf-8",
  );
  ctx.response.body = JSON.stringify(items);
});

// --- API: הוספת פריט להזמנה מצד המלצר ---
posRouter.post("/api/pos/order-item/add", async (ctx) => {
  const body = await ctx.request.body.json();
  const restaurantId = String(body.restaurantId ?? "");
  const table = Number(body.table ?? 0);
  const menuItemId = String(body.menuItemId ?? "");
  const quantity = Number(body.quantity ?? 1);

  if (!restaurantId || !table || !menuItemId) {
    ctx.throw(Status.BadRequest, "missing fields");
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

  // תשדורת ריל־טיים למטבח ולמלצרים אחרים
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

// --- API: ביטול פריט מההזמנה (מלצר) ---
posRouter.post("/api/pos/order-item/cancel", async (ctx) => {
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
    // תשדורת ריל־טיים
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

// --- API: סגירת שולחן / חשבון ---
posRouter.post("/api/pos/order/close", async (ctx) => {
  const body = await ctx.request.body.json();
  const restaurantId = String(body.restaurantId ?? "");
  const table = Number(body.table ?? 0);

  if (!restaurantId || !table) {
    ctx.throw(Status.BadRequest, "missing fields");
  }

  const order = await closeOrderForTable(restaurantId, table);
  const totals = await computeTotalsForTable(restaurantId, table);

  if (order) {
    // תשדורת ריל־טיים למטבח ולמלצרים
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
