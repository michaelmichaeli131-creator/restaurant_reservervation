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
  accountId?: string;         // shared-check account (main / guest-2 / etc.)
  accountLabel?: string;      // user-facing label for the account
  locationType?: "table" | "bar";
  locationId?: string;
  seatId?: string;
  seatIds?: string[];
  reservationId?: string;
  guestName?: string;
  serviceNote?: string;
  status: "open" | "closed" | "cancelled";
  createdAt: number;
  closedAt?: number;
}

export interface OrderItem {
  id: string;
  orderId: string;
  restaurantId: string;
  table: number;
  accountId?: string;
  menuItemId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  destination: Destination;
  status: OrderItemStatus;
  notes?: string;
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
  accountId?: string;
  accountLabel?: string;
  locationType?: "table" | "bar";
  locationId?: string;
  seatId?: string;
  seatIds?: string[];
  reservationId?: string;
  serviceNote?: string;
  createdAt: number;
  items: OrderItem[];
  totals: BillTotals;
  paymentCode: string;
}

export interface TableAccountSummary {
  accountId: string;
  accountLabel: string;
  orderId: string;
  table: number;
  locationType?: "table" | "bar";
  locationId?: string;
  seatId?: string;
  seatIds?: string[];
  reservationId?: string;
  serviceNote?: string;
  createdAt: number;
  itemsCount: number;
  subtotal: number;
  isMain: boolean;
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
function kOrderByTableAccount(
  rid: string,
  table: number,
  accountId: string,
): Deno.KvKey {
  return ["pos", "order_by_table_account", rid, table, normalizeAccountId(accountId)];
}
function kOrderByTableAccountPrefix(rid: string, table: number): Deno.KvKey {
  return ["pos", "order_by_table_account", rid, table];
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

function normalizeAccountId(accountId?: string | null): string {
  const v = String(accountId ?? "").trim();
  return v || "main";
}

function normalizeAccountLabel(label?: string | null, accountId?: string | null): string {
  const v = String(label ?? "").trim();
  if (v) return v;
  const acc = normalizeAccountId(accountId);
  return acc === "main" ? "Main check" : `Check ${acc.slice(0, 6)}`;
}

function normalizeSeatIds(values?: Array<string | null | undefined> | null, fallbackSeatId?: string | null): string[] {
  const out = new Set<string>();
  for (const raw of Array.isArray(values) ? values : []) {
    const v = String(raw ?? "").trim();
    if (v) out.add(v);
  }
  const seatId = String(fallbackSeatId ?? "").trim();
  if (seatId) out.add(seatId);
  return Array.from(out);
}

async function getOpenOrderForAccount(
  restaurantId: string,
  table: number,
  accountId?: string | null,
): Promise<Order | null> {
  const normalized = normalizeAccountId(accountId);
  const byAcc = await kv.get<Order>(kOrderByTableAccount(restaurantId, table, normalized));
  if (byAcc.value && byAcc.value.status === "open") return byAcc.value;
  if (normalized === "main") {
    const legacy = await kv.get<Order>(kOrderByTable(restaurantId, table));
    if (legacy.value && legacy.value.status === "open") {
      return {
        ...legacy.value,
        accountId: normalizeAccountId((legacy.value as any).accountId),
        accountLabel: normalizeAccountLabel((legacy.value as any).accountLabel, (legacy.value as any).accountId),
      };
    }
  }
  return null;
}

export async function listOpenOrdersForTable(
  restaurantId: string,
  table: number,
): Promise<Order[]> {
  const out: Order[] = [];
  const seen = new Set<string>();
  for await (const row of kv.list<Order>({ prefix: kOrderByTableAccountPrefix(restaurantId, table) })) {
    const order = row.value;
    if (!order || order.status !== "open") continue;
    if (seen.has(order.id)) continue;
    seen.add(order.id);
    out.push({
      ...order,
      accountId: normalizeAccountId((order as any).accountId),
      accountLabel: normalizeAccountLabel((order as any).accountLabel, (order as any).accountId),
    });
  }
  const legacy = await kv.get<Order>(kOrderByTable(restaurantId, table));
  if (legacy.value && legacy.value.status === "open" && !seen.has(legacy.value.id)) {
    out.push({
      ...legacy.value,
      accountId: normalizeAccountId((legacy.value as any).accountId),
      accountLabel: normalizeAccountLabel((legacy.value as any).accountLabel, (legacy.value as any).accountId),
    });
  }
  out.sort((a, b) => a.createdAt - b.createdAt);
  return out;
}

async function listItemsForOrder(orderId: string): Promise<OrderItem[]> {
  const out: OrderItem[] = [];
  for await (const row of kv.list<OrderItem>({ prefix: kOrderItemPrefix(orderId) })) {
    if (row.value) out.push(row.value);
  }
  out.sort((a, b) => a.createdAt - b.createdAt);
  return out;
}

export async function listTableAccounts(
  restaurantId: string,
  table: number,
): Promise<TableAccountSummary[]> {
  const orders = await listOpenOrdersForTable(restaurantId, table);
  const out: TableAccountSummary[] = [];
  for (const order of orders) {
    const items = await listItemsForOrder(order.id);
    const active = items.filter((it) => it.status !== "cancelled");
    const itemsCount = active.reduce((sum, it) => sum + Number(it.quantity ?? 0), 0);
    const subtotal = active.reduce((sum, it) => sum + Number(it.quantity ?? 0) * Number(it.unitPrice ?? 0), 0);
    const accountId = normalizeAccountId(order.accountId);
    out.push({
      accountId,
      accountLabel: normalizeAccountLabel(order.accountLabel, accountId),
      orderId: order.id,
      table: order.table,
      locationType: order.locationType,
      locationId: order.locationId,
      seatId: order.seatId,
      seatIds: normalizeSeatIds((order as any).seatIds, order.seatId),
      reservationId: (order as any).reservationId || undefined,
      serviceNote: order.serviceNote || undefined,
      createdAt: order.createdAt,
      itemsCount,
      subtotal,
      isMain: accountId === "main",
    });
  }
  out.sort((a, b) => {
    if (a.isMain && !b.isMain) return -1;
    if (!a.isMain && b.isMain) return 1;
    return a.createdAt - b.createdAt;
  });
  return out;
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
  options: {
    accountId?: string;
    accountLabel?: string;
    locationType?: "table" | "bar";
    locationId?: string;
    seatId?: string;
    seatIds?: string[];
    reservationId?: string;
    guestName?: string;
    serviceNote?: string;
  } = {},
): Promise<Order> {
  const accountId = normalizeAccountId(options.accountId);
  const cur = await getOpenOrderForAccount(restaurantId, table, accountId);
  const nextSeatIds = normalizeSeatIds(options.seatIds, options.seatId);

  if (cur) {
    const mergedSeatIds = nextSeatIds.length
      ? nextSeatIds
      : normalizeSeatIds((cur as any).seatIds, cur.seatId);
    const nextSeatId = mergedSeatIds[0] || cur.seatId || undefined;
    const nextOrder: Order = {
      ...cur,
      accountId,
      accountLabel: normalizeAccountLabel(options.accountLabel ?? cur.accountLabel, accountId),
      locationType: options.locationType ?? cur.locationType ?? (accountId === "main" ? "table" : "bar"),
      locationId: options.locationId || cur.locationId || undefined,
      seatId: nextSeatId,
      seatIds: mergedSeatIds,
      reservationId: String(options.reservationId ?? (cur as any).reservationId ?? "").trim() || undefined,
      guestName: options.guestName || cur.guestName || undefined,
      serviceNote: String(options.serviceNote ?? cur.serviceNote ?? "").trim() || undefined,
    };
    const changed = JSON.stringify({
      accountLabel: cur.accountLabel,
      locationType: cur.locationType,
      locationId: cur.locationId,
      seatId: cur.seatId,
      seatIds: normalizeSeatIds((cur as any).seatIds, cur.seatId),
      reservationId: (cur as any).reservationId || undefined,
      guestName: cur.guestName || undefined,
      serviceNote: cur.serviceNote || undefined,
    }) !== JSON.stringify({
      accountLabel: nextOrder.accountLabel,
      locationType: nextOrder.locationType,
      locationId: nextOrder.locationId,
      seatId: nextOrder.seatId,
      seatIds: nextOrder.seatIds || [],
      reservationId: (nextOrder as any).reservationId || undefined,
      guestName: nextOrder.guestName || undefined,
      serviceNote: nextOrder.serviceNote || undefined,
    });
    if (changed) {
      const tx = kv.atomic()
        .set(kOrder(restaurantId, cur.id), nextOrder)
        .set(kOrderByTableAccount(restaurantId, table, accountId), nextOrder);
      if (accountId === "main") tx.set(kOrderByTable(restaurantId, table), nextOrder);
      await tx.commit();
      return nextOrder;
    }
    return cur;
  }

  const floorTableId = await getTableIdByNumber(restaurantId, table);

  const order: Order = {
    id: crypto.randomUUID(),
    restaurantId,
    table,
    floorTableId: floorTableId || undefined,
    accountId,
    accountLabel: normalizeAccountLabel(options.accountLabel, accountId),
    locationType: options.locationType ?? (accountId === "main" ? "table" : "bar"),
    locationId: options.locationId || undefined,
    seatId: nextSeatIds[0] || options.seatId || undefined,
    seatIds: nextSeatIds,
    reservationId: String(options.reservationId ?? "").trim() || undefined,
    guestName: options.guestName || undefined,
    serviceNote: String(options.serviceNote ?? "").trim() || undefined,
    status: "open",
    createdAt: Date.now(),
  };
  const tx = kv.atomic()
    .set(kOrder(restaurantId, order.id), order)
    .set(kOrderByTableAccount(restaurantId, table, accountId), order);
  if (accountId === "main") tx.set(kOrderByTable(restaurantId, table), order);
  const res = await tx.commit();
  if (!res.ok) {
    const again = await getOpenOrderForAccount(restaurantId, table, accountId);
    if (again) return again;
    throw new Error("failed_create_order");
  }
  return order;
}

export async function updateOpenOrderServiceNote(
  restaurantId: string,
  table: number,
  options: { accountId?: string; serviceNote?: string | null } = {},
): Promise<Order | null> {
  const accountId = normalizeAccountId(options.accountId);
  const cur = await getOpenOrderForAccount(restaurantId, table, accountId);
  if (!cur) return null;

  const nextServiceNote = String(options.serviceNote ?? "").trim() || undefined;
  const nextOrder: Order = {
    ...cur,
    serviceNote: nextServiceNote,
  };

  const orderKey = kOrder(restaurantId, cur.id);
  const orderRow = await kv.get<Order>(orderKey);
  const base = orderRow.value ?? cur;
  const updated: Order = {
    ...base,
    serviceNote: nextServiceNote,
  };

  const tx = kv.atomic()
    .set(orderKey, updated)
    .set(kOrderByTableAccount(restaurantId, table, accountId), updated);
  if (accountId === "main") tx.set(kOrderByTable(restaurantId, table), updated);
  const res = await tx.commit();
  if (!res.ok) return null;
  return updated;
}

export async function addOrderItem(params: {
  restaurantId: string;
  table: number;
  menuItem: MenuItem;
  quantity?: number;
  notes?: string;
  accountId?: string;
  accountLabel?: string;
  locationType?: "table" | "bar";
  locationId?: string;
  seatId?: string;
  seatIds?: string[];
  reservationId?: string;
  guestName?: string;
}): Promise<{ order: Order; orderItem: OrderItem }> {
  const accountId = normalizeAccountId(params.accountId);
  const order = await getOrCreateOpenOrder(
    params.restaurantId,
    params.table,
    {
      accountId,
      accountLabel: params.accountLabel,
      locationType: params.locationType,
      locationId: params.locationId,
      seatId: params.seatId,
      seatIds: params.seatIds,
      reservationId: params.reservationId,
      guestName: params.guestName,
    },
  );
  const trimmedNotes = (params.notes ?? "").trim();
  const orderItem: OrderItem = {
    id: crypto.randomUUID(),
    orderId: order.id,
    restaurantId: params.restaurantId,
    table: params.table,
    accountId,
    menuItemId: params.menuItem.id,
    name: params.menuItem.name_en || params.menuItem.name_he || "",
    unitPrice: Number(params.menuItem.price ?? 0),
    quantity: Number(params.quantity ?? 1),
    destination: params.menuItem.destination,
    status: "received",
    ...(trimmedNotes ? { notes: trimmedNotes } : {}),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const tx = kv.atomic().set(
    kOrderItem(order.id, orderItem.id),
    orderItem,
  );
  const res = await tx.commit();
  if (!res.ok) throw new Error("failed_add_order_item");

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
  options: { accountId?: string } = {},
): Promise<OrderItem[]> {
  const accountId = options.accountId ? normalizeAccountId(options.accountId) : "";
  const orders = accountId
    ? ((await getOpenOrderForAccount(restaurantId, table, accountId)) ? [await getOpenOrderForAccount(restaurantId, table, accountId) as Order] : [])
    : await listOpenOrdersForTable(restaurantId, table);
  const out: OrderItem[] = [];
  for (const order of orders) {
    if (!order) continue;
    for await (const row of kv.list<OrderItem>({ prefix: kOrderItemPrefix(order.id) })) {
      if (row.value) out.push(row.value);
    }
  }
  out.sort((a, b) => a.createdAt - b.createdAt);
  return out;
}

export async function computeTotalsForTable(
  restaurantId: string,
  table: number,
  options: { accountId?: string } = {},
): Promise<OrderTotals> {
  const items = await listOrderItemsForTable(restaurantId, table, options);
  const active = items.filter((it) => it.status !== "cancelled");
  const itemsCount = active.reduce((sum, it) => sum + it.quantity, 0);
  const subtotal = active.reduce(
    (sum, it) => sum + it.quantity * it.unitPrice,
    0,
  );
  return { itemsCount, subtotal };
}


export async function updateOrderItemNotes(
  orderItemId: string,
  orderId: string,
  notes: string,
): Promise<OrderItem | null> {
  const key = kOrderItem(orderId, orderItemId);
  const row = await kv.get<OrderItem>(key);
  if (!row.value) return null;
  const cur = row.value;
  const trimmed = String(notes || '').trim();
  const updated: OrderItem = {
    ...cur,
    ...(trimmed ? { notes: trimmed } : { notes: undefined }),
    updatedAt: Date.now(),
  };
  const ok = await kv.atomic().check(row).set(key, updated).commit();
  if (!ok.ok) return null;
  return updated;
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
  options: { accountId?: string } = {},
): Promise<Order | null> {
  const accountId = normalizeAccountId(options.accountId);
  const cur = await getOpenOrderForAccount(restaurantId, table, accountId);
  if (!cur) return null;

  const orderKey = kOrder(restaurantId, cur.id);
  const orderRow = await kv.get<Order>(orderKey);
  const base = orderRow.value ?? cur;

  const items: OrderItem[] = [];
  for await (const row of kv.list<OrderItem>({
    prefix: kOrderItemPrefix(base.id),
  })) {
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
    `SPOTBOOK|rid=${restaurantId}|order=${updated.id}|table=${table}|account=${accountId}|bill=${billId}`;

  const bill: Bill = {
    id: billId,
    restaurantId,
    orderId: updated.id,
    table,
    accountId,
    accountLabel: normalizeAccountLabel(updated.accountLabel, accountId),
    locationType: updated.locationType,
    locationId: updated.locationId,
    seatId: updated.seatId,
    seatIds: normalizeSeatIds((updated as any).seatIds, updated.seatId),
    reservationId: (updated as any).reservationId || undefined,
    createdAt: now,
    items,
    totals,
    paymentCode,
  };

  const tx = kv.atomic()
    .set(orderKey, updated)
    .delete(kOrderByTableAccount(restaurantId, table, accountId))
    .set(kBill(restaurantId, billId), bill)
    .set(kBillByRestaurant(restaurantId, now, billId), bill);

  if (accountId === "main") {
    tx.delete(kOrderByTable(restaurantId, table));
  }

  const res = await tx.commit();
  if (!res.ok) return null;

  try {
    const remaining = await listOpenOrdersForTable(restaurantId, table);
    if (remaining.length === 0) {
      await kv.delete(kSeat(restaurantId, table));
      try {
        const tableId = await getTableIdByNumber(restaurantId, table);
        if (tableId) {
          await kv.delete(["table_status", restaurantId, tableId]);
        }
      } catch {
        // ignore
      }
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
