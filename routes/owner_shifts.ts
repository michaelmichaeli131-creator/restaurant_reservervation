// routes/owner_shifts.ts
// Shift management API routes for restaurant owners

import { Router, Status } from "jsr:@oak/oak";
import { requireOwner } from "../lib/auth.ts";
import { getRestaurant } from "../database.ts";
import { render } from "../lib/view.ts";
import {
  createStaff,
  listStaff,
  getStaff,
  updateStaff,
  deleteStaff,
  createShiftTemplate,
  listShiftTemplates,
  deleteShiftTemplate,
  createShiftAssignment,
  getShiftAssignment,
  listShiftsByDate,
  listShiftsByStaff,
  checkInShift,
  checkOutShift,
  cancelShift,
  setStaffAvailability,
  getStaffAvailability,
  getShiftStats,
} from "../services/shift_service.ts";

export const ownerShiftsRouter = new Router();

/* =================== UI ROUTES =================== */

// GET /owner/restaurants/:id/shifts - Shift management page
ownerShiftsRouter.get("/owner/restaurants/:id/shifts", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const restaurantId = ctx.params.id;
  if (!restaurantId) {
    ctx.response.status = 400;
    ctx.response.body = "Missing restaurant ID";
    return;
  }

  const owner = ctx.state.user;

  // Verify ownership
  const restaurant = await getRestaurant(restaurantId);
  if (!restaurant || (restaurant as any).ownerId !== owner.id) {
    ctx.response.status = 403;
    ctx.response.body = "Forbidden";
    return;
  }

  await render(ctx, "owner_shifts", {
    user: owner,
    restaurantId,
    restaurant: restaurant,
  });
});

/* =================== STAFF MEMBER ROUTES =================== */

// GET /api/restaurants/:rid/staff - List all staff
ownerShiftsRouter.get("/api/restaurants/:rid/staff", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const rid = ctx.params.rid;
  const restaurant = await getRestaurant(rid);
  if (!restaurant || (restaurant as any).ownerId !== ctx.state.user.id) {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = { error: "Forbidden" };
    return;
  }

  const staff = await listStaff(rid);
  ctx.response.body = staff;
});

// POST /api/restaurants/:rid/staff - Create new staff member
ownerShiftsRouter.post("/api/restaurants/:rid/staff", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const rid = ctx.params.rid;
  const restaurant = await getRestaurant(rid);
  if (!restaurant || (restaurant as any).ownerId !== ctx.state.user.id) {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = { error: "Forbidden" };
    return;
  }

  const body = await ctx.request.body.json();
  if (!body.firstName || !body.lastName || !body.email || !body.role || !body.userId) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { error: "Missing required fields" };
    return;
  }

  const staff = await createStaff({
    restaurantId: rid,
    userId: body.userId,
    firstName: body.firstName,
    lastName: body.lastName,
    email: body.email,
    phone: body.phone,
    role: body.role,
    hourlyRate: body.hourlyRate,
  });

  ctx.response.status = Status.Created;
  ctx.response.body = staff;
});

// GET /api/restaurants/:rid/staff/:staffId - Get staff details
ownerShiftsRouter.get("/api/restaurants/:rid/staff/:staffId", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const rid = ctx.params.rid;
  const staffId = ctx.params.staffId;

  const restaurant = await getRestaurant(rid);
  if (!restaurant || (restaurant as any).ownerId !== ctx.state.user.id) {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = { error: "Forbidden" };
    return;
  }

  const staff = await getStaff(rid, staffId);
  if (!staff) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = { error: "Staff member not found" };
    return;
  }

  ctx.response.body = staff;
});

// PATCH /api/restaurants/:rid/staff/:staffId - Update staff
ownerShiftsRouter.patch("/api/restaurants/:rid/staff/:staffId", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const rid = ctx.params.rid;
  const staffId = ctx.params.staffId;

  const restaurant = await getRestaurant(rid);
  if (!restaurant || (restaurant as any).ownerId !== ctx.state.user.id) {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = { error: "Forbidden" };
    return;
  }

  const body = await ctx.request.body.json();
  const updated = await updateStaff(rid, staffId, body);

  if (!updated) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = { error: "Staff member not found" };
    return;
  }

  ctx.response.body = updated;
});

// DELETE /api/restaurants/:rid/staff/:staffId - Delete staff
ownerShiftsRouter.delete("/api/restaurants/:rid/staff/:staffId", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const rid = ctx.params.rid;
  const staffId = ctx.params.staffId;

  const restaurant = await getRestaurant(rid);
  if (!restaurant || (restaurant as any).ownerId !== ctx.state.user.id) {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = { error: "Forbidden" };
    return;
  }

  await deleteStaff(rid, staffId);
  ctx.response.status = Status.NoContent;
});

/* =================== SHIFT TEMPLATE ROUTES =================== */

// GET /api/restaurants/:rid/shift-templates - List shift templates
ownerShiftsRouter.get("/api/restaurants/:rid/shift-templates", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const rid = ctx.params.rid;
  const restaurant = await getRestaurant(rid);
  if (!restaurant || (restaurant as any).ownerId !== ctx.state.user.id) {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = { error: "Forbidden" };
    return;
  }

  const templates = await listShiftTemplates(rid);
  ctx.response.body = templates;
});

// POST /api/restaurants/:rid/shift-templates - Create shift template
ownerShiftsRouter.post("/api/restaurants/:rid/shift-templates", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const rid = ctx.params.rid;
  const restaurant = await getRestaurant(rid);
  if (!restaurant || (restaurant as any).ownerId !== ctx.state.user.id) {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = { error: "Forbidden" };
    return;
  }

  const body = await ctx.request.body.json();
  if (!body.name || !body.startTime || !body.endTime || !Array.isArray(body.daysOfWeek)) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { error: "Missing required fields" };
    return;
  }

  const template = await createShiftTemplate({
    restaurantId: rid,
    name: body.name,
    startTime: body.startTime,
    endTime: body.endTime,
    daysOfWeek: body.daysOfWeek,
    defaultStaffCount: body.defaultStaffCount,
  });

  ctx.response.status = Status.Created;
  ctx.response.body = template;
});

// DELETE /api/restaurants/:rid/shift-templates/:templateId
ownerShiftsRouter.delete("/api/restaurants/:rid/shift-templates/:templateId", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const rid = ctx.params.rid;
  const templateId = ctx.params.templateId;

  const restaurant = await getRestaurant(rid);
  if (!restaurant || (restaurant as any).ownerId !== ctx.state.user.id) {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = { error: "Forbidden" };
    return;
  }

  await deleteShiftTemplate(rid, templateId);
  ctx.response.status = Status.NoContent;
});

/* =================== SHIFT ASSIGNMENT ROUTES =================== */

// GET /api/restaurants/:rid/shifts?date=YYYY-MM-DD - List shifts for a date
ownerShiftsRouter.get("/api/restaurants/:rid/shifts", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const rid = ctx.params.rid;
  const date = ctx.request.url.searchParams.get("date");

  if (!date) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { error: "Missing date parameter" };
    return;
  }

  const restaurant = await getRestaurant(rid);
  if (!restaurant || (restaurant as any).ownerId !== ctx.state.user.id) {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = { error: "Forbidden" };
    return;
  }

  const shifts = await listShiftsByDate(rid, date);
  const staff = await listStaff(rid);
  const staffMap = new Map(staff.map((s) => [s.id, s]));

  // Enrich shifts with staff details
  const enriched = shifts.map((shift) => ({
    ...shift,
    staffName: staffMap.get(shift.staffId)?.firstName + " " + staffMap.get(shift.staffId)?.lastName,
    staffRole: staffMap.get(shift.staffId)?.role,
  }));

  ctx.response.body = enriched;
});

// POST /api/restaurants/:rid/shifts - Create shift assignment
ownerShiftsRouter.post("/api/restaurants/:rid/shifts", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const rid = ctx.params.rid;
  const restaurant = await getRestaurant(rid);
  if (!restaurant || (restaurant as any).ownerId !== ctx.state.user.id) {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = { error: "Forbidden" };
    return;
  }

  const body = await ctx.request.body.json();
  if (!body.staffId || !body.date || !body.startTime || !body.endTime) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { error: "Missing required fields" };
    return;
  }

  const assignment = await createShiftAssignment({
    restaurantId: rid,
    staffId: body.staffId,
    shiftTemplateId: body.shiftTemplateId,
    date: body.date,
    startTime: body.startTime,
    endTime: body.endTime,
    tablesAssigned: body.tablesAssigned,
  });

  ctx.response.status = Status.Created;
  ctx.response.body = assignment;
});

// POST /api/restaurants/:rid/shifts/:shiftId/check-in - Check in to shift
ownerShiftsRouter.post("/api/restaurants/:rid/shifts/:shiftId/check-in", async (ctx) => {
  const rid = ctx.params.rid;
  const shiftId = ctx.params.shiftId;

  const body = await ctx.request.body.json();
  const assignment = await checkInShift(rid, shiftId, body?.notes);

  if (!assignment) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = { error: "Shift not found" };
    return;
  }

  ctx.response.body = assignment;
});

// POST /api/restaurants/:rid/shifts/:shiftId/check-out - Check out from shift
ownerShiftsRouter.post("/api/restaurants/:rid/shifts/:shiftId/check-out", async (ctx) => {
  const rid = ctx.params.rid;
  const shiftId = ctx.params.shiftId;

  const assignment = await checkOutShift(rid, shiftId);

  if (!assignment) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = { error: "Shift not found" };
    return;
  }

  ctx.response.body = assignment;
});

// DELETE /api/restaurants/:rid/shifts/:shiftId - Cancel shift
ownerShiftsRouter.delete("/api/restaurants/:rid/shifts/:shiftId", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const rid = ctx.params.rid;
  const shiftId = ctx.params.shiftId;

  const restaurant = await getRestaurant(rid);
  if (!restaurant || (restaurant as any).ownerId !== ctx.state.user.id) {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = { error: "Forbidden" };
    return;
  }

  const assignment = await cancelShift(rid, shiftId);
  if (!assignment) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = { error: "Shift not found" };
    return;
  }

  ctx.response.body = assignment;
});

/* =================== STATS ROUTES =================== */

// GET /api/restaurants/:rid/shift-stats?date=YYYY-MM-DD - Get shift statistics
ownerShiftsRouter.get("/api/restaurants/:rid/shift-stats", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const rid = ctx.params.rid;
  const date = ctx.request.url.searchParams.get("date");

  if (!date) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { error: "Missing date parameter" };
    return;
  }

  const restaurant = await getRestaurant(rid);
  if (!restaurant || (restaurant as any).ownerId !== ctx.state.user.id) {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = { error: "Forbidden" };
    return;
  }

  const stats = await getShiftStats(rid, date);
  ctx.response.body = stats;
});

export default ownerShiftsRouter;
