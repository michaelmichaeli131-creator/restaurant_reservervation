// src/inventory/inventory_db.ts
// ----------------------------------------
// Inventory / Ingredients module for SpotBook
// ----------------------------------------
// כולל:
// - Ingredients + InventoryTx + Recipes + auto-consumption
// - Monthly spend override + AUTO costPerUnitAuto + Manual costPerUnit
// - Inventory counts (sessions + lines + finalize)
// - ✅ Suppliers
// - ✅ Purchase Orders (PO) with expectedAt (ETA) + delivered -> creates delivery tx
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

  /** Manual override */
  costPerUnit?: number;

  /** Auto estimated from deliveries */
  costPerUnitAuto?: number;
  costAutoUpdatedAt?: number;

  /** ✅ minimal supplier link (optional) */
  preferredSupplierId?: string;

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

/* ---------- Counts ---------- */

export type InventoryCountStatus = "draft" | "finalized";

export interface InventoryCountSession {
  id: string;
  restaurantId: string;
  status: InventoryCountStatus;
  note?: string;
  createdAt: number;
  updatedAt: number;
  finalizedAt?: number;
  finalizedBy?: string;
}

export type InventoryCountAdjustKind = "adjustment" | "waste";

export interface InventoryCountLine {
  restaurantId: string;
  countId: string;
  ingredientId: string;

  ingredientNameSnapshot: string;
  unitSnapshot: string;

  expectedQty: number;
  costPerUnitSnapshot: number;

  actualQty?: number | null; // null/undefined = not filled
  adjustKind?: InventoryCountAdjustKind; // default adjustment
  note?: string | null;

  createdAt: number;
  updatedAt: number;
}

/* ---------- ✅ Suppliers ---------- */

export interface Supplier {
  id: string;
  restaurantId: string;
  name: string;
  phone?: string;
  email?: string;
  paymentTerms?: string;

  /** ✅ required for ETA calculation */
  leadTimeDays: number;

  createdAt: number;
  updatedAt: number;
}

/* ---------- ✅ Purchase Orders ---------- */

export type PurchaseOrderStatus = "draft" | "sent" | "delivered" | "cancelled";

export interface PurchaseOrderLine {
  ingredientId: string;
  ingredientName?: string;
  qty: number;
}

export interface PurchaseOrder {
  id: string;
  restaurantId: string;
  supplierId: string;
  supplierNameSnapshot: string;

  status: PurchaseOrderStatus;

  createdAt: number;
  updatedAt: number;

  expectedAt: number; // ETA
  deliveredAt?: number;

  note?: string;

  lines: PurchaseOrderLine[];
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

// Counts
function kCountSession(rid: string, cid: string): Deno.KvKey {
  return ["inv", "count", rid, cid];
}
function kCountSessionPrefix(rid: string): Deno.KvKey {
  return ["inv", "count", rid];
}
function kCountLine(rid: string, cid: string, ingredientId: string): Deno.KvKey {
  return ["inv", "count_line", rid, cid, ingredientId];
}
function kCountLinePrefix(rid: string, cid: string): Deno.KvKey {
  return ["inv", "count_line", rid, cid];
}

// ✅ Suppliers
function kSupplier(rid: string, sid: string): Deno.KvKey {
  return ["inv", "supplier", rid, sid];
}
function kSupplierPrefix(rid: string): Deno.KvKey {
  return ["inv", "supplier", rid];
}

// ✅ Purchase Orders
function kPO(rid: string, poid: string): Deno.KvKey {
  return ["inv", "po", rid, poid];
}
function kPOPrefix(rid: string): Deno.KvKey {
  return ["inv", "po", rid];
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

/* ============================= INGREDIENTS API ============================= */

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

  const preferredSupplierId =
    typeof data.preferredSupplierId === "string" && data.preferredSupplierId.trim()
      ? data.preferredSupplierId.trim()
      : existing?.preferredSupplierId;

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

    preferredSupplierId,

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

/* ============================ INVENTORY TX API ============================ */

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

  // AUTO cost update from deliveries with cost + qty
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

/* =============================== RECIPES API =============================== */

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

/* ======================= AUTO-CONSUMPTION FROM POS ======================== */

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

/* ======================= MONTHLY SPEND OVERRIDE API ======================= */

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

/* ============================== COUNTS API ============================== */

export async function listInventoryCountSessions(
  restaurantId: string,
  limit = 200,
): Promise<InventoryCountSession[]> {
  const out: InventoryCountSession[] = [];
  for await (const row of kv.list<InventoryCountSession>({ prefix: kCountSessionPrefix(restaurantId) })) {
    if (row.value) out.push(row.value);
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return limit > 0 && out.length > limit ? out.slice(0, limit) : out;
}

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

export async function listInventoryCountLines(
  restaurantId: string,
  countId: string,
): Promise<InventoryCountLine[]> {
  const out: InventoryCountLine[] = [];
  for await (const row of kv.list<InventoryCountLine>({ prefix: kCountLinePrefix(restaurantId, countId) })) {
    if (row.value) out.push(row.value);
  }
  out.sort((a, b) => a.ingredientNameSnapshot.localeCompare(b.ingredientNameSnapshot));
  return out;
}

export async function ensureInventoryCountSnapshot(params: {
  restaurantId: string;
  countId: string;
  ingredients: Ingredient[];
}): Promise<InventoryCountLine[]> {
  const { restaurantId, countId, ingredients } = params;

  const existing = await listInventoryCountLines(restaurantId, countId);
  const map: Record<string, InventoryCountLine> = {};
  for (const ln of existing) map[ln.ingredientId] = ln;

  const now = Date.now();
  const ops = kv.atomic();

  let changed = false;
  for (const ing of ingredients) {
    if (map[ing.id]) continue;

    const snapCost = getEffectiveCostPerUnit(ing) ?? 0;

    const line: InventoryCountLine = {
      restaurantId,
      countId,
      ingredientId: ing.id,
      ingredientNameSnapshot: ing.name,
      unitSnapshot: ing.unit || "unit",
      expectedQty: Number(ing.currentQty || 0),
      costPerUnitSnapshot: Number.isFinite(snapCost) ? snapCost : 0,
      actualQty: null,
      adjustKind: "adjustment",
      note: null,
      createdAt: now,
      updatedAt: now,
    };

    ops.set(kCountLine(restaurantId, countId, ing.id), line);
    changed = true;
  }

  if (changed) {
    const res = await ops.commit();
    if (!res.ok) {
      // if commit failed, just re-read
    }
  }

  return await listInventoryCountLines(restaurantId, countId);
}

export async function upsertInventoryCountLine(params: {
  restaurantId: string;
  countId: string;
  ingredientId: string;
  actualQty: number | null;
  adjustKind: InventoryCountAdjustKind;
  note: string | null;
}): Promise<InventoryCountLine | null> {
  const key = kCountLine(params.restaurantId, params.countId, params.ingredientId);
  const row = await kv.get<InventoryCountLine>(key);
  if (!row.value) return null;

  const now = Date.now();
  const updated: InventoryCountLine = {
    ...row.value,
    actualQty: params.actualQty,
    adjustKind: params.adjustKind,
    note: params.note,
    updatedAt: now,
  };

  const ok = await kv.atomic().check(row).set(key, updated).commit();
  if (!ok.ok) return null;
  return updated;
}

export async function finalizeInventoryCount(params: {
  restaurantId: string;
  countId: string;
  actor?: string;
}): Promise<void> {
  const { restaurantId, countId } = params;

  const sessKey = kCountSession(restaurantId, countId);
  const sessRow = await kv.get<InventoryCountSession>(sessKey);
  if (!sessRow.value) throw new Error("count_not_found");
  if (sessRow.value.status !== "draft") return;

  const lines = await listInventoryCountLines(restaurantId, countId);

  // apply diffs
  for (const ln of lines) {
    const exp = Number(ln.expectedQty || 0);
    const act = (typeof ln.actualQty === "number" && Number.isFinite(ln.actualQty)) ? ln.actualQty : null;
    if (act === null) continue;

    const diff = act - exp;
    if (!Number.isFinite(diff) || diff === 0) continue;

    const kind: InventoryTxType = ln.adjustKind === "waste" ? "waste" : "adjustment";
    await applyInventoryTx({
      restaurantId,
      ingredientId: ln.ingredientId,
      type: kind,
      deltaQty: diff,
      reason: `Inventory count ${countId} (${kind})`,
    });
  }

  const now = Date.now();
  const updated: InventoryCountSession = {
    ...sessRow.value,
    status: "finalized",
    finalizedAt: now,
    finalizedBy: params.actor,
    updatedAt: now,
  };

  const ok = await kv.atomic().check(sessRow).set(sessKey, updated).commit();
  if (!ok.ok) throw new Error("count_finalize_failed");
}

/* ============================== ✅ SUPPLIERS API ============================== */

export async function listSuppliers(restaurantId: string): Promise<Supplier[]> {
  const out: Supplier[] = [];
  for await (const row of kv.list<Supplier>({ prefix: kSupplierPrefix(restaurantId) })) {
    if (row.value) out.push(row.value);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function getSupplier(
  restaurantId: string,
  supplierId: string,
): Promise<Supplier | null> {
  const row = await kv.get<Supplier>(kSupplier(restaurantId, supplierId));
  return row.value ?? null;
}

export async function upsertSupplier(params: Partial<Supplier> & {
  restaurantId: string;
  name: string;
  leadTimeDays: number;
  id?: string;
}): Promise<Supplier> {
  const now = Date.now();
  const id = params.id ?? crypto.randomUUID();

  const prev = await kv.get<Supplier>(kSupplier(params.restaurantId, id));
  const existing = prev.value ?? null;

  const lead = Number(params.leadTimeDays);
  const leadTimeDays = Number.isFinite(lead) && lead >= 0 ? Math.floor(lead) : (existing?.leadTimeDays ?? 0);

  const sup: Supplier = {
    id,
    restaurantId: params.restaurantId,
    name: (params.name ?? existing?.name ?? "").trim(),
    phone: (params.phone ?? existing?.phone ?? "").trim() || undefined,
    email: (params.email ?? existing?.email ?? "").trim() || undefined,
    paymentTerms: (params.paymentTerms ?? existing?.paymentTerms ?? "").trim() || undefined,
    leadTimeDays,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  if (!sup.name) throw new Error("supplier_missing_name");

  await kv.set(kSupplier(params.restaurantId, id), sup);
  return sup;
}

export async function deleteSupplier(
  restaurantId: string,
  supplierId: string,
): Promise<void> {
  await kv.delete(kSupplier(restaurantId, supplierId));
}

/* ============================== ✅ PURCHASE ORDERS API ============================== */

export async function listPurchaseOrders(
  restaurantId: string,
  limit = 200,
): Promise<PurchaseOrder[]> {
  const out: PurchaseOrder[] = [];
  for await (const row of kv.list<PurchaseOrder>({ prefix: kPOPrefix(restaurantId) })) {
    if (row.value) out.push(row.value);
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return limit > 0 && out.length > limit ? out.slice(0, limit) : out;
}

export async function getPurchaseOrder(
  restaurantId: string,
  poId: string,
): Promise<PurchaseOrder | null> {
  const row = await kv.get<PurchaseOrder>(kPO(restaurantId, poId));
  return row.value ?? null;
}

export async function createPurchaseOrder(params: {
  restaurantId: string;
  supplier: Supplier;
  expectedAt?: number; // if omitted -> now + leadTimeDays
  note?: string;
}): Promise<PurchaseOrder> {
  const now = Date.now();
  const id = crypto.randomUUID();

  const expectedAt =
    typeof params.expectedAt === "number" && Number.isFinite(params.expectedAt)
      ? params.expectedAt
      : (now + (params.supplier.leadTimeDays * 24 * 60 * 60 * 1000));

  const po: PurchaseOrder = {
    id,
    restaurantId: params.restaurantId,
    supplierId: params.supplier.id,
    supplierNameSnapshot: params.supplier.name,
    status: "draft",
    createdAt: now,
    updatedAt: now,
    expectedAt,
    note: params.note && params.note.trim() ? params.note.trim() : undefined,
    lines: [],
  };

  await kv.set(kPO(params.restaurantId, id), po);
  return po;
}

export async function savePurchaseOrder(params: {
  restaurantId: string;
  poId: string;
  expectedAt?: number;
  note?: string;
  lines: PurchaseOrderLine[];
}): Promise<PurchaseOrder | null> {
  const key = kPO(params.restaurantId, params.poId);
  const row = await kv.get<PurchaseOrder>(key);
  if (!row.value) return null;

  const cur = row.value;
  if (cur.status === "delivered" || cur.status === "cancelled") return cur;

  const now = Date.now();

  const cleanLines = (Array.isArray(params.lines) ? params.lines : [])
    .map((l) => ({
      ingredientId: String(l.ingredientId || "").trim(),
      ingredientName: (l.ingredientName || "").trim() || undefined,
      qty: Number(l.qty || 0),
    }))
    .filter((l) => l.ingredientId && Number.isFinite(l.qty) && l.qty > 0);

  const expectedAt =
    typeof params.expectedAt === "number" && Number.isFinite(params.expectedAt)
      ? params.expectedAt
      : cur.expectedAt;

  const updated: PurchaseOrder = {
    ...cur,
    expectedAt,
    note: params.note && params.note.trim() ? params.note.trim() : undefined,
    lines: cleanLines,
    updatedAt: now,
  };

  const ok = await kv.atomic().check(row).set(key, updated).commit();
  if (!ok.ok) return null;
  return updated;
}

export async function setPurchaseOrderStatus(params: {
  restaurantId: string;
  poId: string;
  status: PurchaseOrderStatus;
}): Promise<PurchaseOrder | null> {
  const key = kPO(params.restaurantId, params.poId);
  const row = await kv.get<PurchaseOrder>(key);
  if (!row.value) return null;

  const cur = row.value;
  if (cur.status === "delivered") return cur;
  if (cur.status === "cancelled" && params.status !== "cancelled") return cur;

  const now = Date.now();
  const updated: PurchaseOrder = {
    ...cur,
    status: params.status,
    updatedAt: now,
  };

  const ok = await kv.atomic().check(row).set(key, updated).commit();
  if (!ok.ok) return null;
  return updated;
}

export async function markPurchaseOrderDelivered(params: {
  restaurantId: string;
  poId: string;
}): Promise<PurchaseOrder | null> {
  const key = kPO(params.restaurantId, params.poId);
  const row = await kv.get<PurchaseOrder>(key);
  if (!row.value) return null;

  const po = row.value;
  if (po.status === "delivered" || po.status === "cancelled") return po;

  // Validate ingredient existence first
  for (const ln of po.lines || []) {
    if (!ln.ingredientId) continue;
    const ing = await getIngredient(params.restaurantId, ln.ingredientId);
    if (!ing) {
      throw new Error(`po_missing_ingredient:${ln.ingredientId}`);
    }
  }

  // Create delivery tx per line
  for (const ln of po.lines || []) {
    const qty = Number(ln.qty || 0);
    if (!ln.ingredientId || !(qty > 0)) continue;

    await applyInventoryTx({
      restaurantId: params.restaurantId,
      ingredientId: ln.ingredientId,
      type: "delivery",
      deltaQty: qty,
      reason: `PO ${po.id} delivered (supplier=${po.supplierNameSnapshot})`,
    });
  }

  const now = Date.now();
  const updated: PurchaseOrder = {
    ...po,
    status: "delivered",
    deliveredAt: now,
    updatedAt: now,
  };

  const ok = await kv.atomic().check(row).set(key, updated).commit();
  if (!ok.ok) return null;
  return updated;
}
