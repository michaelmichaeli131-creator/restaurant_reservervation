// src/inventory/inventory_db.ts
// ----------------------------------------
// Inventory / Ingredients module for SpotBook
// ----------------------------------------
// כולל:
// - חומרי גלם (Ingredients) עם כמות נוכחית, רף מינימום, עלות, ספק
// - תנועות מלאי (InventoryTx) – לוג של משלוחים / התאמות / צריכה / בזבוז
// - מתכונים: קישור בין מנות בתפריט ↔ חומרי גלם
// - פונקציית consumeIngredientsForMenuItem שנקראת מה-POS
// ----------------------------------------

import { kv } from "../database.ts";

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
  unit: string; // לדוגמה: "kg", "g", "ml", "unit"

  currentQty: number; // כמות נוכחית
  minQty: number;     // רף מינימום לפני אזהרה

  costPerUnit?: number;        // עלות ליחידה (לא חובה)
  supplierName?: string;       // שם ספק (פשוט בשלב ראשון)
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

  deltaQty: number;    // כמה הוספנו / הורדנו
  newQty: number;      // הכמות לאחר התנועה

  costTotal?: number;  // אם זו קבלת משלוח – כמה זה עלה סה"כ
  reason?: string;     // הערה חופשית

  createdAt: number;
}

// רכיב מתכון יחיד: מנה ← חומר גלם
export interface RecipeComponent {
  ingredientId: string;
  qty: number; // כמות ליחידת מנה (באותה יחידה של ingredient.unit)
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

/* ---------- KEYS ---------- */

// חומרי גלם
function kIngredient(rid: string, id: string): Deno.KvKey {
  return ["inv", "ingredient", rid, id];
}
function kIngredientPrefix(rid: string): Deno.KvKey {
  return ["inv", "ingredient", rid];
}

// תנועות מלאי
function kInvTx(rid: string, txId: string): Deno.KvKey {
  return ["inv", "tx", rid, txId];
}
function kInvTxPrefix(rid: string): Deno.KvKey {
  return ["inv", "tx", rid];
}

// מתכונים
function kRecipe(
  rid: string,
  menuItemId: string,
): Deno.KvKey {
  return ["inv", "recipe", rid, menuItemId];
}
function kRecipePrefix(rid: string): Deno.KvKey {
  return ["inv", "recipe", rid];
}

/* ---------- INGREDIENTS API ---------- */

export async function listIngredients(
  restaurantId: string,
): Promise<Ingredient[]> {
  const out: Ingredient[] = [];
  for await (
    const row of kv.list<Ingredient>({
      prefix: kIngredientPrefix(restaurantId),
    })
  ) {
    if (row.value) out.push(row.value);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function getIngredient(
  restaurantId: string,
  ingredientId: string,
): Promise<Ingredient | null> {
  const row = await kv.get<Ingredient>(
    kIngredient(restaurantId, ingredientId),
  );
  return row.value ?? null;
}

/**
 * יצירה / עדכון של חומר גלם.
 * אם אין id – ניצור חדש; אחרת נעדכן.
 */
export async function upsertIngredient(
  data: Partial<Ingredient> & {
    restaurantId: string;
    name: string;
  },
): Promise<Ingredient> {
  const now = Date.now();
  const id = data.id ?? crypto.randomUUID();

  const existingRow = await kv.get<Ingredient>(
    kIngredient(data.restaurantId, id),
  );
  const existing = existingRow.value ?? null;

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
    costPerUnit: typeof data.costPerUnit === "number"
      ? data.costPerUnit
      : existing?.costPerUnit,
    supplierName: data.supplierName?.trim() ??
      existing?.supplierName,
    notes: data.notes?.trim() ?? existing?.notes,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  await kv.set(kIngredient(data.restaurantId, id), item);
  return item;
}

/** מחיקת חומר גלם (פשוטה, כרגע לא מנקים מתכונים / תנועות ישנות) */
export async function deleteIngredient(
  restaurantId: string,
  ingredientId: string,
): Promise<void> {
  await kv.delete(kIngredient(restaurantId, ingredientId));
}

/**
 * התאמת מלאי (משלוח, צריכה, בזבוז, התאמה ידנית).
 * מעדכן את currentQty בחומר הגלם + יוצר תנועת מלאי.
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
  if (!row.value) {
    throw new Error("ingredient_not_found");
  }
  const ing = row.value;
  const now = Date.now();

  const newQty = (ing.currentQty ?? 0) + params.deltaQty;

  const updated: Ingredient = {
    ...ing,
    currentQty: newQty,
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
  if (!res.ok) {
    throw new Error("inventory_tx_failed");
  }

  return { ingredient: updated, tx };
}

/**
 * לוג תנועות מלאי לחומר גלם / למסעדה (פשוט בסיסי).
 */
export async function listInventoryTx(
  restaurantId: string,
  limit = 200,
): Promise<InventoryTx[]> {
  const out: InventoryTx[] = [];
  for await (
    const row of kv.list<InventoryTx>({
      prefix: kInvTxPrefix(restaurantId),
    })
  ) {
    if (row.value) out.push(row.value);
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return limit > 0 && out.length > limit ? out.slice(0, limit) : out;
}

/* ---------- RECIPES API ---------- */

/**
 * שמירת מתכון למנה.
 * דורס את כל הרכיבים הקיימים למנה הזו.
 */
export async function saveRecipeForMenuItem(
  restaurantId: string,
  menuItemId: string,
  components: RecipeComponent[],
  note?: string,
): Promise<MenuRecipe> {
  const now = Date.now();
  const clean = components
    .filter((c) =>
      c.ingredientId && Number.isFinite(Number(c.qty)) &&
      Number(c.qty) > 0
    )
    .map((c) => ({
      ingredientId: c.ingredientId,
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
  const row = await kv.get<MenuRecipe>(
    kRecipe(restaurantId, menuItemId),
  );
  return row.value ?? null;
}

export async function listRecipesForRestaurant(
  restaurantId: string,
): Promise<MenuRecipe[]> {
  const out: MenuRecipe[] = [];
  for await (
    const row of kv.list<MenuRecipe>({
      prefix: kRecipePrefix(restaurantId),
    })
  ) {
    if (row.value) out.push(row.value);
  }
  out.sort((a, b) => a.menuItemId.localeCompare(b.menuItemId));
  return out;
}

/* ---------- AUTO-CONSUMPTION FROM POS ---------- */

/**
 * צריכת מלאי אוטומטית עבור מנה מסוימת שהוזמנה מה-POS.
 * לא זורק שגיאה החוצה – כדי לא להפיל הזמנה בגלל מלאי.
 */
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
    console.warn("[INV][consume] no recipe for menuItem", {
      restaurantId,
      menuItemId,
    });
    return;
  }

  for (const comp of recipe.components) {
    const baseQty = Number(comp.qty || 0);
    if (!(baseQty > 0)) continue;

    const delta = -q * baseQty; // צריכה = הורדת מלאי
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
