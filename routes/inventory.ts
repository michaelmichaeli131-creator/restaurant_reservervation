// src/routes/inventory.ts
// ----------------------------------------
// Owner inventory routes:
// - מתכונים: קישור מנות ↔ חומרי גלם
// - מלאי: רשימת חומרי גלם + עדכון כמות ורף מינימום + תנועות
// ----------------------------------------

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { requireOwner } from "../lib/auth.ts";
import { getRestaurant } from "../database.ts";

import {
  listItems,
} from "../pos/pos_db.ts";

import {
  listIngredients,
  upsertIngredient,
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

/* ------------ GET: פירוק מנות לחומרי גלם ------------ */
/**
 * מציג לכל מנה בתפריט (MenuItem) את רשימת חומרי הגלם לפי המתכון.
 * נתיב: /owner/:rid/inventory/recipes
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

/* ------------ POST: שמירת מתכון למנה ------------ */
/**
 * נתיב: POST /owner/:rid/inventory/recipes/save
 * הטופס משתמש בשדות rows[0][ingredientId], rows[0][qty], ...
 */
inventoryRouter.post(
  "/owner/:rid/inventory/recipes/save",
  async (ctx) => {
    if (!requireOwner(ctx)) return;
    const rid = ctx.params.rid!;
    const form = await ctx.request.body.formData();

    const menuItemId = (form.get("menuItemId")?.toString() || "").trim();
    if (!menuItemId) {
      ctx.throw(Status.BadRequest, "missing_menuItemId");
    }

    const components: { ingredientId: string; qty: number }[] = [];
    // כרגע יש 3 שורות, אבל נגדיר לולאה "נדיבה" ליתר ביטחון
    for (let i = 0; i < 10; i++) {
      const ingId = (form.get(`rows[${i}][ingredientId]`)?.toString() || "").trim();
      const qty = toNum(form.get(`rows[${i}][qty]`), 0);
      if (ingId && qty > 0) {
        components.push({ ingredientId: ingId, qty });
      }
    }

    const note = (form.get("note")?.toString() || "").trim() || undefined;

    await saveRecipeForMenuItem(rid, menuItemId, components, note);

    ctx.response.redirect(`/owner/${rid}/inventory/recipes`);
  },
);

/* ------------ GET: דף מלאי חומרי גלם ------------ */
/**
 * מציג רשימת חומרי גלם, עם:
 * - כמות נוכחית
 * - רף מינימום (מעל/מתחת)
 * - צבע אדום כשחסר
 * נתיב: /owner/:rid/inventory/stock
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

/* ------------ POST: יצירה / עדכון חומר גלם ------------ */
/**
 * נתיב: POST /owner/:rid/inventory/stock/ingredient
 * יוצר / מעדכן חומר גלם. אם יש id => עדכון.
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

/* ------------ POST: תנועת מלאי (משלוח/התאמה) ------------ */
/**
 * נתיב: POST /owner/:rid/inventory/stock/tx
 * מאפשר לעדכן שהגיע משלוח או התאמה ידנית.
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
