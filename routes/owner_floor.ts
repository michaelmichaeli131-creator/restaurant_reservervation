// routes/owner_floor.ts
// Floor plan management for restaurant owners

import { Router } from "@oak/oak";
import { requireOwner } from "../lib/auth.ts";
import { kv } from "../database.ts";
import { render } from "../lib/view.ts";

export const ownerFloorRouter = new Router();

// Helper to generate key for floor plan
function toKey(...parts: (string | number)[]): Deno.KvKey {
  return parts.map(String) as Deno.KvKey;
}

interface FloorTable {
  id: string;
  name: string;
  gridX: number;
  gridY: number;
  spanX: number;
  spanY: number;
  seats: number;
  shape: "square" | "round" | "rect" | "booth";
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
  }
);

/* =================== API Routes =================== */

// GET /api/floor-plans/:restaurantId - Get floor plan for restaurant
ownerFloorRouter.get(
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
    const restaurantKey = toKey("restaurant", restaurantId);
    const restaurant = await kv.get(restaurantKey);

    if (!restaurant.value || (restaurant.value as any).ownerId !== owner.id) {
      ctx.response.status = 403;
      ctx.response.body = { error: "Forbidden" };
      return;
    }

    // Get floor plan
    const floorPlanKey = toKey("floor_plan", restaurantId);
    const floorPlan = await kv.get(floorPlanKey);

    if (!floorPlan.value) {
      ctx.response.status = 404;
      ctx.response.body = { error: "Floor plan not found" };
      return;
    }

    ctx.response.body = floorPlan.value;
  }
);

// POST /api/floor-plans/:restaurantId - Save/update floor plan
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
    const restaurantKey = toKey("restaurant", restaurantId);
    const restaurant = await kv.get(restaurantKey);

    if (!restaurant.value || (restaurant.value as any).ownerId !== owner.id) {
      ctx.response.status = 403;
      ctx.response.body = { error: "Forbidden" };
      return;
    }

    // Parse request body
    const body = await ctx.request.body.json();

    // Validate floor plan data
    if (!body.name || !body.gridRows || !body.gridCols || !Array.isArray(body.tables)) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Invalid floor plan data" };
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
    await kv.set(indexKey, { id: floorPlan.id, name: floorPlan.name, updatedAt: now });

    ctx.response.status = 200;
    ctx.response.body = { success: true, floorPlan };
  }
);

export default ownerFloorRouter;
