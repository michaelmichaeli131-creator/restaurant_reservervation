// routes/pos.ts
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
} from "../pos/pos_db.ts";
import { handlePosSocket } from "../pos/pos_ws.ts";

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

  await render(ctx, "pos_waiter_lobby", {
    page: "pos_waiter_lobby",
    title: `מסך מלצרים · ${r.name}`,
    restaurant: r,
    rid,
    openTables: open,
  });
});

// --- Waiter interactive page (per table) ---
posRouter.get("/waiter/:rid/:table", async (ctx) => {
  const rid = ctx.params.rid!;
  const table = Number(ctx.params.table!);
  const r = await getRestaurant(rid);
  if (!r) ctx.throw(Status.NotFound);

  await render(ctx, "pos_waiter", {
    page: "pos_waiter",
    title: `Waiter · Table ${table} · ${r.name}`,
    rid,
    table,
    restaurant: r,
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

export default posRouter;
