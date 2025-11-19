// pos/pos_db.ts
// Lightweight POS storage on top of Deno KV used by the project

import { kv } from "../database.ts";

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

/* ---------- KEYS ---------- */

function kCategory(rid: string, id: string) {
  return ["pos", "cat", rid, id] as Deno.KvKey;
}
function kCategoryPrefix(rid: string) {
  return ["pos", "cat", rid] as Deno.KvKey;
}

function kItem(rid: string, id: string) {
  return ["pos", "item", rid, id] as Deno.KvKey;
}
function kItemPrefix(rid: string) {
  return ["pos", "item", rid] as Deno.KvKey;
}

function kOrder(rid: string, oid: string) {
  return ["pos", "order", rid, oid] as Deno.KvKey;
}
function kOrderPrefix(rid: string) {
  return ["pos", "order", rid] as Deno.KvKey;
}

function kOrderByTable(rid: string, table: number) {
  return ["pos", "order_by_table", rid, table] as Deno.KvKey;
}
function kOrderByTablePrefix(rid: string) {
  return ["pos", "order_by_table", rid] as Deno.KvKey;
}

function kOrderItem(oid: string, iid: string) {
  return ["pos", "order_item", oid, iid] as Deno.KvKey;
}
function kOrderItemPrefix(oid: string) {
  return ["pos", "order_item", oid] as Deno.KvKey;
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
) {
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

export async function deleteCategory(restaurantId: string, id: string) {
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

export async function upsertItem(
  it: Partial<MenuItem> & {
    restaurantId: string;
    name_en?: string;
    name_he?: string;
    price?: number;
    destination?: Destination;
    id?: string;
  },
) {
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

export async function deleteItem(restaurantId: string, id: string) {
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
  const order: Order = {
    id: crypto.randomUUID(),
    restaurantId,
    table,
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

/** מחזיר את כל השולחנות עם הזמנה פתוחה למסעדה */
export async function listOpenOrdersByRestaurant(
  restaurantId: string,
): Promise<{ table: number; order: Order }[]> {
  const out: { table: number; order: Order }[] = [];
  for await (
    const row of kv.list<Order>({
      prefix: kOrderByTablePrefix(restaurantId),
    })
  ) {
    if (row.value && row.value.status === "open") {
      out.push({ table: row.value.table, order: row.value });
    }
  }
  out.sort((a, b) => a.table - b.table);
  return out;
}
