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

  // ✅ זה עדיין קיים, אבל עכשיו זה Manual override (מנצח על AUTO)
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
/*  ✅ עלויות / הוצאות חודשיות (Computed + Manual Override)                   */
/* ========================================================================== */

/**
 * GET /owner/:rid/inventory/costs?month=YYYY-MM
 * מציג:
 * - הוצאה חודשית מחושבת ממשלוחים (delivery.costTotal)
 * - Override ידני אם קיים (דורס את המחושב)
 * - טבלת חומרי גלם עם:
 *   - costPerUnitAuto (מחושב ממשלוחים)
 *   - costPerUnit (override ידני)
 *   - Spend החודש לפי משלוחים לכל חומר גלם
 */
inventoryRouter.get("/owner/:rid/inventory/costs", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const rid = ctx.params.rid!;
  const restaurant = await getRestaurant(rid);
  if (!restaurant) ctx.throw(Status.NotFound);

  const month = sanitizeMonth(ctx.request.url.searchParams.get("month"));
  const { start, end } = monthRangeUtc(month);

  const [ingredients, txList, overrideRow] = await Promise.all([
    listIngredients(rid),
    listInventoryTx(rid, 5000), // אם יהיה לך ענק – נעשה אינדקס. כרגע מספיק.
    getMonthlySpendOverride(rid, month),
  ]);

  // חישוב הוצאות ממשלוחים בחודש
  let computedTotal = 0;
  let deliveriesCount = 0;
  let deliveriesMissingCost = 0;

  const perIngredient: Record<string, { cost: number; qty: number }> = {};

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
    if (!perIngredient[tx.ingredientId]) perIngredient[tx.ingredientId] = { cost: 0, qty: 0 };
    perIngredient[tx.ingredientId].cost += tx.costTotal!;
    if (Number.isFinite(tx.deltaQty) && tx.deltaQty > 0) perIngredient[tx.ingredientId].qty += tx.deltaQty;
  }

  const overrideTotal = overrideRow?.overrideTotal;
  const effectiveTotal =
    typeof overrideTotal === "number" && Number.isFinite(overrideTotal)
      ? overrideTotal
      : computedTotal;

  // enrich ingredients rows
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
      unitAvg,        // לפי משלוחים בחודש
      costAuto: auto, // auto שנצבר
      costManual: manual,
      costEffective: effective,
      lowStock: ing.minQty > 0 && ing.currentQty <= ing.minQty,
    };
  });

  await render(ctx, "owner_inventory_costs", {
    page: "owner_inventory_costs",
    title: `עלויות חומרי גלם · ${restaurant.name}`,
    restaurant,
    month,
    computedTotal,
    effectiveTotal,
    override: overrideRow,
    deliveriesCount,
    deliveriesMissingCost,
    rows,
  });
});

/**
 * POST /owner/:rid/inventory/costs/override
 * - אם overrideTotal ריק / לא מספר -> מוחק override (חוזר לאוטומטי)
 */
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

export default inventoryRouter;
