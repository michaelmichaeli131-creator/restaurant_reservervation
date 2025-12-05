// src/routes/inventory.ts
// ----------------------------------------
// Owner inventory routes:
// - מתכונים: קישור מנות ↔ חומרי גלם
// - מלאי: רשימת חומרי גלם + עדכון / מחיקה
// - תנועות מלאי (משלוח / התאמה ידנית)
// - עלויות / הוצאה חודשית (COSTS) ✅
// ----------------------------------------

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { requireOwner } from "../lib/auth.ts";
import { getRestaurant } from "../database.ts";

import { listItems } from "../pos/pos_db.ts";

import {
  listIngredients,
  getIngredient,
  upsertIngredient,
  deleteIngredient,
  listRecipesForRestaurant,
  saveRecipeForMenuItem,
  applyInventoryTx,
  listInventoryTx,
} from "../inventory/inventory_db.ts";

export const inventoryRouter = new Router();

/* ------------ Helper: parse number safely ------------ */
function toNum(val: unknown, def = 0): number {
  const n = Number(val);
  return Number.isFinite(n) ? n : def;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function toMonthKey(d: Date) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

function parseMonthKey(s: string | null): { y: number; m0: number } | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(y) || !Number.isFinite(mm) || mm < 1 || mm > 12) return null;
  return { y, m0: mm - 1 };
}

function monthRange(monthKey: string): { start: number; end: number; days: number } {
  const parsed = parseMonthKey(monthKey);
  const now = new Date();
  const y = parsed?.y ?? now.getFullYear();
  const m0 = parsed?.m0 ?? now.getMonth();

  const startDate = new Date(y, m0, 1, 0, 0, 0, 0);
  const endDate = new Date(y, m0 + 1, 1, 0, 0, 0, 0);
  const days = Math.round((endDate.getTime() - startDate.getTime()) / (24 * 3600 * 1000));

  return { start: startDate.getTime(), end: endDate.getTime(), days };
}

/* ========================================================================== */
/*  מתכונים – קישור בין מנות בתפריט ↔ חומרי גלם                              */
/* ========================================================================== */

inventoryRouter.get("/owner/:rid/inventory/recipes", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const rid = ctx.params.rid!;
  const restaurant = await getRestaurant(rid);
  if (!restaurant) ctx.throw(Status.NotFound);

  const [menuItems, ingredients, recipes] = await Promise.all([
    listItems(rid),
    listIngredients(rid),
    listRecipesForRestaurant(rid),
  ]);

  await render(ctx, "owner_inventory_recipes", {
    page: "owner_inventory_recipes",
    title: `מתכונים וחומרי גלם · ${restaurant.name}`,
    restaurant,
    menuItems,
    ingredients,
    recipes,
  });
});

inventoryRouter.post(
  "/owner/:rid/inventory/recipes/save",
  async (ctx) => {
    if (!requireOwner(ctx)) return;
    const rid = ctx.params.rid!;
    const form = await ctx.request.body.formData();

    const menuItemId = (form.get("menuItemId")?.toString() || "").trim();
    if (!menuItemId) ctx.throw(Status.BadRequest, "missing_menu_item");

    const rawComponents = form.get("components")?.toString() || "[]";
    let comps: Array<{ ingredientId: string; qty: number }> = [];
    try {
      const parsed = JSON.parse(rawComponents);
      if (Array.isArray(parsed)) {
        comps = parsed
          .map((c) => ({
            ingredientId: String(c.ingredientId || "").trim(),
            qty: Number(c.qty ?? 0),
          }))
          .filter((c) => c.ingredientId && c.qty > 0);
      }
    } catch {
      comps = [];
    }

    const note = (form.get("note")?.toString() || "").trim();
    await saveRecipeForMenuItem(rid, menuItemId, comps, note || undefined);

    ctx.response.redirect(`/owner/${rid}/inventory/recipes`);
  },
);

/* ========================================================================== */
/*  מלאי חומרי גלם                                                             */
/* ========================================================================== */

inventoryRouter.get("/owner/:rid/inventory/stock", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const rid = ctx.params.rid!;
  const restaurant = await getRestaurant(rid);
  if (!restaurant) ctx.throw(Status.NotFound);

  const ingredients = await listIngredients(rid);

  await render(ctx, "owner_inventory_stock", {
    page: "owner_inventory_stock",
    title: `מלאי חומרי גלם · ${restaurant.name}`,
    restaurant,
    ingredients,
  });
});

inventoryRouter.post(
  "/owner/:rid/inventory/stock/ingredient",
  async (ctx) => {
    if (!requireOwner(ctx)) return;
    const rid = ctx.params.rid!;
    const form = await ctx.request.body.formData();

    const id = (form.get("id")?.toString() || "").trim() || undefined;
    const name = (form.get("name")?.toString() || "").trim();
    const unit = (form.get("unit")?.toString() || "unit").trim();
    const currentQty = toNum(form.get("currentQty"), 0);
    const minQty = toNum(form.get("minQty"), 0);
    const costPerUnit = form.get("costPerUnit") ? toNum(form.get("costPerUnit"), NaN) : NaN;
    const supplierName = (form.get("supplierName")?.toString() || "").trim();
    const notes = (form.get("notes")?.toString() || "").trim();

    if (!name) ctx.throw(Status.BadRequest, "missing_name");

    await upsertIngredient({
      id,
      restaurantId: rid,
      name,
      unit,
      currentQty,
      minQty,
      costPerUnit: Number.isFinite(costPerUnit) ? costPerUnit : undefined,
      supplierName: supplierName || undefined,
      notes: notes || undefined,
    });

    ctx.response.redirect(`/owner/${rid}/inventory/stock`);
  },
);

inventoryRouter.post(
  "/owner/:rid/inventory/stock/ingredient/:id/delete",
  async (ctx) => {
    if (!requireOwner(ctx)) return;
    const rid = ctx.params.rid!;
    const ingredientId = ctx.params.id!;
    await deleteIngredient(rid, ingredientId);
    ctx.response.redirect(`/owner/${rid}/inventory/stock`);
  },
);

inventoryRouter.post(
  "/owner/:rid/inventory/stock/tx",
  async (ctx) => {
    if (!requireOwner(ctx)) return;
    const rid = ctx.params.rid!;
    const form = await ctx.request.body.formData();

    const ingredientId = (form.get("ingredientId")?.toString() || "").trim();
    const type = (form.get("type")?.toString() || "delivery") as "delivery" | "adjustment";
    const deltaQty = toNum(form.get("deltaQty"), 0);
    const costTotal = form.get("costTotal") ? toNum(form.get("costTotal"), NaN) : NaN;
    const reason = (form.get("reason")?.toString() || "").trim();

    if (!ingredientId || !Number.isFinite(deltaQty) || deltaQty === 0) {
      ctx.throw(Status.BadRequest, "invalid_tx");
    }

    await applyInventoryTx({
      restaurantId: rid,
      ingredientId,
      type,
      deltaQty,
      costTotal: Number.isFinite(costTotal) ? costTotal : undefined,
      reason: reason || undefined,
    });

    ctx.response.redirect(`/owner/${rid}/inventory/stock`);
  },
);

/* ========================================================================== */
/*  COSTS – עלויות + הוצאה חודשית                                             */
/* ========================================================================== */

/**
 * GET /owner/:rid/inventory/costs?month=YYYY-MM
 * - טבלת עדכון costPerUnit לכל חומר גלם
 * - סיכום הוצאה חודשית מתוך InventoryTx.type=delivery עם costTotal
 */
inventoryRouter.get("/owner/:rid/inventory/costs", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const rid = ctx.params.rid!;
  const restaurant = await getRestaurant(rid);
  if (!restaurant) ctx.throw(Status.NotFound);

  const url = ctx.request.url;
  const monthKey = parseMonthKey(url.searchParams.get("month")) ? (url.searchParams.get("month") as string) : toMonthKey(new Date());
  const { start, end, days } = monthRange(monthKey);

  const [ingredients, txAll] = await Promise.all([
    listIngredients(rid),
    listInventoryTx(rid, 5000), // כרגע KV לא מאפשר range לפי createdAt; מסננים בזיכרון.
  ]);

  const ingById = new Map(ingredients.map((i) => [i.id, i]));

  // מסננים החודש + רק deliveries עם costTotal
  const tx = txAll.filter((t) =>
    t &&
    t.type === "delivery" &&
    Number.isFinite(Number(t.costTotal)) &&
    t.createdAt >= start &&
    t.createdAt < end
  );

  let totalSpend = 0;
  const byIng = new Map<string, number>();
  const daily = Array.from({ length: days }, (_, idx) => ({
    day: idx + 1,
    total: 0,
  }));

  for (const t of tx) {
    const c = Number(t.costTotal || 0);
    if (!(c > 0)) continue;
    totalSpend += c;

    byIng.set(t.ingredientId, (byIng.get(t.ingredientId) || 0) + c);

    const d = new Date(t.createdAt);
    const dayIndex = d.getDate() - 1;
    if (dayIndex >= 0 && dayIndex < daily.length) {
      daily[dayIndex].total += c;
    }
  }

  totalSpend = Math.round(totalSpend * 100) / 100;

  const topIngredients = Array.from(byIng.entries())
    .map(([ingredientId, spend]) => ({
      ingredientId,
      name: ingById.get(ingredientId)?.name || "(חומר גלם לא קיים)",
      unit: ingById.get(ingredientId)?.unit || "",
      spend: Math.round(spend * 100) / 100,
    }))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 12);

  const avgPerDelivery = tx.length ? Math.round((totalSpend / tx.length) * 100) / 100 : 0;
  const maxDaily = daily.reduce((m, x) => Math.max(m, x.total), 0);

  await render(ctx, "owner_inventory_costs", {
    page: "owner_inventory_costs",
    title: `עלויות חומרי גלם · ${restaurant.name}`,
    restaurant,
    ingredients,
    monthKey,
    summary: {
      totalSpend,
      deliveriesWithCost: tx.length,
      avgPerDelivery,
      maxDaily,
    },
    daily,          // [{day, total}]
    topIngredients, // [{ingredientId,name,spend,...}]
  });
});

/**
 * POST /owner/:rid/inventory/costs/ingredient/:id
 * עדכון מחיר ליחידה לחומר גלם קיים
 */
inventoryRouter.post("/owner/:rid/inventory/costs/ingredient/:id", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const rid = ctx.params.rid!;
  const id = ctx.params.id!;
  const form = await ctx.request.body.formData();

  const ing = await getIngredient(rid, id);
  if (!ing) ctx.throw(Status.NotFound, "ingredient_not_found");

  const costRaw = (form.get("costPerUnit")?.toString() || "").trim();
  const cost = costRaw === "" ? NaN : Number(costRaw);

  await upsertIngredient({
    id: ing.id,
    restaurantId: rid,
    name: ing.name, // חובה בגלל signature
    unit: ing.unit,
    currentQty: ing.currentQty,
    minQty: ing.minQty,
    costPerUnit: Number.isFinite(cost) ? cost : undefined,
    supplierName: ing.supplierName,
    notes: ing.notes,
  });

  const month = (form.get("month")?.toString() || "").trim();
  ctx.response.redirect(`/owner/${rid}/inventory/costs${month ? `?month=${encodeURIComponent(month)}` : ""}`);
});

export default inventoryRouter;
