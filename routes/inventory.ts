// src/routes/inventory.ts
// ----------------------------------------
// Owner inventory routes:
// - מתכונים: קישור מנות ↔ חומרי גלם
// - מלאי: רשימת חומרי גלם + עדכון / מחיקה
// - תנועות מלאי (משלוח / התאמה ידנית)
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
} from "../inventory/inventory_db.ts";

export const inventoryRouter = new Router();

/* ------------ Helper: parse number safely ------------ */
function toNum(val: unknown, def = 0): number {
  const n = Number(val);
  return Number.isFinite(n) ? n : def;
}

/* ========================================================================== */
/*  מתכונים – קישור בין מנות בתפריט ↔ חומרי גלם                              */
/* ========================================================================== */

/**
 * GET  /owner/:rid/inventory/recipes
 * מציג:
 *  - רשימת מנות (menuItems)
 *  - רשימת חומרי גלם (ingredients)
 *  - רשימת מתכונים קיימים (recipes)
 */
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

/**
 * POST /owner/:rid/inventory/recipes/save
 * שומר מתכון למנה אחת:
 * - menuItemId
 * - components (JSON של [{ingredientId, qty}...])
 * - note (הערות שף)
 */
inventoryRouter.post(
  "/owner/:rid/inventory/recipes/save",
  async (ctx) => {
    if (!requireOwner(ctx)) return;
    const rid = ctx.params.rid!;
    const form = await ctx.request.body.formData();

    const menuItemId = (form.get("menuItemId")?.toString() || "").trim();
    if (!menuItemId) {
      ctx.throw(Status.BadRequest, "missing_menu_item");
    }

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
      // נמשיך עם מערך ריק
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

/**
 * GET /owner/:rid/inventory/stock
 * מציג רשימת חומרי גלם + סטטוס מלאי
 */
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

/**
 * POST /owner/:rid/inventory/stock/ingredient
 * יצירה / עדכון חומר גלם (upsert)
 */
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
    const costPerUnit = form.get("costPerUnit")
      ? toNum(form.get("costPerUnit"), NaN)
      : NaN;
    const supplierName = (form.get("supplierName")?.toString() || "")
      .trim();
    const notes = (form.get("notes")?.toString() || "").trim();

    if (!name) {
      ctx.throw(Status.BadRequest, "missing_name");
    }

    await upsertIngredient({
      id,
      restaurantId: rid,
      name,
      unit,
      currentQty,
      minQty,
      costPerUnit: Number.isFinite(costPerUnit)
        ? costPerUnit
        : undefined,
      supplierName: supplierName || undefined,
      notes: notes || undefined,
    });

    ctx.response.redirect(`/owner/${rid}/inventory/stock`);
  },
);

/**
 * POST /owner/:rid/inventory/stock/ingredient/:id/delete
 * מחיקת חומר גלם
 */
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

/**
 * POST /owner/:rid/inventory/stock/tx
 * תנועת מלאי: משלוח / התאמת מלאי ידנית
 */
inventoryRouter.post(
  "/owner/:rid/inventory/stock/tx",
  async (ctx) => {
    if (!requireOwner(ctx)) return;
    const rid = ctx.params.rid!;
    const form = await ctx.request.body.formData();

    const ingredientId = (form.get("ingredientId")?.toString() || "")
      .trim();
    const type = (form.get("type")?.toString() ||
      "delivery") as "delivery" | "adjustment";
    const deltaQty = toNum(form.get("deltaQty"), 0);
    const costTotal = form.get("costTotal")
      ? toNum(form.get("costTotal"), NaN)
      : NaN;
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

export default inventoryRouter;
