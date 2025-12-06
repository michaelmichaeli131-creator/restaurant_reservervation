// src/inventory/inventory_db.ts
// ----------------------------------------
// Inventory / Ingredients module for SpotBook
// ----------------------------------------
// כולל:
// - Ingredients
// - InventoryTx
// - Recipes
// - Monthly Spend Override
// - ✅ Inventory Counts: Sessions + Lines + Finalize
// ----------------------------------------

import { kv } from "../database.ts";

/* ---------- Types ---------- */

export type InventoryTxType =
  | "delivery"
  | "adjustment"
  | "consumption"
  | "waste";

export interface Ingredient {
  id: string;
  restaurantId: string;

  name: string;
  unit: string;

  currentQty: number;
  minQty: number;

  costPerUnit?: number;       // manual override
  costPerUnitAuto?: number;   // auto from deliveries
  costAutoUpdatedAt?: number;

  supplierName?: string;
  notes?: string;

  createdAt: number;
  updatedAt: number;
}

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

export interface RecipeComponent {
  ingredientId: string;
  qty: number;
}

export interface MenuRecipe {
  restaurantId: string;
  menuItemId: string;
  components: RecipeComponent[];
  note?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MonthlySpendOverride {
  restaurantId: string;
  month: string; // YYYY-MM
  overrideTotal: number;
  note?: string;
  createdAt: number;
  updatedAt: number;
}

/* ---------- Inventory Counts ---------- */

export type InventoryCountStatus = "draft" | "finalized" | "cancelled";
export type InventoryCountAdjustKind = "adjustment" | "waste";

export interface InventoryCountSession {
  id: string;
  restaurantId: string;
  status: InventoryCountStatus;
  note?: string;

  createdAt: number;
  updatedAt: number;

  finalizedAt?: number;
  cancelledAt?: number;

  // optional: marks snapshot creation
  snapshotCreatedAt?: number;
}

export interface InventoryCountLine {
  restaurantId: string;
  countId: string;

  ingredientId: string;

  // snapshot fields (so the count is stable)
  ingredientName: string;
  unit: string;
  expectedQty: number;
  costPerUnitSnapshot?: number;

  // editable fields
  actualQty?: number;
  adjustKind?: InventoryCountAdjustKind; // default: adjustment
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

// Count sessions
function kCountSession(rid: string, cid: string): Deno.KvKey {
  return ["inv", "count_session", rid, cid];
}
function kCountSessionPrefix(rid: string): Deno.KvKey {
  return ["inv", "count_session", rid];
}

// Count lines
function kCountLine(rid: string, cid: string, ingId: string): Deno.KvKey {
  return ["inv", "count_line", rid, cid, ingId];
}
function kCountLinePrefix(rid: string, cid: string): Deno.KvKey {
  return ["inv", "count_line", rid, cid];
}

/* ---------- Helpers ---------- */

export function getEffectiveCostPerUnit(ing: Ingredient): number | undefined {
  const manual =
    typeof ing.costPerUnit === "number" && Number.isFinite(ing.costPerUnit)
      ? ing.costPerUnit
      : undefined;
  if (typeof manual === "number") return manual;

  const auto =
    typeof ing.costPerUnitAuto === "number" && Number.isFinite(ing.costPerUnitAuto)
      ? ing.costPerUnitAuto
      : undefined;
  return auto;
}

function safeNum(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
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

    costPerUnit,
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

export async function deleteIngredient(restaurantId: string, ingredientId: string): Promise<void> {
  await kv.delete(kIngredient(restaurantId, ingredientId));
}

/* ---------- INVENTORY TX API ---------- */

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

  if (
    params.type === "delivery" &&
    typeof params.costTotal === "number" &&
    Number.isFinite(params.costTotal) &&
    params.costTotal >= 0 &&
    Number.isFinite(params.deltaQty) &&
    params.deltaQty > 0
  ) {
    const unitCost = params.costTotal / params.deltaQty;
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
  for await (const row of kv.list<InventoryTx>({ prefix: kInvTxPrefix(restaurantId) })) {
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
    .filter((c) => c.ingredientId && Number.isFinite(Number(c.qty)) && Number(c.qty) > 0)
    .map((c) => ({ ingredientId: String(c.ingredientId).trim(), qty: Number(c.qty) }));

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
        reason: `POS auto-consume: menuItem=${menuItemId}, qty=${q}`,
      });
    } catch (err) {
      console.error("[INV][consume] failed", {
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

export async function setMonthlySpendOverride(params: {
  restaurantId: string;
  month: string;
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

/* ========================================================================== */
/*  INVENTORY COUNTS: Sessions + Lines + Finalize                              */
/* ========================================================================== */

export async function createInventoryCountSession(params: {
  restaurantId: string;
  note?: string;
}): Promise<InventoryCountSession> {
  const now = Date.now();
  const id = crypto.randomUUID();

  const session: InventoryCountSession = {
    id,
    restaurantId: params.restaurantId,
    status: "draft",
    note: params.note && params.note.trim() ? params.note.trim() : undefined,
    createdAt: now,
    updatedAt: now,
  };

  await kv.set(kCountSession(params.restaurantId, id), session);
  return session;
}

export async function getInventoryCountSession(
  restaurantId: string,
  countId: string,
): Promise<InventoryCountSession | null> {
  const row = await kv.get<InventoryCountSession>(kCountSession(restaurantId, countId));
  return row.value ?? null;
}

export async function listInventoryCountSessions(
  restaurantId: string,
  limit = 100,
): Promise<InventoryCountSession[]> {
  const out: InventoryCountSession[] = [];
  for await (const row of kv.list<InventoryCountSession>({ prefix: kCountSessionPrefix(restaurantId) })) {
    if (row.value) out.push(row.value);
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return limit > 0 && out.length > limit ? out.slice(0, limit) : out;
}

export async function setInventoryCountSession(params: {
  restaurantId: string;
  countId: string;
  status?: InventoryCountStatus;
  note?: string | null;
  snapshotCreatedAt?: number | null;
  finalizedAt?: number | null;
  cancelledAt?: number | null;
}): Promise<InventoryCountSession> {
  const key = kCountSession(params.restaurantId, params.countId);
  const prev = await kv.get<InventoryCountSession>(key);
  if (!prev.value) throw new Error("count_session_not_found");

  const now = Date.now();
  const s = prev.value;

  const next: InventoryCountSession = {
    ...s,
    status: params.status ?? s.status,
    note: (params.note === null) ? undefined : (params.note ?? s.note),
    snapshotCreatedAt: (params.snapshotCreatedAt === null) ? undefined : (params.snapshotCreatedAt ?? s.snapshotCreatedAt),
    finalizedAt: (params.finalizedAt === null) ? undefined : (params.finalizedAt ?? s.finalizedAt),
    cancelledAt: (params.cancelledAt === null) ? undefined : (params.cancelledAt ?? s.cancelledAt),
    updatedAt: now,
  };

  await kv.set(key, next);
  return next;
}

/* ---------- Count Lines ---------- */

export async function listInventoryCountLines(
  restaurantId: string,
  countId: string,
): Promise<InventoryCountLine[]> {
  const out: InventoryCountLine[] = [];
  for await (const row of kv.list<InventoryCountLine>({ prefix: kCountLinePrefix(restaurantId, countId) })) {
    if (row.value) out.push(row.value);
  }
  out.sort((a, b) => a.ingredientName.localeCompare(b.ingredientName));
  return out;
}

export async function upsertInventoryCountLine(params: {
  restaurantId: string;
  countId: string;
  ingredientId: string;

  ingredientName?: string;
  unit?: string;
  expectedQty?: number;
  costPerUnitSnapshot?: number;

  actualQty?: number | null;
  adjustKind?: InventoryCountAdjustKind | null;
  note?: string | null;
}): Promise<InventoryCountLine> {
  const now = Date.now();
  const key = kCountLine(params.restaurantId, params.countId, params.ingredientId);

  const prev = await kv.get<InventoryCountLine>(key);
  const existing = prev.value ?? null;

  const actual = params.actualQty === null ? undefined : (typeof params.actualQty === "number" && Number.isFinite(params.actualQty) ? params.actualQty : existing?.actualQty);
  const adjustKind = params.adjustKind === null ? undefined : (params.adjustKind ?? existing?.adjustKind ?? "adjustment");
  const note = params.note === null ? undefined : (params.note ?? existing?.note);

  const expectedQty =
    typeof params.expectedQty === "number" && Number.isFinite(params.expectedQty)
      ? params.expectedQty
      : (existing?.expectedQty ?? 0);

  const line: InventoryCountLine = {
    restaurantId: params.restaurantId,
    countId: params.countId,
    ingredientId: params.ingredientId,

    ingredientName: (params.ingredientName ?? existing?.ingredientName ?? "").trim() || existing?.ingredientName || "Ingredient",
    unit: (params.unit ?? existing?.unit ?? "unit").trim() || "unit",
    expectedQty,

    costPerUnitSnapshot:
      typeof params.costPerUnitSnapshot === "number" && Number.isFinite(params.costPerUnitSnapshot)
        ? params.costPerUnitSnapshot
        : existing?.costPerUnitSnapshot,

    actualQty: actual,
    adjustKind,
    note: note && note.trim() ? note.trim() : undefined,

    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  await kv.set(key, line);
  return line;
}

/**
 * Ensures snapshot lines exist.
 * If none exist → creates one line per current ingredient with expectedQty=currentQty and cost snapshot.
 */
export async function ensureInventoryCountSnapshot(params: {
  restaurantId: string;
  countId: string;
  ingredients: Ingredient[];
}): Promise<InventoryCountLine[]> {
  const existing = await listInventoryCountLines(params.restaurantId, params.countId);
  if (existing.length) return existing;

  const now = Date.now();
  for (const ing of params.ingredients) {
    const costSnap = getEffectiveCostPerUnit(ing);
    await upsertInventoryCountLine({
      restaurantId: params.restaurantId,
      countId: params.countId,
      ingredientId: ing.id,
      ingredientName: ing.name,
      unit: ing.unit,
      expectedQty: Number(ing.currentQty || 0),
      costPerUnitSnapshot: typeof costSnap === "number" && Number.isFinite(costSnap) ? costSnap : undefined,
      actualQty: null,
      adjustKind: "adjustment",
      note: null,
    });
  }

  await setInventoryCountSession({
    restaurantId: params.restaurantId,
    countId: params.countId,
    snapshotCreatedAt: now,
  });

  return await listInventoryCountLines(params.restaurantId, params.countId);
}

/**
 * Finalize:
 * - applies tx for lines with actualQty set (diff=actual-expected)
 * - updates session status->finalized
 */
export async function finalizeInventoryCount(params: {
  restaurantId: string;
  countId: string;
  actor?: string;
}): Promise<void> {
  const s = await getInventoryCountSession(params.restaurantId, params.countId);
  if (!s) throw new Error("count_session_not_found");
  if (s.status !== "draft") return; // already finalized/cancelled

  const lines = await listInventoryCountLines(params.restaurantId, params.countId);
  const now = Date.now();

  for (const ln of lines) {
    const actual = safeNum(ln.actualQty);
    if (typeof actual !== "number") continue;

    const expected = Number(ln.expectedQty || 0);
    const diff = actual - expected;
    if (!Number.isFinite(diff) || diff === 0) continue;

    const kind = (ln.adjustKind || "adjustment") as InventoryCountAdjustKind;

    // if negative diff and user selected waste -> waste
    const txType: InventoryTxType =
      diff < 0 && kind === "waste" ? "waste" : "adjustment";

    const reasonBase = `Inventory count ${params.countId.slice(0, 8)}`;
    const note = ln.note ? ` • ${ln.note}` : "";
    const actor = params.actor ? ` • by ${params.actor}` : "";

    await applyInventoryTx({
      restaurantId: params.restaurantId,
      ingredientId: ln.ingredientId,
      type: txType,
      deltaQty: diff,
      reason: `${reasonBase}${note}${actor}`,
    });
  }

  await setInventoryCountSession({
    restaurantId: params.restaurantId,
    countId: params.countId,
    status: "finalized",
    finalizedAt: now,
  });
}
