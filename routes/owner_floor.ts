// routes/owner_floor.ts
// Floor plan management for restaurant owners

import { Router } from "@oak/oak";
import { requireOwner, requireStaff } from "../lib/auth.ts";
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
  },
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

    const bodyObj = (ctx.request as any).body;
    const json = bodyObj && bodyObj.type === "json"
      ? await bodyObj.value
      : {};
    const { status } = json as { status?: string };

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
  },
);

// GET /api/floor-plans/:restaurantId - Get floor plan with live table statuses
ownerFloorRouter.get(
  "/api/floor-plans/:restaurantId",
  async (ctx) => {
    // *** שינוי: לפתוח גם ל-manager/staff, לא רק owner ***
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
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
      2,
      "0",
    )}-${String(d.getDate()).padStart(2, "0")}`;

    const allRes = await listReservationsFor(restaurantId, date);
    const nameByTable = new Map<number, string>();

    for (const res of (allRes ?? []) as any[]) {
      const st = String(res.status ?? "").toLowerCase();
      // נניח ש־arrived / seated = ישבו בשולחן
      if (st !== "arrived" && st !== "seated") continue;

      const tn = Number(
        res.tableNumber ??
          res.table ??
          res.tableNo ??
          res.table_id ??
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

    const tableStatuses: TableStatus[] = (baseStatuses as TableStatus[]).map(
      (ts) => {
        const tn = Number(ts.tableNumber);
        const gName = nameByTable.get(tn) ?? null;
        return {
          ...ts,
          guestName: gName,
        };
      },
    );

    // Return floor plan with live statuses + guestName
    ctx.response.body = {
      ...floorPlan,
      tableStatuses,
    };
  },
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
  },
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

    const bodyObj = (ctx.request as any).body;
    const body = bodyObj && bodyObj.type === "json" ? await bodyObj.value : {};

    // Validate floor plan data
    if (
      !body.name || !body.gridRows || !body.gridCols ||
      !Array.isArray(body.tables)
    ) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Invalid floor plan data" };
      return;
    }

    // Validate that all tables have tableNumber
    if (
      !body.tables.every((t: any) =>
        t.id && typeof t.tableNumber === "number"
      )
    ) {
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
      createdAt: existing.value ? (existing.value as any).createdAt : now,
      updatedAt: now,
    };

    // Save to KV
    await kv.set(floorPlanKey, floorPlan);

    // Also create index for listing
    const indexKey = toKey("floor_plan_by_restaurant", restaurantId, floorPlan.id);
    await kv.set(indexKey, {
      id: floorPlan.id,
      name: floorPlan.name,
      updatedAt: now,
    });

    // Create table mappings (tableNumber → tableId) for POS lookup
    await setTableMappingsFromFloorPlan(
      restaurantId,
      body.tables.map((t: any) => ({ id: t.id, tableNumber: t.tableNumber })),
    );

    // Compute and return live statuses
    const tableStatuses = await computeAllTableStatuses(
      restaurantId,
      body.tables,
    );

    ctx.response.status = 200;
    ctx.response.body = {
      success: true,
      floorPlan,
      tableStatuses,
    };
  },
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
  },
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

    const bodyObj = (ctx.request as any).body;
    const body = bodyObj && bodyObj.type === "json" ? await bodyObj.value : {};
    const { name, gridRows, gridCols, displayOrder } = body as {
      name?: string;
      gridRows?: number;
      gridCols?: number;
      displayOrder?: number;
    };

    if (!name || !gridRows || !gridCols) {
      ctx.response.status = 400;
      ctx.response.body = {
        error: "Missing required fields: name, gridRows, gridCols",
      };
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
  },
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
      ctx.response.body = {
        error: "Missing restaurant ID or section ID",
      };
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

    const bodyObj = (ctx.request as any).body;
    const body = bodyObj && bodyObj.type === "json" ? await bodyObj.value : {};
    const updated = await updateFloorSection(restaurantId, sectionId, body);

    if (!updated) {
      ctx.response.status = 404;
      ctx.response.body = { error: "Section not found" };
      return;
    }

    ctx.response.body = updated;
  },
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
      ctx.response.body = {
        error: "Missing restaurant ID or section ID",
      };
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
  },
);

export default ownerFloorRouter;
