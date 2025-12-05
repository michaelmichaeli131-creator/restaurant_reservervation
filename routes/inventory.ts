// src/routes/inventory.ts
// ----------------------------------------
// Owner inventory routes:
// - מתכונים: קישור מנות ↔ חומרי גלם
// - מלאי: רשימת חומרי גלם + עדכון / מחיקה
// - תנועות מלאי (משלוח / התאמה ידנית)
// - ✅ עלויות / הוצאות חודשיות מחושבות ממשלוחים + Override ידני
// ----------------------------------------

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { requireOwner } from "../lib/auth.ts";
import { getRestaurant } from "../database.ts";

import { listItems } from "../pos/pos_db.ts";

import {
  listIngredients,
  upsertIngredient,
  deleteIngredient,
  listRecipesForRestaurant,
  saveRecipeForMenuItem,
  applyInventoryTx,
  listInventoryTx,
  getMonthlySpendOverride,
  setMonthlySpendOverride,
  getEffectiveCostPerUnit,
  setIngredientManualCostPerUnit,
  type InventoryTx,
} from "../inventory/inventory_db.ts";

export const inventoryRouter = new Router();

/* ------------ Helper: parse number safely ------------ */
function toNum(val: unknown, def = 0): number {
  const n = Number(val);
  return Number.isFinite(n) ? n : def;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// YYYY-MM validation + default (UTC)
function sanitizeMonth(maybe: string | null | undefined): string {
  const now = new Date();
  const def = `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}`;
  const v = (maybe || "").trim();
  if (!v) return def;
  if (!/^\d{4}-\d{2}$/.test(v)) return def;
  const [yStr, moStr] = v.split("-");
  const y = Number(yStr);
  const mo = Number(moStr);
  if (!(y >= 2000 && y <= 2100 && mo >= 1 && mo <= 12)) return def;
  return `${yStr}-${moStr}`;
}

function monthRangeUtc(month: string): { start: number; end: number } {
  const [yStr, moStr] = month.split("-");
  const y = Number(yStr);
  const mo = Number(moStr); // 1..12
  const start = Date.UTC(y, mo - 1, 1, 0, 0, 0, 0);
  const end = Date.UTC(y, mo, 1, 0, 0, 0, 0);
  return { start, end };
}

function isoDayUtc(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
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

inventoryRouter.post("/owner/:rid/inventory/recipes/save", async (ctx) => {
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
});

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

inventoryRouter.post("/owner/:rid/inventory/stock/ingredient", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const rid = ctx.params.rid!;
  const form = await ctx.request.body.formData();

  const id = (form.get("id")?.toString() || "").trim() || undefined;
  const name = (form.get("name")?.toString() || "").trim();
  const unit = (form.get("unit")?.toString() || "unit").trim();
  const currentQty = toNum(form.get("currentQty"), 0);
  const minQty = toNum(form.get("minQty"), 0);

  // ✅ Manual override (אם ריק, נשאר undefined)
  const costPerUnit = form.get("costPerUnit")
    ? toNum(form.get("costPerUnit"), NaN)
    : NaN;

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
});

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

inventoryRouter.post("/owner/:rid/inventory/stock/tx", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const rid = ctx.params.rid!;
  const form = await ctx.request.body.formData();

  const ingredientId = (form.get("ingredientId")?.toString() || "").trim();
  const type = (form.get("type")?.toString() || "delivery") as
    | "delivery"
    | "adjustment";
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
});

/* ========================================================================== */
/*  ✅ עלויות / הוצאות חודשיות (Computed + Manual Override)                   */
/* ========================================================================== */

/**
 * GET /owner/:rid/inventory/costs?month=YYYY-MM
 * מחזיר פרמטרים בדיוק כמו שה-template עם הגרפים מצפה:
 * - monthKey
 * - summary {totalSpend, computedTotal, deliveriesWithCost, deliveriesMissingCost, avgPerDelivery, maxDaily}
 * - daily [{date,total}]
 * - topIngredients [{ingredientId,name,spend}]
 * - ingredients (כולל costPerUnitAuto וכו')
 * - override (אם קיים)
 */
inventoryRouter.get("/owner/:rid/inventory/costs", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const rid = ctx.params.rid!;
  const restaurant = await getRestaurant(rid);
  if (!restaurant) ctx.throw(Status.NotFound);

  const monthKey = sanitizeMonth(ctx.request.url.searchParams.get("month"));
  const { start, end } = monthRangeUtc(monthKey);

  const [ingredients, txList, overrideRow] = await Promise.all([
    listIngredients(rid),
    listInventoryTx(rid, 5000),
    getMonthlySpendOverride(rid, monthKey),
  ]);

  // monthly totals
  let computedTotal = 0;
  let deliveriesWithCost = 0;
  let deliveriesMissingCost = 0;

  // daily sparkline
  const dailyMap: Record<string, number> = {};

  // top ingredients by spend
  const spendByIngredient: Record<string, number> = {};

  for (const tx of txList as InventoryTx[]) {
    if (tx.type !== "delivery") continue;
    if (!(tx.createdAt >= start && tx.createdAt < end)) continue;

    const hasCost =
      typeof tx.costTotal === "number" && Number.isFinite(tx.costTotal);

    if (!hasCost) {
      deliveriesMissingCost++;
      continue;
    }

    deliveriesWithCost++;
    computedTotal += tx.costTotal!;

    const day = isoDayUtc(tx.createdAt);
    dailyMap[day] = (dailyMap[day] || 0) + tx.costTotal!;

    spendByIngredient[tx.ingredientId] =
      (spendByIngredient[tx.ingredientId] || 0) + tx.costTotal!;
  }

  const overrideTotal =
    overrideRow && typeof overrideRow.overrideTotal === "number" &&
      Number.isFinite(overrideRow.overrideTotal)
      ? overrideRow.overrideTotal
      : null;

  const totalSpend = overrideTotal != null ? overrideTotal : computedTotal;

  const daily = Object.keys(dailyMap)
    .sort()
    .map((date) => ({ date, total: dailyMap[date] }));

  let maxDaily = 0;
  for (const d of daily) {
    const v = Number(d.total || 0);
    if (v > maxDaily) maxDaily = v;
  }

  const avgPerDelivery = deliveriesWithCost > 0
    ? (computedTotal / deliveriesWithCost)
    : 0;

  const idToName: Record<string, string> = {};
  for (const ing of ingredients) idToName[ing.id] = ing.name;

  const topIngredients = Object.entries(spendByIngredient)
    .map(([ingredientId, spend]) => ({
      ingredientId,
      name: idToName[ingredientId] || "חומר גלם",
      spend,
    }))
    .sort((a, b) => Number(b.spend || 0) - Number(a.spend || 0))
    .slice(0, 8);

  // optional: להוסיף לשורות גם effective cost אם תרצה בעתיד
  // (כרגע template שלך משתמש רק ב-ingredients + costPerUnit)
  // אבל נשמור זה בצד:
  for (const ing of ingredients) {
    // אין שינוי לאובייקט - רק מוודא שלא נשבר
    getEffectiveCostPerUnit(ing);
  }

  const summary = {
    totalSpend,          // effective (override wins)
    computedTotal,       // for display when override exists
    deliveriesWithCost,
    deliveriesMissingCost,
    avgPerDelivery,
    maxDaily,
  };

  await render(ctx, "owner_inventory_costs", {
    page: "owner_inventory_costs",
    title: `עלויות חומרי גלם · ${restaurant.name}`,
    restaurant,
    monthKey,
    summary,
    daily,
    topIngredients,
    ingredients,
    override: overrideRow || null,
  });
});

/**
 * POST /owner/:rid/inventory/costs/override
 * אם overrideTotal ריק/לא מספר -> מוחק override וחוזר לאוטומטי
 */
inventoryRouter.post("/owner/:rid/inventory/costs/override", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const rid = ctx.params.rid!;
  const form = await ctx.request.body.formData();

  const monthKey = sanitizeMonth(form.get("month")?.toString());
  const raw = (form.get("overrideTotal")?.toString() || "").trim();
  const note = (form.get("note")?.toString() || "").trim();

  let val: number | null = null;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) val = n;
  }

  await setMonthlySpendOverride({
    restaurantId: rid,
    month: monthKey,
    overrideTotal: val,
    note: note || undefined,
  });

  ctx.response.redirect(
    `/owner/${rid}/inventory/costs?month=${encodeURIComponent(monthKey)}`,
  );
});

/**
 * POST /owner/:rid/inventory/costs/ingredient/:id
 * עדכון Manual override ל-costPerUnit:
 * - ערך מספרי => שומר override ידני
 * - ריק => מוחק override ידני וחוזר ל-AUTO (אם קיים)
 */
inventoryRouter.post(
  "/owner/:rid/inventory/costs/ingredient/:id",
  async (ctx) => {
    if (!requireOwner(ctx)) return;
    const rid = ctx.params.rid!;
    const ingredientId = ctx.params.id!;
    const form = await ctx.request.body.formData();

    const monthKey = sanitizeMonth(form.get("month")?.toString());
    const raw = (form.get("costPerUnit")?.toString() || "").trim();

    let val: number | null = null;
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0) val = n;
    }

    await setIngredientManualCostPerUnit({
      restaurantId: rid,
      ingredientId,
      costPerUnit: val, // null => clear override
    });

    ctx.response.redirect(
      `/owner/${rid}/inventory/costs?month=${encodeURIComponent(monthKey)}`,
    );
  },
);

export default inventoryRouter;
