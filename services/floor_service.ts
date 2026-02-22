// services/floor_service.ts
// Floor management service - table status, sections, mappings

import { kv, getReservationById } from "../database.ts";
import type { Order, OrderItem } from "../pos/pos_db.ts";

export type TableStatus = "empty" | "occupied" | "reserved" | "dirty";

export interface TableStatusData {
  tableId: string;
  tableNumber: number;
  status: TableStatus;
  guestCount?: number;
  guestName?: string;
  reservationTime?: string;
  itemsCount?: number;
  subtotal?: number;
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

// ========== TABLE STATUS OVERRIDE (dirty/clean) ==========

export interface TableStatusOverride {
  tableId: string;
  status: TableStatus;
  updatedAt: number;
  updatedBy: string;
}

function kTableStatusOverride(restaurantId: string, tableId: string): Deno.KvKey {
  return ["table_status", restaurantId, tableId];
}

/**
 * Set a manual status override for a table (e.g. "dirty" after order close).
 * Set to "empty" to clear the override.
 */
export async function setTableStatusOverride(
  restaurantId: string,
  tableId: string,
  status: TableStatus,
  userId: string,
): Promise<void> {
  if (status === "empty") {
    // Clear override — let computed status take over
    await kv.delete(kTableStatusOverride(restaurantId, tableId));
    return;
  }
  const data: TableStatusOverride = {
    tableId,
    status,
    updatedAt: Date.now(),
    updatedBy: userId,
  };
  await kv.set(kTableStatusOverride(restaurantId, tableId), data);
}

/**
 * Get the manual status override for a table, if any.
 */
export async function getTableStatusOverride(
  restaurantId: string,
  tableId: string,
): Promise<TableStatusOverride | null> {
  const res = await kv.get(kTableStatusOverride(restaurantId, tableId));
  return res.value as TableStatusOverride | null;
}

/**
 * Mark a table as dirty (typically called when an order is closed).
 */
export async function markTableDirty(
  restaurantId: string,
  tableId: string,
  userId: string,
): Promise<void> {
  await setTableStatusOverride(restaurantId, tableId, "dirty", userId);
}

/**
 * Mark a table as clean (clears the "dirty" override).
 */
export async function markTableClean(
  restaurantId: string,
  tableId: string,
  userId: string,
): Promise<void> {
  await setTableStatusOverride(restaurantId, tableId, "empty", userId);
}

// ========== SEATING + RESERVATION ENRICHMENT (for Table Details) ==========

interface SeatingInfoLite {
  restaurantId: string;
  table: number;
  reservationId?: string;
  seatedAt?: number;
  guestName?: string;
  people?: number;
  time?: string;
}

function kSeatByTable(restaurantId: string, tableNumber: number): Deno.KvKey {
  return ["seat", "by_table", restaurantId, Number(tableNumber)];
}

function normalizeStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function pickGuestName(seat: SeatingInfoLite | null, reservation: any | null): string | undefined {
  const fromSeat = normalizeStr(seat?.guestName);
  if (fromSeat) return fromSeat;

  const firstName = normalizeStr(reservation?.firstName);
  const lastName = normalizeStr(reservation?.lastName);
  const full = `${firstName} ${lastName}`.trim();
  if (full) return full;

  const name = normalizeStr(reservation?.name);
  if (name) return name;

  return undefined;
}

function pickGuestCount(seat: SeatingInfoLite | null, reservation: any | null): number | undefined {
  const fromSeat = Number(seat?.people);
  if (Number.isFinite(fromSeat) && fromSeat > 0) return fromSeat;

  const fromRes = Number(reservation?.people);
  if (Number.isFinite(fromRes) && fromRes > 0) return fromRes;

  return undefined;
}

function pickReservationTime(seat: SeatingInfoLite | null, reservation: any | null): string | undefined {
  const fromSeat = normalizeStr(seat?.time);
  if (fromSeat) return fromSeat;

  const fromRes = normalizeStr(reservation?.time);
  if (fromRes) return fromRes;

  return undefined;
}

// ========== COMPUTE LIVE TABLE STATUS ==========

/**
 * Compute table status from floor plan, current orders, and manual overrides.
 * Priority: occupied (open order) > dirty (manual override) > empty
 */
export async function computeTableStatus(
  restaurantId: string,
  floorTableId: string,
  tableNumber: number
): Promise<TableStatusData> {
  const base: TableStatusData = {
    tableId: floorTableId,
    tableNumber,
    status: "empty",
  };

  // Seating info (host seating) — used to enrich Table Details.
  let seat: SeatingInfoLite | null = null;
  let reservation: any | null = null;
  try {
    const seatRow = await kv.get(kSeatByTable(restaurantId, tableNumber));
    seat = (seatRow.value as SeatingInfoLite | null) ?? null;
    if (seat?.reservationId) {
      reservation = await getReservationById(String(seat.reservationId));
    }
  } catch (_e) {
    // Best-effort; table details can still work without seating data.
  }

  const guestName = pickGuestName(seat, reservation);
  const guestCount = pickGuestCount(seat, reservation);
  const reservationTime = pickReservationTime(seat, reservation);

  // Look up current order for this table
  const orderKey = ["pos", "order_by_table", restaurantId, tableNumber] as Deno.KvKey;
  const orderRes = await kv.get(orderKey);
  const order = orderRes.value as Order | null;

  // 1) Open order -> occupied (highest priority)
  if (order && order.status === "open") {
    // Compute order items to show useful details in the UI
    const itemPrefix = ["pos", "order_item", order.id] as Deno.KvKey;

    let itemsReady = 0;
    let itemsPending = 0;
    let itemsCount = 0;
    let subtotal = 0;

    const iter = kv.list({ prefix: itemPrefix });
    for await (const entry of iter) {
      const item = entry.value as OrderItem;
      if (item.status === "cancelled") continue;

      const qty = Number(item.quantity ?? 1) || 1;
      itemsCount += qty;
      subtotal += Number(item.unitPrice ?? 0) * qty;

      if (item.status === "ready" || item.status === "served") {
        itemsReady += qty;
      } else {
        itemsPending += qty;
      }
    }

    return {
      ...base,
      status: "occupied",
      guestName,
      guestCount,
      reservationTime,
      orderId: order.id,
      orderTotal: subtotal,
      subtotal,
      itemsCount,
      occupiedSince: order.createdAt,
      itemsReady,
      itemsPending,
    };
  }

  // 2) No open order but seating exists -> treat as occupied (host seated)
  if (seat) {
    return {
      ...base,
      status: "occupied",
      guestName,
      guestCount,
      reservationTime,
    };
  }

  // 3) Manual override (reserved/dirty)
  const override = await getTableStatusOverride(restaurantId, floorTableId);
  if (override && override.status !== "empty") {
    return {
      ...base,
      status: override.status,
    };
  }

  return base;
}

/**
 * Compute status for all tables in a floor plan at once in a floor plan at once
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

// ========== MULTI-LAYOUT MANAGEMENT ==========

export interface FloorLayout {
  id: string;
  restaurantId: string;
  name: string;
  gridRows: number;
  gridCols: number;
  /**
   * Tables placed on the floor grid.
   */
  tables: Array<{
    id: string;
    name: string;
    tableNumber: number;
    sectionId?: string;
    gridX: number;
    gridY: number;
    spanX: number;
    spanY: number;
    seats: number;
    shape: "square" | "round" | "rect" | "booth";
  }>;

  /**
   * Decorative/structural objects rendered on the map (walls, doors, bar, plants, etc.).
   * Backward-compatible: older layouts may not have this field.
   */
  objects?: Array<{
    id: string;
    type: "wall" | "door" | "bar" | "plant" | "divider";
    gridX: number;
    gridY: number;
    spanX: number;
    spanY: number;
    rotation?: 0 | 90 | 180 | 270;
    label?: string;
  }>;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

function kFloorLayout(restaurantId: string, layoutId: string): Deno.KvKey {
  return ["floor_plan", restaurantId, layoutId];
}

function kFloorLayoutIndex(restaurantId: string, layoutId: string): Deno.KvKey {
  return ["floor_plan_by_restaurant", restaurantId, layoutId];
}

function kFloorLayoutIndexPrefix(restaurantId: string): Deno.KvKey {
  return ["floor_plan_by_restaurant", restaurantId];
}

function kActiveFloorLayout(restaurantId: string): Deno.KvKey {
  return ["active_floor_plan", restaurantId];
}

/**
 * Create a new floor layout
 */
export async function createFloorLayout(data: {
  restaurantId: string;
  name: string;
  gridRows: number;
  gridCols: number;
  tables?: FloorLayout["tables"];
  objects?: FloorLayout["objects"];
  isActive?: boolean;
}): Promise<FloorLayout> {
  const id = crypto.randomUUID();
  const now = Date.now();

  const layout: FloorLayout = {
    id,
    restaurantId: data.restaurantId,
    name: data.name,
    gridRows: data.gridRows,
    gridCols: data.gridCols,
    tables: data.tables ?? [],
    objects: data.objects ?? [],
    isActive: data.isActive ?? false,
    createdAt: now,
    updatedAt: now,
  };

  const primaryKey = kFloorLayout(data.restaurantId, id);
  const indexKey = kFloorLayoutIndex(data.restaurantId, id);

  await kv.atomic()
    .set(primaryKey, layout)
    .set(indexKey, { id: layout.id, name: layout.name, isActive: layout.isActive, updatedAt: now })
    .commit();

  // If this is the first layout or marked as active, set it as active
  if (data.isActive) {
    await setActiveFloorLayout(data.restaurantId, id);
  }

  return layout;
}

/**
 * Get a floor layout by ID
 */
export async function getFloorLayout(
  restaurantId: string,
  layoutId: string
): Promise<FloorLayout | null> {
  const res = await kv.get(kFloorLayout(restaurantId, layoutId));
  return res.value as FloorLayout | null;
}

/**
 * List all layouts for a restaurant
 */
export async function listFloorLayouts(
  restaurantId: string
): Promise<FloorLayout[]> {
  const layouts: FloorLayout[] = [];
  const iter = kv.list({ prefix: kFloorLayoutIndexPrefix(restaurantId) });

  for await (const entry of iter) {
    const layoutId = entry.key[entry.key.length - 1] as string;
    const layout = await getFloorLayout(restaurantId, layoutId);
    if (layout) layouts.push(layout);
  }

  // Sort by updatedAt (newest first)
  layouts.sort((a, b) => b.updatedAt - a.updatedAt);
  return layouts;
}

/**
 * Update a floor layout
 */
export async function updateFloorLayout(
  restaurantId: string,
  layoutId: string,
  updates: Partial<FloorLayout>
): Promise<FloorLayout | null> {
  const layout = await getFloorLayout(restaurantId, layoutId);
  if (!layout) return null;

  const updated: FloorLayout = {
    ...layout,
    ...updates,
    id: layout.id,
    restaurantId: layout.restaurantId,
    createdAt: layout.createdAt,
    updatedAt: Date.now(),
  };

  const primaryKey = kFloorLayout(restaurantId, layoutId);
  const indexKey = kFloorLayoutIndex(restaurantId, layoutId);

  await kv.atomic()
    .set(primaryKey, updated)
    .set(indexKey, { id: updated.id, name: updated.name, isActive: updated.isActive, updatedAt: updated.updatedAt })
    .commit();

  return updated;
}

/**
 * Delete a floor layout
 */
export async function deleteFloorLayout(
  restaurantId: string,
  layoutId: string
): Promise<boolean> {
  const layout = await getFloorLayout(restaurantId, layoutId);
  if (!layout) return false;

  // Don't allow deleting the active layout if it's the only one
  if (layout.isActive) {
    const allLayouts = await listFloorLayouts(restaurantId);
    if (allLayouts.length === 1) {
      throw new Error("Cannot delete the only layout");
    }
  }

  const primaryKey = kFloorLayout(restaurantId, layoutId);
  const indexKey = kFloorLayoutIndex(restaurantId, layoutId);

  await kv.atomic()
    .delete(primaryKey)
    .delete(indexKey)
    .commit();

  // If this was the active layout, set another one as active
  if (layout.isActive) {
    const remaining = await listFloorLayouts(restaurantId);
    if (remaining.length > 0) {
      await setActiveFloorLayout(restaurantId, remaining[0].id);
    }
  }

  return true;
}

/**
 * Set the active floor layout for a restaurant
 */
export async function setActiveFloorLayout(
  restaurantId: string,
  layoutId: string
): Promise<void> {
  // Verify layout exists
  const layout = await getFloorLayout(restaurantId, layoutId);
  if (!layout) throw new Error("Layout not found");

  // Get all layouts and deactivate them
  const allLayouts = await listFloorLayouts(restaurantId);
  for (const l of allLayouts) {
    if (l.isActive && l.id !== layoutId) {
      await updateFloorLayout(restaurantId, l.id, { isActive: false });
    }
  }

  // Activate the specified layout
  await updateFloorLayout(restaurantId, layoutId, { isActive: true });

  // Store active layout reference
  await kv.set(kActiveFloorLayout(restaurantId), layoutId);
}

/**
 * Get the active floor layout for a restaurant
 */
export async function getActiveFloorLayout(
  restaurantId: string
): Promise<FloorLayout | null> {
  const res = await kv.get(kActiveFloorLayout(restaurantId));
  const layoutId = res.value as string | null;

  if (!layoutId) {
    // No active layout set, get the first one
    const layouts = await listFloorLayouts(restaurantId);
    return layouts.length > 0 ? layouts[0] : null;
  }

  return await getFloorLayout(restaurantId, layoutId);
}

/**
 * Duplicate a floor layout
 */
export async function duplicateFloorLayout(
  restaurantId: string,
  layoutId: string,
  newName?: string
): Promise<FloorLayout> {
  const source = await getFloorLayout(restaurantId, layoutId);
  if (!source) throw new Error("Source layout not found");

  return await createFloorLayout({
    restaurantId,
    name: newName ?? `${source.name} (Copy)`,
    gridRows: source.gridRows,
    gridCols: source.gridCols,
    tables: JSON.parse(JSON.stringify(source.tables)), // Deep clone
    isActive: false,
  });
}
