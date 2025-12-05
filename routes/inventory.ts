// src/routes/inventory.ts
// ----------------------------------------
// Owner inventory routes:
// - מתכונים: קישור מנות ↔ חומרי גלם
// - מלאי: רשימת חומרי גלם + עדכון / מחיקה
// - תנועות מלאי (משלוח / התאמה ידנית)
// - ✅ עלויות / הוצאות חודשיות (כמו שכבר עובד אצלך)
// - ✅ (חדש) ספירות מלאי: רשימה + יצירה (עמוד ראשון)
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
  // NEW:
  listInventoryCountSessions,
  createInventoryCountSession,
  getInventoryCountSession,
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

  // Manual override (אם ריק -> לא נוגעים)
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

inventoryRouter.post("/owner/:rid/inventory/stock/ingredient/:id/delete", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const rid = ctx.params.rid!;
  const ingredientId = ctx.params.id!;
  await deleteIngredient(rid, ingredientId);
  ctx.response.redirect(`/owner/${rid}/inventory/stock`);
});

inventoryRouter.post("/owner/:rid/inventory/stock/tx", async (ctx) => {
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
});

/* ========================================================================== */
/*  ✅ עלויות / הוצאות חודשיות (בדיוק כמו שעובד אצלך)                         */
/* ========================================================================== */

inventoryRouter.get("/owner/:rid/inventory/costs", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const rid = ctx.params.rid!;
  const restaurant = await getRestaurant(rid);
  if (!restaurant) ctx.throw(Status.NotFound);

  const month = sanitizeMonth(ctx.request.url.searchParams.get("month"));
  const { start, end } = monthRangeUtc(month);

  const [ingredients, txList, overrideRow] = await Promise.all([
    listIngredients(rid),
    listInventoryTx(rid, 5000),
    getMonthlySpendOverride(rid, month),
  ]);

  let computedTotal = 0;
  let deliveriesCount = 0;
  let deliveriesMissingCost = 0;

  const perIngredient: Record<string, { cost: number; qty: number }> = {};

  // daily aggregation for charts
  const dailyMap: Record<string, number> = {};

  for (const tx of txList) {
    if (tx.type !== "delivery") continue;
    if (!(tx.createdAt >= start && tx.createdAt < end)) continue;

    deliveriesCount++;

    const hasCost = typeof tx.costTotal === "number" && Number.isFinite(tx.costTotal);
    if (!hasCost) {
      deliveriesMissingCost++;
      continue;
    }

    computedTotal += tx.costTotal!;

    // per ingredient
    if (!perIngredient[tx.ingredientId]) perIngredient[tx.ingredientId] = { cost: 0, qty: 0 };
    perIngredient[tx.ingredientId].cost += tx.costTotal!;
    if (Number.isFinite(tx.deltaQty) && tx.deltaQty > 0) perIngredient[tx.ingredientId].qty += tx.deltaQty;

    // per day
    const d = new Date(tx.createdAt);
    const key =
      `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    dailyMap[key] = (dailyMap[key] || 0) + tx.costTotal!;
  }

  const overrideTotal = overrideRow?.overrideTotal;
  const effectiveTotal =
    typeof overrideTotal === "number" && Number.isFinite(overrideTotal)
      ? overrideTotal
      : computedTotal;

  // enrich ingredient rows
  const rows = ingredients.map((ing) => {
    const p = perIngredient[ing.id] || { cost: 0, qty: 0 };
    const unitAvg = p.qty > 0 ? (p.cost / p.qty) : null;

    const manual = typeof ing.costPerUnit === "number" && Number.isFinite(ing.costPerUnit)
      ? ing.costPerUnit
      : null;

    const auto = typeof ing.costPerUnitAuto === "number" && Number.isFinite(ing.costPerUnitAuto)
      ? ing.costPerUnitAuto
      : null;

    const effective = getEffectiveCostPerUnit(ing) ?? null;

    return {
      ingredient: ing,
      spendCost: p.cost,
      spendQty: p.qty,
      unitAvg,
      costAuto: auto,
      costManual: manual,
      costEffective: effective,
      lowStock: ing.minQty > 0 && ing.currentQty <= ing.minQty,
    };
  });

  // top ingredients (by spend)
  const topIngredients = rows
    .map((r) => ({
      id: r.ingredient.id,
      name: r.ingredient.name,
      spend: r.spendCost,
    }))
    .filter((x) => Number(x.spend || 0) > 0)
    .sort((a, b) => Number(b.spend) - Number(a.spend))
    .slice(0, 10);

  // daily array sorted
  const daily = Object.keys(dailyMap)
    .sort()
    .map((k) => ({ day: k, total: dailyMap[k] }));

  const summary = {
    totalSpend: effectiveTotal,
    computedTotal,
    deliveriesWithCost: deliveriesCount - deliveriesMissingCost,
    deliveriesMissingCost,
    avgPerDelivery: (deliveriesCount - deliveriesMissingCost) > 0
      ? (computedTotal / (deliveriesCount - deliveriesMissingCost))
      : 0,
    maxDaily: daily.length ? Math.max(...daily.map((d) => Number(d.total || 0))) : 0,
  };

  await render(ctx, "owner_inventory_costs", {
    page: "owner_inventory_costs",
    title: `עלויות חומרי גלם · ${restaurant.name}`,
    restaurant,
    monthKey: month,
    summary,
    daily,
    topIngredients,
    ingredients, // לטבלה בעמוד
  });
});

inventoryRouter.post("/owner/:rid/inventory/costs/override", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const rid = ctx.params.rid!;
  const form = await ctx.request.body.formData();

  const month = sanitizeMonth(form.get("month")?.toString());
  const raw = (form.get("overrideTotal")?.toString() || "").trim();
  const note = (form.get("note")?.toString() || "").trim();

  let val: number | null = null;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) val = n;
  }

  await setMonthlySpendOverride({
    restaurantId: rid,
    month,
    overrideTotal: val,
    note: note || undefined,
  });

  ctx.response.redirect(`/owner/${rid}/inventory/costs?month=${encodeURIComponent(month)}`);
});

/* ========================================================================== */
/*  ✅ NEW: ספירות מלאי – עמוד ראשון (רשימה + יצירה)                           */
/* ========================================================================== */

/**
 * GET /owner/:rid/inventory/counts
 * רשימת ספירות + יצירה חדשה
 */
inventoryRouter.get("/owner/:rid/inventory/counts", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const rid = ctx.params.rid!;
  const restaurant = await getRestaurant(rid);
  if (!restaurant) ctx.throw(Status.NotFound);

  const sessions = await listInventoryCountSessions(rid, 200);

  const created = (ctx.request.url.searchParams.get("created") || "").trim();

  await render(ctx, "owner_inventory_counts", {
    page: "owner_inventory_counts",
    title: `ספירות מלאי · ${restaurant.name}`,
    restaurant,
    sessions,
    created,
  });
});

/**
 * POST /owner/:rid/inventory/counts/new
 * יצירת ספירה חדשה (draft)
 */
inventoryRouter.post("/owner/:rid/inventory/counts/new", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const rid = ctx.params.rid!;
  const restaurant = await getRestaurant(rid);
  if (!restaurant) ctx.throw(Status.NotFound);

  const form = await ctx.request.body.formData();
  const note = (form.get("note")?.toString() || "").trim();

  const session = await createInventoryCountSession({
    restaurantId: rid,
    note: note || undefined,
  });

  // כרגע עמוד ראשון — נחזיר לרשימה + באנר "נוצר"
  ctx.response.redirect(`/owner/${rid}/inventory/counts?created=${encodeURIComponent(session.id)}`);
});

/**
 * GET /owner/:rid/inventory/counts/:cid
 * ✅ סטאב זמני (כדי שלא יהיה 404).
 * בעמוד הבא נממש פה את טבלת הספירה עצמה.
 */
inventoryRouter.get("/owner/:rid/inventory/counts/:cid", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const rid = ctx.params.rid!;
  const cid = ctx.params.cid!;
  const restaurant = await getRestaurant(rid);
  if (!restaurant) ctx.throw(Status.NotFound);

  const session = await getInventoryCountSession(rid, cid);
  if (!session) ctx.throw(Status.NotFound);

  await render(ctx, "owner_inventory_count_stub", {
    page: "owner_inventory_count_stub",
    title: `ספירת מלאי · ${restaurant.name}`,
    restaurant,
    session,
  });
});

export default inventoryRouter;
