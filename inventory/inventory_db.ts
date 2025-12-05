// src/inventory/inventory_db.ts
// ----------------------------------------
// Inventory / Ingredients module for SpotBook
// ----------------------------------------
// כולל:
// - חומרי גלם (Ingredients) עם כמות נוכחית, רף מינימום, עלות, ספק
// - תנועות מלאי (InventoryTx) – לוג של משלוחים / התאמות / צריכה / בזבוז
// - מתכונים: קישור בין מנות בתפריט ↔ חומרי גלם
// - פונקציית consumeIngredientsForMenuItem שנקראת מה-POS
// - ✅ הוצאות חודשיות מחושבות אוטומטית ממשלוחים + Override ידני מפורש
// - ✅ עלות ליחידה AUTO לפי משלוחים (costPerUnitAuto) + Override ידני (costPerUnit)
// ----------------------------------------

import { kv } from "../database.ts";

/* ---------- Types ---------- */

// סוגי תנועות מלאי
export type InventoryTxType =
  | "delivery"     // משלוח נכנס
  | "adjustment"   // התאמת מלאי ידנית
  | "consumption"  // צריכה (הזמנות מלקוחות)
  | "waste";       // בזבוז / השלכה

// חומר גלם יחיד
export interface Ingredient {
  id: string;
  restaurantId: string;

  name: string;
  unit: string; // "kg", "g", "ml", "unit"

  currentQty: number;
  minQty: number;

  /**
   * ✅ Manual override לעלות ליחידה (זה מה שהיה אצלך קודם)
   * אם מוגדר – הוא מנצח את החישוב האוטומטי.
   */
  costPerUnit?: number;

  /**
   * ✅ AUTO: מחושב מהמשלוחים האחרונים (delivery עם costTotal + deltaQty)
   */
  costPerUnitAuto?: number;

  /**
   * פנימי: חותמת זמן של משלוח אחרון ששימש לחישוב auto (לא חובה, אבל שימושי)
   */
  costAutoUpdatedAt?: number;

  supplierName?: string;
  notes?: string;

  createdAt: number;
  updatedAt: number;
}

// תנועת מלאי
export interface InventoryTx {
  id: string;
  restaurantId: string;
  ingredientId: string;
  type: InventoryTxType;

  deltaQty: number;
  newQty: number;

  costTotal?: number;
  reason?: string;

  createdAt: number;
}

// רכיב מתכון יחיד: מנה ← חומר גלם
export interface RecipeComponent {
  ingredientId: string;
  qty: number;
}

// מתכון למנה אחת
export interface MenuRecipe {
  restaurantId: string;
  menuItemId: string;
  components: RecipeComponent[];
  note?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * ✅ Override ידני להוצאה חודשית.
 * אם קיים – דורס את החישוב האוטומטי מהמשלוחים.
 */
export interface MonthlySpendOverride {
  restaurantId: string;
  month: string; // YYYY-MM
  overrideTotal: number;
  note?: string;
  createdAt: number;
  updatedAt: number;
}

/* ---------- KEYS ---------- */

// Ingredients
function kIngredient(rid: string, id: string): Deno.KvKey {
  return ["inv", "ingredient", rid, id];
}
function kIngredientPrefix(rid: string): Deno.KvKey {
  return ["inv", "ingredient", rid];
}

// Inventory TX
function kInvTx(rid: string, txId: string): Deno.KvKey {
  return ["inv", "tx", rid, txId];
}
function kInvTxPrefix(rid: string): Deno.KvKey {
  return ["inv", "tx", rid];
}

// Recipes
function kRecipe(rid: string, menuItemId: string): Deno.KvKey {
  return ["inv", "recipe", rid, menuItemId];
}
function kRecipePrefix(rid: string): Deno.KvKey {
  return ["inv", "recipe", rid];
}

// Monthly spend override
function kMonthlyOverride(rid: string, month: string): Deno.KvKey {
  return ["inv", "spend_override", rid, month];
}

/* ---------- Helpers ---------- */

export function getEffectiveCostPerUnit(ing: Ingredient): number | undefined {
  const manual = typeof ing.costPerUnit === "number" && Number.isFinite(ing.costPerUnit)
    ? ing.costPerUnit
    : undefined;
  if (typeof manual === "number") return manual;

  const auto = typeof ing.costPerUnitAuto === "number" && Number.isFinite(ing.costPerUnitAuto)
    ? ing.costPerUnitAuto
    : undefined;
  return auto;
}

/* ---------- INGREDIENTS API ---------- */

export async function listIngredients(restaurantId: string): Promise<Ingredient[]> {
  const out: Ingredient[] = [];
  for await (const row of kv.list<Ingredient>({ prefix: kIngredientPrefix(restaurantId) })) {
    if (row.value) out.push(row.value);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function getIngredient(
  restaurantId: string,
  ingredientId: string,
): Promise<Ingredient | null> {
  const row = await kv.get<Ingredient>(kIngredient(restaurantId, ingredientId));
  return row.value ?? null;
}

/**
 * יצירה / עדכון של חומר גלם.
 * - costPerUnit = Manual override (אופציונלי)
 * - costPerUnitAuto נשמר ומתעדכן אוטומטית רק ע"י משלוחים
 */
export async function upsertIngredient(
  data: Partial<Ingredient> & { restaurantId: string; name: string },
): Promise<Ingredient> {
  const now = Date.now();
  const id = data.id ?? crypto.randomUUID();

  const existingRow = await kv.get<Ingredient>(kIngredient(data.restaurantId, id));
  const existing = existingRow.value ?? null;

  const costPerUnit =
    typeof data.costPerUnit === "number" && Number.isFinite(data.costPerUnit)
      ? data.costPerUnit
      : existing?.costPerUnit;

  const item: Ingredient = {
    id,
    restaurantId: data.restaurantId,
    name: data.name.trim(),
    unit: data.unit?.trim() || existing?.unit || "unit",
    currentQty: typeof data.currentQty === "number"
      ? data.currentQty
      : (existing?.currentQty ?? 0),
    minQty: typeof data.minQty === "number"
      ? data.minQty
      : (existing?.minQty ?? 0),

    // Manual override
    costPerUnit,

    // Auto cost stays unless overridden by delivery logic
    costPerUnitAuto: existing?.costPerUnitAuto,
    costAutoUpdatedAt: existing?.costAutoUpdatedAt,

    supplierName: data.supplierName?.trim() ?? existing?.supplierName,
    notes: data.notes?.trim() ?? existing?.notes,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  await kv.set(kIngredient(data.restaurantId, id), item);
  return item;
}

/** מחיקת חומר גלם */
export async function deleteIngredient(restaurantId: string, ingredientId: string): Promise<void> {
  await kv.delete(kIngredient(restaurantId, ingredientId));
}

/* ---------- INVENTORY TX API ---------- */

/**
 * התאמת מלאי (משלוח/צריכה/בזבוז/התאמה).
 * ✅ אם זו קבלת משלוח (delivery) ויש costTotal + deltaQty>0:
 *    מעדכן costPerUnitAuto לפי עלות ממוצעת למשלוח האחרון (סמוטינג עדין).
 */
export async function applyInventoryTx(params: {
  restaurantId: string;
  ingredientId: string;
  type: InventoryTxType;
  deltaQty: number;
  costTotal?: number;
  reason?: string;
}): Promise<{ ingredient: Ingredient; tx: InventoryTx }> {
  const ingKey = kIngredient(params.restaurantId, params.ingredientId);
  const row = await kv.get<Ingredient>(ingKey);
  if (!row.value) throw new Error("ingredient_not_found");

  const ing = row.value;
  const now = Date.now();

  const newQty = (ing.currentQty ?? 0) + params.deltaQty;

  let nextCostPerUnitAuto = ing.costPerUnitAuto;
  let nextCostAutoUpdatedAt = ing.costAutoUpdatedAt;

  // ✅ auto cost update from deliveries
  if (
    params.type === "delivery" &&
    typeof params.costTotal === "number" &&
    Number.isFinite(params.costTotal) &&
    params.costTotal >= 0 &&
    Number.isFinite(params.deltaQty) &&
    params.deltaQty > 0
  ) {
    const unitCost = params.costTotal / params.deltaQty;

    // smoothing: 70% previous, 30% new delivery cost
    if (typeof nextCostPerUnitAuto === "number" && Number.isFinite(nextCostPerUnitAuto)) {
      nextCostPerUnitAuto = (nextCostPerUnitAuto * 0.7) + (unitCost * 0.3);
    } else {
      nextCostPerUnitAuto = unitCost;
    }
    nextCostAutoUpdatedAt = now;
  }

  const updated: Ingredient = {
    ...ing,
    currentQty: newQty,
    costPerUnitAuto: nextCostPerUnitAuto,
    costAutoUpdatedAt: nextCostAutoUpdatedAt,
    updatedAt: now,
  };

  const tx: InventoryTx = {
    id: crypto.randomUUID(),
    restaurantId: params.restaurantId,
    ingredientId: params.ingredientId,
    type: params.type,
    deltaQty: params.deltaQty,
    newQty,
    costTotal: params.costTotal,
    reason: params.reason,
    createdAt: now,
  };

  const atomic = kv.atomic()
    .set(ingKey, updated)
    .set(kInvTx(params.restaurantId, tx.id), tx);

  const res = await atomic.commit();
  if (!res.ok) throw new Error("inventory_tx_failed");

  return { ingredient: updated, tx };
}

export async function listInventoryTx(
  restaurantId: string,
  limit = 200,
): Promise<InventoryTx[]> {
  const out: InventoryTx[] = [];
  for await (
    const row of kv.list<InventoryTx>({ prefix: kInvTxPrefix(restaurantId) })
  ) {
    if (row.value) out.push(row.value);
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return limit > 0 && out.length > limit ? out.slice(0, limit) : out;
}

/* ---------- RECIPES API ---------- */

export async function saveRecipeForMenuItem(
  restaurantId: string,
  menuItemId: string,
  components: RecipeComponent[],
  note?: string,
): Promise<MenuRecipe> {
  const now = Date.now();
  const clean = components
    .filter((c) =>
      c.ingredientId &&
      Number.isFinite(Number(c.qty)) &&
      Number(c.qty) > 0
    )
    .map((c) => ({
      ingredientId: String(c.ingredientId).trim(),
      qty: Number(c.qty),
    }));

  const recipe: MenuRecipe = {
    restaurantId,
    menuItemId,
    components: clean,
    note: note && note.trim() ? note.trim() : undefined,
    createdAt: now,
    updatedAt: now,
  };

  await kv.set(kRecipe(restaurantId, menuItemId), recipe);
  return recipe;
}

export async function getRecipeForMenuItem(
  restaurantId: string,
  menuItemId: string,
): Promise<MenuRecipe | null> {
  const row = await kv.get<MenuRecipe>(kRecipe(restaurantId, menuItemId));
  return row.value ?? null;
}

export async function listRecipesForRestaurant(
  restaurantId: string,
): Promise<MenuRecipe[]> {
  const out: MenuRecipe[] = [];
  for await (const row of kv.list<MenuRecipe>({ prefix: kRecipePrefix(restaurantId) })) {
    if (row.value) out.push(row.value);
  }
  out.sort((a, b) => a.menuItemId.localeCompare(b.menuItemId));
  return out;
}

/* ---------- AUTO-CONSUMPTION FROM POS ---------- */

export async function consumeIngredientsForMenuItem(params: {
  restaurantId: string;
  menuItemId: string;
  quantity: number;
}): Promise<void> {
  const { restaurantId, menuItemId } = params;
  const q = Number(params.quantity || 0);
  if (!(q > 0)) return;

  const recipe = await getRecipeForMenuItem(restaurantId, menuItemId);
  if (!recipe || !Array.isArray(recipe.components) || !recipe.components.length) {
    console.warn("[INV][consume] no recipe for menuItem", { restaurantId, menuItemId });
    return;
  }

  for (const comp of recipe.components) {
    const baseQty = Number(comp.qty || 0);
    if (!(baseQty > 0)) continue;

    const delta = -q * baseQty;
    try {
      await applyInventoryTx({
        restaurantId,
        ingredientId: comp.ingredientId,
        type: "consumption",
        deltaQty: delta,
        costTotal: undefined,
        reason: `POS auto-consume: menuItem=${menuItemId}, qty=${q}`,
      });
    } catch (err) {
      console.error("[INV][consume] failed for ingredient", {
        restaurantId,
        menuItemId,
        ingredientId: comp.ingredientId,
        error: String(err),
      });
    }
  }
}

/* ---------- MONTHLY SPEND OVERRIDE API ---------- */

export async function getMonthlySpendOverride(
  restaurantId: string,
  month: string,
): Promise<MonthlySpendOverride | null> {
  const row = await kv.get<MonthlySpendOverride>(kMonthlyOverride(restaurantId, month));
  return row.value ?? null;
}

/**
 * אם overrideTotal הוא undefined/null/NaN -> מוחקים override וחוזרים לחישוב אוטומטי.
 */
export async function setMonthlySpendOverride(params: {
  restaurantId: string;
  month: string; // YYYY-MM
  overrideTotal?: number | null;
  note?: string;
}): Promise<MonthlySpendOverride | null> {
  const key = kMonthlyOverride(params.restaurantId, params.month);
  const now = Date.now();

  const val = typeof params.overrideTotal === "number" && Number.isFinite(params.overrideTotal)
    ? params.overrideTotal
    : null;

  if (val === null) {
    await kv.delete(key);
    return null;
  }

  const prev = await kv.get<MonthlySpendOverride>(key);
  const existing = prev.value ?? null;

  const obj: MonthlySpendOverride = {
    restaurantId: params.restaurantId,
    month: params.month,
    overrideTotal: val,
    note: params.note && params.note.trim() ? params.note.trim() : undefined,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  await kv.set(key, obj);
  return obj;
}
