// services/floor_service.ts
// Floor management service - table status, sections, mappings

import { kv } from "../database.ts";
import type { Order, OrderItem } from "../pos/pos_db.ts";

export type TableStatus = "empty" | "occupied" | "reserved" | "dirty";

export interface TableStatusData {
  tableId: string;
  tableNumber: number;
  status: TableStatus;
  guestCount?: number;
  orderId?: string;
  orderTotal?: number;
  occupiedSince?: number;
  itemsReady?: number;
  itemsPending?: number;
  assignedWaiterId?: string;
}

// ========== TABLE NUMBER → TABLE ID MAPPING ==========

/**
 * Create mapping from numeric table number to floor table UUID
 * Stored as: ["table_mapping", restaurantId, tableNumber] -> tableId
 */
export async function setTableMapping(
  restaurantId: string,
  tableNumber: number,
  floorTableId: string
): Promise<void> {
  const key = ["table_mapping", restaurantId, tableNumber] as Deno.KvKey;
  await kv.set(key, floorTableId);
}

/**
 * Get floor table ID from numeric table number
 */
export async function getTableIdByNumber(
  restaurantId: string,
  tableNumber: number
): Promise<string | null> {
  const key = ["table_mapping", restaurantId, tableNumber] as Deno.KvKey;
  const res = await kv.get(key);
  return res.value as string | null;
}

/**
 * Bulk set mappings from floor plan tables
 */
export async function setTableMappingsFromFloorPlan(
  restaurantId: string,
  tables: Array<{ id: string; tableNumber: number }>
): Promise<void> {
  const entries: Array<[Deno.KvKey, string]> = tables.map(t => [
    ["table_mapping", restaurantId, t.tableNumber] as Deno.KvKey,
    t.id,
  ]);

  for (const [key, value] of entries) {
    await kv.set(key, value);
  }
}

// ========== COMPUTE LIVE TABLE STATUS ==========

/**
 * Compute table status from floor plan and current orders
 * Returns empty if no order, occupied/reserved/dirty based on order state
 */
export async function computeTableStatus(
  restaurantId: string,
  floorTableId: string,
  tableNumber: number
): Promise<TableStatusData> {
  // Look up current order for this table
  const orderKey = ["pos", "order_by_table", restaurantId, tableNumber] as Deno.KvKey;
  const orderRes = await kv.get(orderKey);
  const order = orderRes.value as Order | null;

  const base: TableStatusData = {
    tableId: floorTableId,
    tableNumber,
    status: "empty",
  };

  // If no open order, table is empty
  if (!order || order.status !== "open") {
    return base;
  }

  // Get all order items to compute status
  const itemPrefix = ["pos", "order_item", order.id] as Deno.KvKey;
  const items: OrderItem[] = [];
  let itemsReady = 0;
  let itemsPending = 0;
  let subtotal = 0;

  const iter = kv.list({ prefix: itemPrefix });
  for await (const entry of iter) {
    const item = entry.value as OrderItem;
    if (item.status === "cancelled") continue;

    items.push(item);
    subtotal += item.unitPrice * item.quantity;

    if (item.status === "ready" || item.status === "served") {
      itemsReady++;
    } else {
      itemsPending++;
    }
  }

  return {
    tableId: floorTableId,
    tableNumber,
    status: "occupied",
    orderId: order.id,
    orderTotal: subtotal,
    occupiedSince: order.createdAt,
    itemsReady,
    itemsPending,
  };
}

/**
 * Compute status for all tables in a floor plan at once
 */
export async function computeAllTableStatuses(
  restaurantId: string,
  tables: Array<{ id: string; tableNumber: number }>
): Promise<TableStatusData[]> {
  const statuses: TableStatusData[] = [];

  for (const table of tables) {
    const status = await computeTableStatus(
      restaurantId,
      table.id,
      table.tableNumber
    );
    statuses.push(status);
  }

  return statuses;
}

// ========== FLOOR SECTIONS ==========

export interface FloorSection {
  id: string;
  restaurantId: string;
  name: string;
  gridRows: number;
  gridCols: number;
  displayOrder: number;
  createdAt: number;
  updatedAt: number;
}

function kFloorSection(
  restaurantId: string,
  sectionId: string
): Deno.KvKey {
  return ["floor_section", restaurantId, sectionId];
}

function kFloorSectionPrefix(restaurantId: string): Deno.KvKey {
  return ["floor_section", restaurantId];
}

function kFloorSectionIndexPrefix(restaurantId: string): Deno.KvKey {
  return ["floor_section_by_restaurant", restaurantId];
}

function kFloorSectionIndex(restaurantId: string, sectionId: string): Deno.KvKey {
  return ["floor_section_by_restaurant", restaurantId, sectionId];
}

/**
 * Create a new floor section
 */
export async function createFloorSection(data: {
  restaurantId: string;
  name: string;
  gridRows: number;
  gridCols: number;
  displayOrder?: number;
}): Promise<FloorSection> {
  const id = crypto.randomUUID();
  const now = Date.now();

  const section: FloorSection = {
    id,
    restaurantId: data.restaurantId,
    name: data.name,
    gridRows: data.gridRows,
    gridCols: data.gridCols,
    displayOrder: data.displayOrder ?? 0,
    createdAt: now,
    updatedAt: now,
  };

  const primaryKey = kFloorSection(data.restaurantId, id);
  const indexKey = kFloorSectionIndex(data.restaurantId, id);

  await kv.atomic()
    .set(primaryKey, section)
    .set(indexKey, section)
    .commit();

  return section;
}

/**
 * Get a floor section
 */
export async function getFloorSection(
  restaurantId: string,
  sectionId: string
): Promise<FloorSection | null> {
  const res = await kv.get(kFloorSection(restaurantId, sectionId));
  return res.value as FloorSection | null;
}

/**
 * List all sections for a restaurant
 */
export async function listFloorSections(
  restaurantId: string
): Promise<FloorSection[]> {
  const sections: FloorSection[] = [];
  const iter = kv.list({ prefix: kFloorSectionIndexPrefix(restaurantId) });

  for await (const entry of iter) {
    const section = entry.value as FloorSection;
    sections.push(section);
  }

  // Sort by displayOrder
  sections.sort((a, b) => a.displayOrder - b.displayOrder);
  return sections;
}

/**
 * Update floor section
 */
export async function updateFloorSection(
  restaurantId: string,
  sectionId: string,
  updates: Partial<FloorSection>
): Promise<FloorSection | null> {
  const section = await getFloorSection(restaurantId, sectionId);
  if (!section) return null;

  const updated: FloorSection = {
    ...section,
    ...updates,
    id: section.id,
    restaurantId: section.restaurantId,
    createdAt: section.createdAt,
    updatedAt: Date.now(),
  };

  const primaryKey = kFloorSection(restaurantId, sectionId);
  const indexKey = kFloorSectionIndex(restaurantId, sectionId);

  await kv.atomic()
    .set(primaryKey, updated)
    .set(indexKey, updated)
    .commit();

  return updated;
}

/**
 * Delete floor section
 */
export async function deleteFloorSection(
  restaurantId: string,
  sectionId: string
): Promise<void> {
  const section = await getFloorSection(restaurantId, sectionId);
  if (!section) return;

  const primaryKey = kFloorSection(restaurantId, sectionId);
  const indexKey = kFloorSectionIndex(restaurantId, sectionId);

  await kv.atomic()
    .delete(primaryKey)
    .delete(indexKey)
    .commit();
}
