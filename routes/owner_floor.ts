// routes/owner_floor.ts
// Floor plan management for restaurant owners + חשיפת guestName לשולחנות

import { Router } from "jsr:@oak/oak";
import { requireOwner, requireStaff } from "../lib/auth.ts";
import { requireRestaurantAccess } from "../services/authz.ts";
import { kv, getRestaurant, listReservationsFor } from "../database.ts";
import { render } from "../lib/view.ts";
import {
  computeAllTableStatuses,
  setTableMappingsFromFloorPlan,
  createFloorSection,
  getFloorSection,
  listFloorSections,
  updateFloorSection,
  deleteFloorSection,
  // Multi-layout functions
  createFloorLayout,
  getFloorLayout,
  listFloorLayouts,
  updateFloorLayout,
  deleteFloorLayout,
  setActiveFloorLayout,
  getActiveFloorLayout,
  duplicateFloorLayout,
  type FloorLayout,
} from "../services/floor_service.ts";

export const ownerFloorRouter = new Router();

// Helper to generate key for floor plan
function toKey(...parts: (string | number)[]): Deno.KvKey {
  return parts.map(String) as Deno.KvKey;
}

interface FloorTable {
  id: string;
  name: string;
  tableNumber: number;        // POS table number for lookup
  sectionId?: string;         // Link to floor section
  gridX: number;
  gridY: number;
  spanX: number;
  spanY: number;
  seats: number;
  shape: "square" | "round" | "rect" | "booth";
}

interface FloorObject {
  id: string;
  type: "wall" | "door" | "bar" | "plant" | "divider";
  gridX: number;
  gridY: number;
  spanX: number;
  spanY: number;
  rotation?: 0 | 90 | 180 | 270;
  label?: string;
}

// Live table status computed from orders
interface TableStatus {
  tableId: string;
  tableNumber: number;
  status: "empty" | "occupied" | "reserved" | "dirty";
  guestCount?: number;
  orderId?: string;
  orderTotal?: number;
  occupiedSince?: number;
  itemsReady?: number;
  itemsPending?: number;
  // חדש: שם האורח היושב בשולחן (אם יש הזמנה שהגיעה/הושבה)
  guestName?: string | null;
}

interface FloorPlan {
  id: string;
  restaurantId: string;
  name: string;
  gridRows: number;
  gridCols: number;
  tables: FloorTable[];
  objects?: FloorObject[];
  createdAt: number;
  updatedAt: number;
}

/* =================== UI Routes =================== */

// GET /owner/restaurants/:id/floor - Floor plan editor page
ownerFloorRouter.get(
  "/owner/restaurants/:id/floor",
  async (ctx) => {
    if (!requireOwner(ctx)) return;

    const restaurantId = ctx.params.id;
    if (!restaurantId) {
      ctx.response.status = 400;
      ctx.response.body = "Missing restaurant ID";
      return;
    }

    const owner = ctx.state.user;

    // Verify ownership
    const restaurantKey = toKey("restaurant", restaurantId);
    const restaurant = await kv.get(restaurantKey);

    if (!restaurant.value || (restaurant.value as any).ownerId !== owner.id) {
      ctx.response.status = 403;
      ctx.response.body = "Forbidden";
      return;
    }

    await render(ctx, "owner_floor", {
      user: owner,
      restaurantId,
      restaurant: restaurant.value,
    });
  }
);

/* =================== API Routes =================== */

// POST /api/tables/:restaurantId/:tableId/status - Update table status
ownerFloorRouter.post(
  "/api/tables/:restaurantId/:tableId/status",
  async (ctx) => {
    if (!requireStaff(ctx)) return;

    const restaurantId = ctx.params.restaurantId;
    const tableId = ctx.params.tableId;
    const user = ctx.state.user;

    if (!restaurantId || !tableId) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Missing restaurant ID or table ID" };
      return;
    }

    if (!(await requireRestaurantAccess(ctx, restaurantId))) return;

    const body = await (ctx.request as any).originalRequest?.json?.().catch?.(() => null)
      ?? await (async () => {
        try {
          const b = (ctx.request as any).body?.({ type: "json" });
          return b ? await b.value : null;
        } catch {
          return null;
        }
      })()
      ?? {};

    const { status } = body as any;

    if (!status || !["empty", "occupied", "reserved", "dirty"].includes(status)) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Invalid status" };
      return;
    }

    // Verify the restaurant exists
    const restaurant = await getRestaurant(restaurantId);
    if (!restaurant) {
      ctx.response.status = 404;
      ctx.response.body = { error: "Restaurant not found" };
      return;
    }

    // Verify user has access (owner can access any, staff/manager can access their own)
    if (user.role === "owner") {
      // Owner can update any restaurant's tables
    } else if (user.role === "manager" || user.role === "staff") {
      // Manager/staff can only update tables at their assigned restaurant
      // For now, allow if they're logged in (could enhance with restaurant assignment later)
    } else {
      ctx.response.status = 403;
      ctx.response.body = { error: "Forbidden" };
      return;
    }

    // Store table status update
    const statusKey = toKey("table_status", restaurantId, tableId);
    const statusData = {
      tableId,
      status,
      updatedAt: Date.now(),
      updatedBy: user.id,
    };
    await kv.set(statusKey, statusData);

    ctx.response.status = 200;
    ctx.response.body = { success: true, status: statusData };
  }
);

// GET /api/floor-plans/:restaurantId - Get floor plan with live table statuses
ownerFloorRouter.get(
  "/api/floor-plans/:restaurantId",
  async (ctx) => {
    if (!requireStaff(ctx)) return;

    const restaurantId = ctx.params.restaurantId;
    if (!restaurantId) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Missing restaurant ID" };
      return;
    }

    if (!(await requireRestaurantAccess(ctx, restaurantId))) return;

    if (!(await requireRestaurantAccess(ctx, restaurantId))) return;

    if (!(await requireRestaurantAccess(ctx, restaurantId))) return;

    const user = ctx.state.user;

    // Verify restaurant exists
    const restaurant = await getRestaurant(restaurantId);
    if (!restaurant) {
      ctx.response.status = 404;
      ctx.response.body = { error: "Restaurant not found" };
      return;
    }

    // הרשאות:
    // owner – חייב להיות הבעלים של המסעדה
    // manager/staff – כרגע מותר (בהמשך אפשר לסנן לפי שיוך למסעדה)
    if (user.role === "owner") {
      if ((restaurant as any).ownerId !== user.id) {
        ctx.response.status = 403;
        ctx.response.body = { error: "Forbidden" };
        return;
      }
    } else if (user.role === "manager" || user.role === "staff") {
      // allowed
    } else {
      ctx.response.status = 403;
      ctx.response.body = { error: "Forbidden" };
      return;
    }

    // Get floor plan
    const floorPlanKey = toKey("floor_plan", restaurantId);
    const floorPlanRes = await kv.get(floorPlanKey);

    if (!floorPlanRes.value) {
      ctx.response.status = 404;
      ctx.response.body = { error: "Floor plan not found" };
      return;
    }

    const floorPlan = floorPlanRes.value as FloorPlan;

    // Compute live table statuses (empty/occupied/reserved/dirty)
    const baseStatuses = await computeAllTableStatuses(
      restaurantId,
      floorPlan.tables,
    );

    // ✅ הוספת guestName לכל שולחן על בסיס reservations שהגיעו/הושבו היום
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    const allRes = await listReservationsFor(restaurantId, date);
    const nameByTable = new Map<number, string>();

    for (const res of (allRes ?? []) as any[]) {
      const st = String(res.status ?? "").toLowerCase();
      // נניח ש־arrived / seated = ישבו בשולחן
      if (st !== "arrived" && st !== "seated") continue;

      const tn = Number(
        (res as any).tableNumber ??
        (res as any).table ??
        (res as any).tableNo ??
        (res as any).table_id ??
        0,
      );
      if (!tn || !Number.isFinite(tn)) continue;

      const fullName = (res.firstName && res.lastName)
        ? `${res.firstName} ${res.lastName}`
        : (res.name ?? "");

      if (fullName) {
        nameByTable.set(tn, String(fullName));
      }
    }

    const tableStatuses: TableStatus[] = (baseStatuses as TableStatus[]).map((ts) => {
      const tn = Number(ts.tableNumber);
      const gName = nameByTable.get(tn) ?? null;
      return {
        ...ts,
        guestName: gName,
      };
    });

    // Return floor plan with live statuses + guestName
    ctx.response.body = {
      ...floorPlan,
      tableStatuses,
    };
  }
);

// NEW: GET /api/floor-plans/:restaurantId/statuses - only table statuses (for live refresh)
ownerFloorRouter.get(
  "/api/floor-plans/:restaurantId/statuses",
  async (ctx) => {
    if (!requireStaff(ctx)) return;

    const restaurantId = ctx.params.restaurantId;
    if (!restaurantId) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Missing restaurant ID" };
      return;
    }

    const user = ctx.state.user;

    // Verify restaurant exists
    const restaurant = await getRestaurant(restaurantId);
    if (!restaurant) {
      ctx.response.status = 404;
      ctx.response.body = { error: "Restaurant not found" };
      return;
    }

    if (user.role === "owner") {
      if ((restaurant as any).ownerId !== user.id) {
        ctx.response.status = 403;
        ctx.response.body = { error: "Forbidden" };
        return;
      }
    } else if (user.role === "manager" || user.role === "staff") {
      // allowed
    } else {
      ctx.response.status = 403;
      ctx.response.body = { error: "Forbidden" };
      return;
    }

    // Get floor plan
    const floorPlanKey = toKey("floor_plan", restaurantId);
    const floorPlanRes = await kv.get(floorPlanKey);

    if (!floorPlanRes.value) {
      ctx.response.status = 404;
      ctx.response.body = { error: "Floor plan not found" };
      return;
    }

    const floorPlan = floorPlanRes.value as FloorPlan;

    // Compute live table statuses
    const tableStatuses = await computeAllTableStatuses(
      restaurantId,
      floorPlan.tables,
    );

    ctx.response.status = 200;
    ctx.response.body = tableStatuses;
  }
);

// POST /api/floor-plans/:restaurantId - Save/update floor plan with table mappings
ownerFloorRouter.post(
  "/api/floor-plans/:restaurantId",
  async (ctx) => {
    if (!requireOwner(ctx)) return;

    const restaurantId = ctx.params.restaurantId;
    if (!restaurantId) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Missing restaurant ID" };
      return;
    }

    const owner = ctx.state.user;

    // Verify ownership
    const restaurant = await getRestaurant(restaurantId);
    if (!restaurant || (restaurant as any).ownerId !== owner.id) {
      ctx.response.status = 403;
      ctx.response.body = { error: "Forbidden" };
      return;
    }

    // Parse request body (אותו helper גנרי כמו קודם)
    const body = await (ctx.request as any).originalRequest?.json?.().catch?.(() => null)
      ?? await (async () => {
        try {
          const b = (ctx.request as any).body?.({ type: "json" });
          return b ? await b.value : null;
        } catch {
          return null;
        }
      })()
      ?? {};

    // Validate floor plan data
    if (!body.name || !body.gridRows || !body.gridCols || !Array.isArray(body.tables)) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Invalid floor plan data" };
      return;
    }

    // Validate that all tables have tableNumber
    if (!body.tables.every((t: any) => t.id && typeof t.tableNumber === "number")) {
      ctx.response.status = 400;
      ctx.response.body = { error: "All tables must have id and tableNumber" };
      return;
    }

    const now = Date.now();

    // Check if floor plan exists
    const floorPlanKey = toKey("floor_plan", restaurantId);
    const existing = await kv.get(floorPlanKey);

    const floorPlan: FloorPlan = {
      id: existing.value ? (existing.value as any).id : `fp_${now}`,
      restaurantId,
      name: body.name,
      gridRows: body.gridRows,
      gridCols: body.gridCols,
      tables: body.tables,
      objects: Array.isArray(body.objects) ? body.objects : [],
      createdAt: existing.value ? (existing.value as any).createdAt : now,
      updatedAt: now,
    };

    // Save to KV
    await kv.set(floorPlanKey, floorPlan);

    // Also create index for listing
    const indexKey = toKey("floor_plan_by_restaurant", restaurantId, floorPlan.id);
    await kv.set(indexKey, { id: floorPlan.id, name: floorPlan.name, updatedAt: now });

    // Create table mappings (tableNumber → tableId) for POS lookup
    await setTableMappingsFromFloorPlan(
      restaurantId,
      body.tables.map((t: any) => ({ id: t.id, tableNumber: t.tableNumber })),
    );

    // Compute and return live statuses
    const tableStatuses = await computeAllTableStatuses(restaurantId, body.tables);

    ctx.response.status = 200;
    ctx.response.body = {
      success: true,
      floorPlan,
      tableStatuses,
    };
  }
);

/* =================== FLOOR SECTIONS =================== */

// GET /api/floor-sections/:restaurantId - List all sections
ownerFloorRouter.get(
  "/api/floor-sections/:restaurantId",
  async (ctx) => {
    if (!requireOwner(ctx)) return;

    const restaurantId = ctx.params.restaurantId;
    if (!restaurantId) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Missing restaurant ID" };
      return;
    }

    const owner = ctx.state.user;

    // Verify ownership
    const restaurant = await getRestaurant(restaurantId);
    if (!restaurant || (restaurant as any).ownerId !== owner.id) {
      ctx.response.status = 403;
      ctx.response.body = { error: "Forbidden" };
      return;
    }

    const sections = await listFloorSections(restaurantId);
    ctx.response.body = sections;
  }
);

// POST /api/floor-sections/:restaurantId - Create section
ownerFloorRouter.post(
  "/api/floor-sections/:restaurantId",
  async (ctx) => {
    if (!requireOwner(ctx)) return;

    const restaurantId = ctx.params.restaurantId;
    if (!restaurantId) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Missing restaurant ID" };
      return;
    }

    const owner = ctx.state.user;

    // Verify ownership
    const restaurant = await getRestaurant(restaurantId);
    if (!restaurant || (restaurant as any).ownerId !== owner.id) {
      ctx.response.status = 403;
      ctx.response.body = { error: "Forbidden" };
      return;
    }

    const body = await (ctx.request as any).originalRequest?.json?.().catch?.(() => null)
      ?? await (async () => {
        try {
          const b = (ctx.request as any).body?.({ type: "json" });
          return b ? await b.value : null;
        } catch {
          return null;
        }
      })()
      ?? {};

    const { name, gridRows, gridCols, displayOrder } = body as any;

    if (!name || !gridRows || !gridCols) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Missing required fields: name, gridRows, gridCols" };
      return;
    }

    const section = await createFloorSection({
      restaurantId,
      name,
      gridRows: Number(gridRows),
      gridCols: Number(gridCols),
      displayOrder: displayOrder ? Number(displayOrder) : 0,
    });

    ctx.response.status = 201;
    ctx.response.body = section;
  }
);

// PUT /api/floor-sections/:restaurantId/:sectionId - Update section
ownerFloorRouter.put(
  "/api/floor-sections/:restaurantId/:sectionId",
  async (ctx) => {
    if (!requireOwner(ctx)) return;

    const restaurantId = ctx.params.restaurantId;
    const sectionId = ctx.params.sectionId;

    if (!restaurantId || !sectionId) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Missing restaurant ID or section ID" };
      return;
    }

    const owner = ctx.state.user;

    // Verify ownership
    const restaurant = await getRestaurant(restaurantId);
    if (!restaurant || (restaurant as any).ownerId !== owner.id) {
      ctx.response.status = 403;
      ctx.response.body = { error: "Forbidden" };
      return;
    }

    const body = await (ctx.request as any).originalRequest?.json?.().catch?.(() => null)
      ?? await (async () => {
        try {
          const b = (ctx.request as any).body?.({ type: "json" });
          return b ? await b.value : null;
        } catch {
          return null;
        }
      })()
      ?? {};

    const updated = await updateFloorSection(restaurantId, sectionId, body as any);

    if (!updated) {
      ctx.response.status = 404;
      ctx.response.body = { error: "Section not found" };
      return;
    }

    ctx.response.body = updated;
  }
);

// DELETE /api/floor-sections/:restaurantId/:sectionId - Delete section
ownerFloorRouter.delete(
  "/api/floor-sections/:restaurantId/:sectionId",
  async (ctx) => {
    if (!requireOwner(ctx)) return;

    const restaurantId = ctx.params.restaurantId;
    const sectionId = ctx.params.sectionId;

    if (!restaurantId || !sectionId) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Missing restaurant ID or section ID" };
      return;
    }

    const owner = ctx.state.user;

    // Verify ownership
    const restaurant = await getRestaurant(restaurantId);
    if (!restaurant || (restaurant as any).ownerId !== owner.id) {
      ctx.response.status = 403;
      ctx.response.body = { error: "Forbidden" };
      return;
    }

    await deleteFloorSection(restaurantId, sectionId);
    ctx.response.body = { success: true };
  }
);

/* =================== MULTI-LAYOUT API =================== */

// GET /api/floor-layouts/:restaurantId - List all layouts for a restaurant
ownerFloorRouter.get(
  "/api/floor-layouts/:restaurantId",
  async (ctx) => {
    if (!requireOwner(ctx)) return;

    const restaurantId = ctx.params.restaurantId;
    if (!restaurantId) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Missing restaurant ID" };
      return;
    }

    const owner = ctx.state.user;

    // Verify ownership
    const restaurant = await getRestaurant(restaurantId);
    if (!restaurant || (restaurant as any).ownerId !== owner.id) {
      ctx.response.status = 403;
      ctx.response.body = { error: "Forbidden" };
      return;
    }

    const layouts = await listFloorLayouts(restaurantId);
    ctx.response.body = layouts;
  }
);

// GET /api/floor-layouts/:restaurantId/:layoutId - Get specific layout
ownerFloorRouter.get(
  "/api/floor-layouts/:restaurantId/:layoutId",
  async (ctx) => {
    if (!requireStaff(ctx)) return;

    const restaurantId = ctx.params.restaurantId;
    const layoutId = ctx.params.layoutId;

    if (!restaurantId || !layoutId) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Missing restaurant ID or layout ID" };
      return;
    }

    if (!(await requireRestaurantAccess(ctx, restaurantId))) return;

    const user = ctx.state.user;

    // Verify restaurant exists and user has access
    const restaurant = await getRestaurant(restaurantId);
    if (!restaurant) {
      ctx.response.status = 404;
      ctx.response.body = { error: "Restaurant not found" };
      return;
    }

    if (user.role === "owner") {
      if ((restaurant as any).ownerId !== user.id) {
        ctx.response.status = 403;
        ctx.response.body = { error: "Forbidden" };
        return;
      }
    }

    const layout = await getFloorLayout(restaurantId, layoutId);
    if (!layout) {
      ctx.response.status = 404;
      ctx.response.body = { error: "Layout not found" };
      return;
    }

    // Compute live table statuses
    const tableStatuses = await computeAllTableStatuses(restaurantId, layout.tables);

    ctx.response.body = {
      ...layout,
      tableStatuses,
    };
  }
);

// POST /api/floor-layouts/:restaurantId - Create new layout
ownerFloorRouter.post(
  "/api/floor-layouts/:restaurantId",
  async (ctx) => {
    if (!requireOwner(ctx)) return;

    const restaurantId = ctx.params.restaurantId;
    if (!restaurantId) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Missing restaurant ID" };
      return;
    }

    const owner = ctx.state.user;

    // Verify ownership
    const restaurant = await getRestaurant(restaurantId);
    if (!restaurant || (restaurant as any).ownerId !== owner.id) {
      ctx.response.status = 403;
      ctx.response.body = { error: "Forbidden" };
      return;
    }

    let body;
    try {
      body = await ctx.request.body.json();
    } catch (err) {
      console.error("[DEBUG] Body parsing error:", err);
      ctx.response.status = 400;
      ctx.response.body = { error: "Invalid JSON body" };
      return;
    }

    console.log("[DEBUG] POST /api/floor-layouts - Received body:", JSON.stringify(body));

    const { name, gridRows, gridCols, tables, objects, isActive } = body;

    console.log("[DEBUG] Extracted fields:", { name, gridRows, gridCols, tables, objects, isActive });

    if (!name || !gridRows || !gridCols) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Missing required fields: name, gridRows, gridCols" };
      return;
    }

    const layout = await createFloorLayout({
      restaurantId,
      name,
      gridRows: Number(gridRows),
      gridCols: Number(gridCols),
      tables: tables ?? [],
      objects: Array.isArray(objects) ? objects : [],
      isActive: isActive ?? false,
    });

    // Create table mappings if tables provided
    if (tables && Array.isArray(tables) && tables.length > 0) {
      await setTableMappingsFromFloorPlan(
        restaurantId,
        tables.map((t: any) => ({ id: t.id, tableNumber: t.tableNumber }))
      );
    }

    ctx.response.status = 201;
    ctx.response.body = layout;
  }
);

// PUT /api/floor-layouts/:restaurantId/:layoutId - Update layout
ownerFloorRouter.put(
  "/api/floor-layouts/:restaurantId/:layoutId",
  async (ctx) => {
    if (!requireOwner(ctx)) return;

    const restaurantId = ctx.params.restaurantId;
    const layoutId = ctx.params.layoutId;

    if (!restaurantId || !layoutId) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Missing restaurant ID or layout ID" };
      return;
    }

    const owner = ctx.state.user;

    // Verify ownership
    const restaurant = await getRestaurant(restaurantId);
    if (!restaurant || (restaurant as any).ownerId !== owner.id) {
      ctx.response.status = 403;
      ctx.response.body = { error: "Forbidden" };
      return;
    }

    let body;
    try {
      body = await ctx.request.body.json();
    } catch (err) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Invalid JSON body" };
      return;
    }

    const updated = await updateFloorLayout(restaurantId, layoutId, body);

    if (!updated) {
      ctx.response.status = 404;
      ctx.response.body = { error: "Layout not found" };
      return;
    }

    // Update table mappings if tables were modified
    if (body.tables && Array.isArray(body.tables)) {
      await setTableMappingsFromFloorPlan(
        restaurantId,
        body.tables.map((t: any) => ({ id: t.id, tableNumber: t.tableNumber }))
      );
    }

    ctx.response.body = updated;
  }
);

// DELETE /api/floor-layouts/:restaurantId/:layoutId - Delete layout
ownerFloorRouter.delete(
  "/api/floor-layouts/:restaurantId/:layoutId",
  async (ctx) => {
    if (!requireOwner(ctx)) return;

    const restaurantId = ctx.params.restaurantId;
    const layoutId = ctx.params.layoutId;

    if (!restaurantId || !layoutId) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Missing restaurant ID or layout ID" };
      return;
    }

    const owner = ctx.state.user;

    // Verify ownership
    const restaurant = await getRestaurant(restaurantId);
    if (!restaurant || (restaurant as any).ownerId !== owner.id) {
      ctx.response.status = 403;
      ctx.response.body = { error: "Forbidden" };
      return;
    }

    try {
      const deleted = await deleteFloorLayout(restaurantId, layoutId);
      if (!deleted) {
        ctx.response.status = 404;
        ctx.response.body = { error: "Layout not found" };
        return;
      }
      ctx.response.body = { success: true };
    } catch (err) {
      ctx.response.status = 400;
      ctx.response.body = { error: err instanceof Error ? err.message : String(err) };
    }
  }
);

// POST /api/floor-layouts/:restaurantId/:layoutId/activate - Set active layout
ownerFloorRouter.post(
  "/api/floor-layouts/:restaurantId/:layoutId/activate",
  async (ctx) => {
    if (!requireOwner(ctx)) return;

    const restaurantId = ctx.params.restaurantId;
    const layoutId = ctx.params.layoutId;

    if (!restaurantId || !layoutId) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Missing restaurant ID or layout ID" };
      return;
    }

    const owner = ctx.state.user;

    // Verify ownership
    const restaurant = await getRestaurant(restaurantId);
    if (!restaurant || (restaurant as any).ownerId !== owner.id) {
      ctx.response.status = 403;
      ctx.response.body = { error: "Forbidden" };
      return;
    }

    try {
      await setActiveFloorLayout(restaurantId, layoutId);
      ctx.response.body = { success: true };
    } catch (err) {
      ctx.response.status = 400;
      ctx.response.body = { error: err instanceof Error ? err.message : String(err) };
    }
  }
);

// GET /api/floor-layouts/:restaurantId/active - Get active layout
ownerFloorRouter.get(
  "/api/floor-layouts/:restaurantId/active",
  async (ctx) => {
    if (!requireStaff(ctx)) return;

    const restaurantId = ctx.params.restaurantId;
    if (!restaurantId) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Missing restaurant ID" };
      return;
    }

    const user = ctx.state.user;

    // Verify restaurant exists and user has access
    const restaurant = await getRestaurant(restaurantId);
    if (!restaurant) {
      ctx.response.status = 404;
      ctx.response.body = { error: "Restaurant not found" };
      return;
    }

    if (user.role === "owner") {
      if ((restaurant as any).ownerId !== user.id) {
        ctx.response.status = 403;
        ctx.response.body = { error: "Forbidden" };
        return;
      }
    }

    // --- DEBUG: helpful breadcrumbs for diagnosing missing active layouts ---
    // NOTE: We keep logs lightweight and avoid dumping full layout content.
    try {
      console.log("[FLOOR][ACTIVE] request", {
        restaurantId,
        userId: user?.id,
        role: user?.role,
      });
      const activeKey = ["active_floor_plan", restaurantId] as Deno.KvKey;
      const activeRes = await kv.get(activeKey);
      console.log("[FLOOR][ACTIVE] active_key", {
        restaurantId,
        activeLayoutId: activeRes.value ?? null,
      });
    } catch (_e) {
      // ignore logging failures
    }

    const layout = await getActiveFloorLayout(restaurantId);
    if (!layout) {
      ctx.response.status = 404;
      // Provide extra context to help the client understand WHAT is missing.
      // This is safe for staff users and contains no sensitive data.
      let layoutsCount = 0;
      let activeLayoutId: string | null = null;
      try {
        const all = await listFloorLayouts(restaurantId);
        layoutsCount = all.length;
        const activeRes = await kv.get(["active_floor_plan", restaurantId] as Deno.KvKey);
        activeLayoutId = (activeRes.value as string | null) ?? null;
      } catch (_e) {}
      ctx.response.body = {
        error: "No active layout found",
        debug: {
          restaurantId,
          layoutsCount,
          activeLayoutId,
          hint:
            layoutsCount === 0
              ? "No layouts exist yet for this restaurant. Create a layout in the editor first."
              : "Layouts exist but none is active. Activate one from the editor (or publish).",
        },
      };
      return;
    }

    // Compute live table statuses
    const tableStatuses = await computeAllTableStatuses(restaurantId, layout.tables);

    ctx.response.body = {
      ...layout,
      tableStatuses,
    };
  }
);

// GET /api/floor-layouts/:restaurantId/debug - Diagnostic endpoint (staff only)
// Helps troubleshoot: do layouts exist? is active key set? what IDs are stored?
ownerFloorRouter.get(
  "/api/floor-layouts/:restaurantId/debug",
  async (ctx) => {
    if (!requireStaff(ctx)) return;

    const restaurantId = ctx.params.restaurantId;
    if (!restaurantId) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Missing restaurant ID" };
      return;
    }

    if (!(await requireRestaurantAccess(ctx, restaurantId))) return;

    const restaurant = await getRestaurant(restaurantId);
    if (!restaurant) {
      ctx.response.status = 404;
      ctx.response.body = { error: "Restaurant not found" };
      return;
    }

    const user = ctx.state.user;
    const activeRes = await kv.get(["active_floor_plan", restaurantId] as Deno.KvKey);
    const activeLayoutId = (activeRes.value as string | null) ?? null;
    const layouts = await listFloorLayouts(restaurantId);

    ctx.response.body = {
      restaurantId,
      user: { id: user?.id ?? null, role: user?.role ?? null },
      activeLayoutId,
      layoutsCount: layouts.length,
      layouts: layouts.map((l) => ({
        id: l.id,
        name: l.name,
        isActive: !!l.isActive,
        updatedAt: l.updatedAt,
        tablesCount: Array.isArray((l as any).tables) ? (l as any).tables.length : 0,
        objectsCount: Array.isArray((l as any).objects) ? (l as any).objects.length : 0,
      })),
      note:
        layouts.length === 0
          ? "No layouts exist. Use the editor to create one."
          : activeLayoutId
            ? "Active key is set. /active should return the active layout."
            : "Active key is NOT set. Activating any layout should set it.",
    };
  }
);

// POST /api/floor-layouts/:restaurantId/:layoutId/duplicate - Duplicate layout
ownerFloorRouter.post(
  "/api/floor-layouts/:restaurantId/:layoutId/duplicate",
  async (ctx) => {
    if (!requireOwner(ctx)) return;

    const restaurantId = ctx.params.restaurantId;
    const layoutId = ctx.params.layoutId;

    if (!restaurantId || !layoutId) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Missing restaurant ID or layout ID" };
      return;
    }

    const owner = ctx.state.user;

    // Verify ownership
    const restaurant = await getRestaurant(restaurantId);
    if (!restaurant || (restaurant as any).ownerId !== owner.id) {
      ctx.response.status = 403;
      ctx.response.body = { error: "Forbidden" };
      return;
    }

    let body;
    try {
      body = await ctx.request.body.json();
    } catch (err) {
      body = {};
    }

    try {
      const newLayout = await duplicateFloorLayout(restaurantId, layoutId, body.name);
      ctx.response.status = 201;
      ctx.response.body = newLayout;
    } catch (err) {
      ctx.response.status = 400;
      ctx.response.body = { error: err instanceof Error ? err.message : String(err) };
    }
  }
);

export default ownerFloorRouter;
