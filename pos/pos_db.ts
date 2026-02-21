// src/pos/pos_db.ts
// POS על Deno KV: תפריט, הזמנות לשולחנות, פריטים, סיכומים, ביטולים, סגירה וחשבוניות.

import { kv } from "../database.ts";
import { getTableIdByNumber } from "../services/floor_service.ts";
import { consumeIngredientsForMenuItem } from "../inventory/inventory_db.ts";

export type Destination = "kitchen" | "bar";

export interface MenuCategory {
  id: string;
  restaurantId: string;
  name_he?: string;
  name_en?: string;
  name_ka?: string;
  sort?: number;
  active?: boolean;
  createdAt: number;
}

export interface MenuItem {
  id: string;
  restaurantId: string;
  categoryId?: string | null;
  name_he?: string;
  name_en?: string;
  name_ka?: string;
  desc_he?: string;
  desc_en?: string;
  desc_ka?: string;
  price: number;
  destination: Destination; // kitchen or bar
  isActive?: boolean;
  outOfStock?: boolean;
  createdAt: number;
}

export type OrderItemStatus =
  | "received"
  | "in_progress"
  | "ready"
  | "served"
  | "cancelled";

export interface Order {
  id: string;
  restaurantId: string;
  table: number;
  floorTableId?: string;      // Link to floor plan table ID
  sectionId?: string;         // Link to floor section
  status: "open" | "closed" | "cancelled";
  createdAt: number;
  closedAt?: number;
}

export interface OrderItem {
  id: string;
  orderId: string;
  restaurantId: string;
  table: number;
  menuItemId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  destination: Destination;
  status: OrderItemStatus;
  createdAt: number;
  updatedAt: number;
}

export interface OrderTotals {
  itemsCount: number; // כמה פריטים (כולל כמות)
  subtotal: number;   // סה"כ לפני טיפ/מע"מ וכו'
}

export interface BillTotals extends OrderTotals {
  taxRate?: number;
  taxAmount?: number;
  total: number;
}

export interface Bill {
  id: string;
  restaurantId: string;
  orderId: string;
  table: number;
  createdAt: number;
  items: OrderItem[];
  totals: BillTotals;
  paymentCode: string;
}

/* ---------- KEYS ---------- */

function kCategory(rid: string, id: string): Deno.KvKey {
  return ["pos", "cat", rid, id];
}
function kCategoryPrefix(rid: string): Deno.KvKey {
  return ["pos", "cat", rid];
}

function kItem(rid: string, id: string): Deno.KvKey {
  return ["pos", "item", rid, id];
}
function kItemPrefix(rid: string): Deno.KvKey {
  return ["pos", "item", rid];
}

function kOrder(rid: string, oid: string): Deno.KvKey {
  return ["pos", "order", rid, oid];
}
function kOrderPrefix(rid: string): Deno.KvKey {
  return ["pos", "order", rid];
}

function kOrderByTable(rid: string, table: number): Deno.KvKey {
  return ["pos", "order_by_table", rid, table];
}
function kOrderByTablePrefix(rid: string): Deno.KvKey {
  return ["pos", "order_by_table", rid];
}

function kOrderItem(oid: string, iid: string): Deno.KvKey {
  return ["pos", "order_item", oid, iid];
}
function kOrderItemPrefix(oid: string): Deno.KvKey {
  return ["pos", "order_item", oid];
}

/**
 * KEY להושבה לפי שולחן – חייב להיות זהה למה שמשמש ב-seating_service.ts
 */
function kSeat(restaurantId: string, table: number | string): Deno.KvKey {
  return ["seat", "by_table", restaurantId, Number(table)];
}

/* ---------- Bills ---------- */

function kBill(rid: string, bid: string): Deno.KvKey {
  return ["pos", "bill", rid, bid];
}

function kBillByRestaurantPrefix(rid: string): Deno.KvKey {
  return ["pos", "bill_by_restaurant", rid];
}

function kBillByRestaurant(
  rid: string,
  createdAt: number,
  bid: string,
): Deno.KvKey {
  return ["pos", "bill_by_restaurant", rid, createdAt, bid];
}

/* ---------- Categories ---------- */

export async function listCategories(
  restaurantId: string,
): Promise<MenuCategory[]> {
  const out: MenuCategory[] = [];
  for await (
    const row of kv.list<MenuCategory>({
      prefix: kCategoryPrefix(restaurantId),
    })
  ) {
    if (row.value) out.push(row.value);
  }
  out.sort(
    (a, b) =>
      (a.sort ?? 0) - (b.sort ?? 0) || a.createdAt - b.createdAt,
  );
  return out;
}

export async function upsertCategory(
  cat: Partial<MenuCategory> & {
    restaurantId: string;
    name_en?: string;
    name_he?: string;
    name_ka?: string;
    id?: string;
  },
): Promise<MenuCategory> {
  const id = cat.id ?? crypto.randomUUID();
  const item: MenuCategory = {
    id,
    restaurantId: cat.restaurantId,
    name_en: (cat.name_en ?? "").trim(),
    name_he: (cat.name_he ?? "").trim(),
    name_ka: (cat.name_ka ?? "").trim(),
    sort: cat.sort ?? 0,
    active: cat.active ?? true,
    createdAt: Date.now(),
  };
  await kv.set(kCategory(cat.restaurantId, id), item);
  return item;
}

export async function deleteCategory(
  restaurantId: string,
  id: string,
): Promise<void> {
  await kv.delete(kCategory(restaurantId, id));
}

/* ---------- Items ---------- */

export async function listItems(restaurantId: string): Promise<MenuItem[]> {
  const out: MenuItem[] = [];
  for await (
    const row of kv.list<MenuItem>({
      prefix: kItemPrefix(restaurantId),
    })
  ) {
    if (row.value) out.push(row.value);
  }
  out.sort((a, b) => a.createdAt - b.createdAt);
  return out;
}

export async function getItem(
  restaurantId: string,
  id: string,
): Promise<MenuItem | null> {
  const row = await kv.get<MenuItem>(kItem(restaurantId, id));
  return row.value ?? null;
}

export async function upsertItem(
  it: Partial<MenuItem> & {
    restaurantId: string;
    name_en?: string;
    name_he?: string;
    price?: number;
    destination?: Destination;
    id?: string;
  },
): Promise<MenuItem> {
  const id = it.id ?? crypto.randomUUID();
  const item: MenuItem = {
    id,
    restaurantId: it.restaurantId,
    categoryId: it.categoryId ?? null,
    name_en: (it.name_en ?? it.name_he ?? "").trim(),
    name_he: (it.name_he ?? "").trim(),
    name_ka: (it.name_ka ?? "").trim(),
    desc_en: (it.desc_en ?? "").trim(),
    desc_he: (it.desc_he ?? "").trim(),
    desc_ka: (it.desc_ka ?? "").trim(),
    price: Number(it.price ?? 0),
    destination: it.destination ?? "kitchen",
    isActive: it.isActive ?? true,
    outOfStock: it.outOfStock ?? false,
    createdAt: Date.now(),
  };
  await kv.set(kItem(it.restaurantId, id), item);
  return item;
}

export async function deleteItem(
  restaurantId: string,
  id: string,
): Promise<void> {
  await kv.delete(kItem(restaurantId, id));
}

/* ---------- Orders ---------- */

export async function getOrCreateOpenOrder(
  restaurantId: string,
  table: number,
): Promise<Order> {
  const key = kOrderByTable(restaurantId, table);
  const cur = await kv.get<Order>(key);
  if (cur.value && cur.value.status === "open") return cur.value;

  const floorTableId = await getTableIdByNumber(restaurantId, table);

  const order: Order = {
    id: crypto.randomUUID(),
    restaurantId,
    table,
    floorTableId: floorTableId || undefined,
    status: "open",
    createdAt: Date.now(),
  };
  const tx = kv.atomic()
    .set(kOrder(restaurantId, order.id), order)
    .set(key, order);
  const res = await tx.commit();
  if (!res.ok) {
    const again = await kv.get<Order>(key);
    if (again.value) return again.value;
    throw new Error("failed_create_order");
  }
  return order;
}

export async function addOrderItem(params: {
  restaurantId: string;
  table: number;
  menuItem: MenuItem;
  quantity?: number;
}): Promise<{ order: Order; orderItem: OrderItem }> {
  const order = await getOrCreateOpenOrder(
    params.restaurantId,
    params.table,
  );
  const orderItem: OrderItem = {
    id: crypto.randomUUID(),
    orderId: order.id,
    restaurantId: params.restaurantId,
    table: params.table,
    menuItemId: params.menuItem.id,
    name: params.menuItem.name_en || params.menuItem.name_he || "",
    unitPrice: Number(params.menuItem.price ?? 0),
    quantity: Number(params.quantity ?? 1),
    destination: params.menuItem.destination,
    status: "received",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const tx = kv.atomic().set(
    kOrderItem(order.id, orderItem.id),
    orderItem,
  );
  const res = await tx.commit();
  if (!res.ok) throw new Error("failed_add_order_item");

  // צריכת מלאי אוטומטית
  consumeIngredientsForMenuItem({
    restaurantId: params.restaurantId,
    menuItemId: params.menuItem.id,
    quantity: orderItem.quantity,
  }).catch((err) => {
    console.error("[POS][inventory] consume failed", {
      restaurantId: params.restaurantId,
      menuItemId: params.menuItem.id,
      error: String(err),
    });
  });

  return { order, orderItem };
}

export async function listOrderItemsForTable(
  restaurantId: string,
  table: number,
): Promise<OrderItem[]> {
  const orderRow = await kv.get<Order>(
    kOrderByTable(restaurantId, table),
  );
  if (!orderRow.value) return [];
  const order = orderRow.value;
  const out: OrderItem[] = [];
  for await (
    const row of kv.list<OrderItem>({
      prefix: kOrderItemPrefix(order.id),
    })
  ) {
    if (row.value) out.push(row.value);
  }
  out.sort((a, b) => a.createdAt - b.createdAt);
  return out;
}

export async function computeTotalsForTable(
  restaurantId: string,
  table: number,
): Promise<OrderTotals> {
  const items = await listOrderItemsForTable(restaurantId, table);
  const active = items.filter((it) => it.status !== "cancelled");
  const itemsCount = active.reduce((sum, it) => sum + it.quantity, 0);
  const subtotal = active.reduce(
    (sum, it) => sum + it.quantity * it.unitPrice,
    0,
  );
  return { itemsCount, subtotal };
}

export async function updateOrderItemStatus(
  orderItemId: string,
  orderId: string,
  next: OrderItemStatus,
): Promise<OrderItem | null> {
  const key = kOrderItem(orderId, orderItemId);
  const row = await kv.get<OrderItem>(key);
  if (!row.value) return null;
  const cur = row.value;
  const updated: OrderItem = {
    ...cur,
    status: next,
    updatedAt: Date.now(),
  };
  const ok = await kv.atomic().check(row).set(key, updated).commit();
  if (!ok.ok) return null;
  return updated;
}

export async function cancelOrderItem(
  orderId: string,
  orderItemId: string,
): Promise<OrderItem | null> {
  return await updateOrderItemStatus(orderItemId, orderId, "cancelled");
}

export async function listOpenOrdersByRestaurant(
  restaurantId: string,
): Promise<{ table: number; order: Order }[]> {
  const out: { table: number; order: Order }[] = [];
  for await (
    const row of kv.list<Order>({
      prefix: kOrderPrefix(restaurantId),
    })
  ) {
    if (row.value && row.value.status === "open") {
      out.push({ table: row.value.table, order: row.value });
    }
  }
  out.sort((a, b) => a.table - b.table);
  return out;
}

export async function closeOrderForTable(
  restaurantId: string,
  table: number,
): Promise<Order | null> {
  const byTableKey = kOrderByTable(restaurantId, table);
  const byTableRow = await kv.get<Order>(byTableKey);
  const cur = byTableRow.value;
  if (!cur) return null;

  const orderKey = kOrder(restaurantId, cur.id);
  const orderRow = await kv.get<Order>(orderKey);
  const base = orderRow.value ?? cur;

  const items: OrderItem[] = [];
  for await (
    const row of kv.list<OrderItem>({
      prefix: kOrderItemPrefix(base.id),
    })
  ) {
    if (row.value) items.push(row.value);
  }
  items.sort((a, b) => a.createdAt - b.createdAt);

  const active = items.filter((it) => it.status !== "cancelled");
  const itemsCount = active.reduce((sum, it) => sum + it.quantity, 0);
  const subtotal = active.reduce(
    (sum, it) => sum + it.quantity * it.unitPrice,
    0,
  );

  const totals: BillTotals = {
    itemsCount,
    subtotal,
    taxRate: undefined,
    taxAmount: undefined,
    total: subtotal,
  };

  const now = Date.now();
  const updated: Order = {
    ...base,
    status: "closed",
    closedAt: now,
  };

  const billId = crypto.randomUUID();
  const paymentCode =
    `SPOTBOOK|rid=${restaurantId}|order=${updated.id}|table=${table}|bill=${billId}`;

  const bill: Bill = {
    id: billId,
    restaurantId,
    orderId: updated.id,
    table,
    createdAt: now,
    items,
    totals,
    paymentCode,
  };

  const tx = kv.atomic()
    .set(orderKey, updated)
    .delete(byTableKey)
    .set(kBill(restaurantId, billId), bill)
    .set(kBillByRestaurant(restaurantId, now, billId), bill);

  const res = await tx.commit();
  if (!res.ok) return null;

  try {
    await kv.delete(kSeat(restaurantId, table));
    // Also clear any manual status override so the table becomes "empty" right after close.
    try {
      const tableId = await getTableIdByNumber(restaurantId, table);
      if (tableId) {
        await kv.delete(["table_status", restaurantId, tableId]);
      }
    } catch {
      // ignore
    }

  } catch {
    // ignore
  }

  return updated;
}

/* ---------- Bills API ---------- */

export async function listBillsForRestaurant(
  restaurantId: string,
  limit = 100,
): Promise<Bill[]> {
  const out: Bill[] = [];
  for await (
    const row of kv.list<Bill>({
      prefix: kBillByRestaurantPrefix(restaurantId),
    })
  ) {
    if (row.value) out.push(row.value);
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return limit > 0 && out.length > limit ? out.slice(0, limit) : out;
}

export async function getBill(
  restaurantId: string,
  billId: string,
): Promise<Bill | null> {
  const key = kBill(restaurantId, billId);
  console.debug("[POS][getBill] start", {
    restaurantId,
    billId,
    key,
  });

  const row = await kv.get<Bill>(key);

  if (!row.value) {
    console.warn("[POS][getBill] bill not found in KV", {
      restaurantId,
      billId,
      key,
    });
    return null;
  }

  const bill = row.value;
  console.debug("[POS][getBill] bill loaded", {
    restaurantId,
    billId: bill.id,
    createdAt: bill.createdAt,
    createdAtIso: new Date(bill.createdAt).toISOString(),
    itemsCount: Array.isArray(bill.items) ? bill.items.length : null,
    total: bill.totals?.total ?? bill.totals?.subtotal ?? null,
  });

  return bill;
}

export async function deleteBill(
  restaurantId: string,
  billId: string,
): Promise<boolean> {
  const billRow = await kv.get<Bill>(kBill(restaurantId, billId));
  const bill = billRow.value;
  if (!bill) {
    console.warn("[POS][deleteBill] bill not found", {
      restaurantId,
      billId,
    });
    return false;
  }

  const listKey = kBillByRestaurant(restaurantId, bill.createdAt, billId);

  const res = await kv.atomic()
    .delete(kBill(restaurantId, billId))
    .delete(listKey)
    .commit();

  console.debug("[POS][deleteBill] delete result", {
    restaurantId,
    billId,
    ok: res.ok,
  });

  return res.ok;
}
