// services/shift_service.ts
// Shift management business logic

import { kv } from "../database.ts";
import type { StaffMember, ShiftTemplate, ShiftAssignment, StaffAvailability, UserRestaurantRole } from "../database.ts";

// =========== Key Helpers ===========

function kUserRestaurantRole(userId: string, restaurantId: string): Deno.KvKey {
  return ["user_restaurant_role", userId, restaurantId];
}

function kUserRestaurantRoleByRestaurant(restaurantId: string): Deno.KvKey {
  return ["user_restaurant_role_by_restaurant", restaurantId];
}

function kStaff(restaurantId: string, staffId: string): Deno.KvKey {
  return ["staff", restaurantId, staffId];
}

function kStaffByRestaurant(restaurantId: string): Deno.KvKey {
  return ["staff", restaurantId];
}

function kShiftTemplate(restaurantId: string, templateId: string): Deno.KvKey {
  return ["shift_template", restaurantId, templateId];
}

function kShiftTemplateByRestaurant(restaurantId: string): Deno.KvKey {
  return ["shift_template", restaurantId];
}

function kShiftAssignment(restaurantId: string, assignmentId: string): Deno.KvKey {
  return ["shift_assignment", restaurantId, assignmentId];
}

function kShiftAssignmentByDate(
  restaurantId: string,
  date: string,
  assignmentId?: string,
): Deno.KvKey {
  // Prefix key: ["shift_assignment_by_date", rid, date]
  // Full index key: ["shift_assignment_by_date", rid, date, assignmentId]
  const base: Deno.KvKey = ["shift_assignment_by_date", restaurantId, date];
  if (assignmentId) return [...base, assignmentId] as Deno.KvKey;
  return base;
}

function kShiftAssignmentByStaff(
  staffId: string,
  date: string,
  assignmentId?: string,
): Deno.KvKey {
  // Prefix key: ["shift_assignment_by_staff", staffId, date]
  // Full index key: ["shift_assignment_by_staff", staffId, date, assignmentId]
  const base: Deno.KvKey = ["shift_assignment_by_staff", staffId, date];
  if (assignmentId) return [...base, assignmentId] as Deno.KvKey;
  return base;
}

function kAvailability(staffId: string, dayOfWeek: number): Deno.KvKey {
  return ["staff_availability", staffId, dayOfWeek];
}

// =========== STAFF MEMBER OPERATIONS ===========

export async function createStaff(data: {
  restaurantId: string;
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  role: string;
  hourlyRate?: number;
  hireDate?: number;
}): Promise<StaffMember> {
  const id = crypto.randomUUID();
  const staff: StaffMember = {
    id,
    restaurantId: data.restaurantId,
    userId: data.userId,
    firstName: data.firstName,
    lastName: data.lastName,
    email: data.email,
    phone: data.phone,
    role: data.role as any,
    hourlyRate: data.hourlyRate,
    status: "active",
    hireDate: data.hireDate || Date.now(),
    createdAt: Date.now(),
  };
  await kv.set(kStaff(data.restaurantId, id), staff);
  return staff;
}

export async function listStaff(restaurantId: string): Promise<StaffMember[]> {
  const staff: StaffMember[] = [];
  for await (const entry of kv.list({ prefix: kStaffByRestaurant(restaurantId) })) {
    if (entry.value) staff.push(entry.value as StaffMember);
  }
  return staff.sort((a, b) => a.createdAt - b.createdAt);
}

export async function getStaff(restaurantId: string, staffId: string): Promise<StaffMember | null> {
  const entry = await kv.get(kStaff(restaurantId, staffId));
  return (entry.value as StaffMember) || null;
}

export async function updateStaff(
  restaurantId: string,
  staffId: string,
  updates: Partial<StaffMember>,
): Promise<StaffMember | null> {
  const current = await getStaff(restaurantId, staffId);
  if (!current) return null;
  const updated = { ...current, ...updates };
  await kv.set(kStaff(restaurantId, staffId), updated);
  return updated;
}

export async function deleteStaff(restaurantId: string, staffId: string): Promise<void> {
  await kv.delete(kStaff(restaurantId, staffId));
}

// =========== SHIFT TEMPLATE OPERATIONS ===========

export async function createShiftTemplate(data: {
  restaurantId: string;
  name: string;
  startTime: string;
  endTime: string;
  daysOfWeek: number[];
  defaultStaffCount?: number;
}): Promise<ShiftTemplate> {
  const id = crypto.randomUUID();
  const template: ShiftTemplate = {
    id,
    restaurantId: data.restaurantId,
    name: data.name,
    startTime: data.startTime,
    endTime: data.endTime,
    daysOfWeek: data.daysOfWeek as any,
    defaultStaffCount: data.defaultStaffCount,
    createdAt: Date.now(),
  };
  await kv.set(kShiftTemplate(data.restaurantId, id), template);
  return template;
}

export async function listShiftTemplates(restaurantId: string): Promise<ShiftTemplate[]> {
  const templates: ShiftTemplate[] = [];
  for await (const entry of kv.list({ prefix: kShiftTemplateByRestaurant(restaurantId) })) {
    if (entry.value) templates.push(entry.value as ShiftTemplate);
  }
  return templates.sort((a, b) => a.createdAt - b.createdAt);
}

export async function getShiftTemplate(
  restaurantId: string,
  templateId: string,
): Promise<ShiftTemplate | null> {
  const entry = await kv.get(kShiftTemplate(restaurantId, templateId));
  return (entry.value as ShiftTemplate) || null;
}

export async function deleteShiftTemplate(restaurantId: string, templateId: string): Promise<void> {
  await kv.delete(kShiftTemplate(restaurantId, templateId));
}

// =========== SHIFT ASSIGNMENT OPERATIONS ===========

export async function createShiftAssignment(data: {
  restaurantId: string;
  staffId: string;
  shiftTemplateId?: string;
  date: string;
  startTime: string;
  endTime: string;
  tablesAssigned?: string[];
}): Promise<ShiftAssignment> {
  const id = crypto.randomUUID();
  const assignment: ShiftAssignment = {
    id,
    restaurantId: data.restaurantId,
    staffId: data.staffId,
    shiftTemplateId: data.shiftTemplateId,
    date: data.date,
    startTime: data.startTime,
    endTime: data.endTime,
    status: "scheduled",
    tablesAssigned: data.tablesAssigned,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  // Store by ID and by date/staff for easy querying (INDEX KEYS include assignmentId)
  const tx = kv.atomic()
    .set(kShiftAssignment(data.restaurantId, id), assignment)
    .set(kShiftAssignmentByDate(data.restaurantId, data.date, id), assignment)
    .set(kShiftAssignmentByStaff(data.staffId, data.date, id), assignment);

  await tx.commit();
  return assignment;
}

export async function getShiftAssignment(
  restaurantId: string,
  assignmentId: string,
): Promise<ShiftAssignment | null> {
  const entry = await kv.get(kShiftAssignment(restaurantId, assignmentId));
  return (entry.value as ShiftAssignment) || null;
}

export async function listShiftsByDate(
  restaurantId: string,
  date: string,
): Promise<ShiftAssignment[]> {
  const shifts: ShiftAssignment[] = [];
  for await (const entry of kv.list({ prefix: kShiftAssignmentByDate(restaurantId, date) })) {
    if (entry.value) shifts.push(entry.value as ShiftAssignment);
  }
  return shifts.sort((a, b) => a.startTime.localeCompare(b.startTime));
}

export async function listShiftsByStaff(staffId: string, date: string): Promise<ShiftAssignment[]> {
  const shifts: ShiftAssignment[] = [];
  for await (const entry of kv.list({ prefix: kShiftAssignmentByStaff(staffId, date) })) {
    if (entry.value) shifts.push(entry.value as ShiftAssignment);
  }
  return shifts;
}

export async function checkInShift(
  restaurantId: string,
  assignmentId: string,
  notes?: string,
): Promise<ShiftAssignment | null> {
  const assignment = await getShiftAssignment(restaurantId, assignmentId);
  if (!assignment) return null;

  const updated: ShiftAssignment = {
    ...assignment,
    status: "checked_in",
    checkedInAt: Date.now(),
    checkInNotes: notes,
    updatedAt: Date.now(),
  };

  await kv.atomic()
    .set(kShiftAssignment(restaurantId, assignmentId), updated)
    .set(kShiftAssignmentByDate(updated.restaurantId, updated.date, updated.id), updated)
    .set(kShiftAssignmentByStaff(updated.staffId, updated.date, updated.id), updated)
    .commit();

  return updated;
}

export async function checkOutShift(
  restaurantId: string,
  assignmentId: string,
): Promise<ShiftAssignment | null> {
  const assignment = await getShiftAssignment(restaurantId, assignmentId);
  if (!assignment) return null;

  const updated: ShiftAssignment = {
    ...assignment,
    status: "checked_out",
    checkedOutAt: Date.now(),
    updatedAt: Date.now(),
  };

  await kv.atomic()
    .set(kShiftAssignment(restaurantId, assignmentId), updated)
    .set(kShiftAssignmentByDate(updated.restaurantId, updated.date, updated.id), updated)
    .set(kShiftAssignmentByStaff(updated.staffId, updated.date, updated.id), updated)
    .commit();

  return updated;
}

export async function cancelShift(
  restaurantId: string,
  assignmentId: string,
): Promise<ShiftAssignment | null> {
  const assignment = await getShiftAssignment(restaurantId, assignmentId);
  if (!assignment) return null;

  const updated: ShiftAssignment = {
    ...assignment,
    status: "cancelled",
    updatedAt: Date.now(),
  };

  await kv.atomic()
    .set(kShiftAssignment(restaurantId, assignmentId), updated)
    .set(kShiftAssignmentByDate(updated.restaurantId, updated.date, updated.id), updated)
    .set(kShiftAssignmentByStaff(updated.staffId, updated.date, updated.id), updated)
    .commit();

  return updated;
}

// =========== AVAILABILITY OPERATIONS ===========

export async function setStaffAvailability(data: {
  staffId: string;
  restaurantId: string;
  dayOfWeek: number;
  available: boolean;
  preferredShift?: string;
  notes?: string;
}): Promise<StaffAvailability> {
  const id = crypto.randomUUID();
  const availability: StaffAvailability = {
    id,
    staffId: data.staffId,
    restaurantId: data.restaurantId,
    dayOfWeek: data.dayOfWeek as any,
    available: data.available,
    preferredShift: data.preferredShift as any,
    notes: data.notes,
    createdAt: Date.now(),
  };

  await kv.set(kAvailability(data.staffId, data.dayOfWeek), availability);
  return availability;
}

export async function getStaffAvailability(
  staffId: string,
  dayOfWeek: number,
): Promise<StaffAvailability | null> {
  const entry = await kv.get(kAvailability(staffId, dayOfWeek));
  return (entry.value as StaffAvailability) || null;
}

// =========== UTILITY FUNCTIONS ===========

export async function getShiftStats(
  restaurantId: string,
  date: string,
): Promise<{
  totalShifts: number;
  checkedIn: number;
  checkedOut: number;
  scheduled: number;
  staffByRole: Record<string, number>;
}> {
  const shifts = await listShiftsByDate(restaurantId, date);
  const staff = await listStaff(restaurantId);
  const staffMap = new Map(staff.map((s) => [s.id, s]));

  let checkedIn = 0;
  let checkedOut = 0;
  let scheduled = 0;
  const staffByRole: Record<string, number> = {};

  for (const shift of shifts) {
    if (shift.status === "checked_in") checkedIn++;
    else if (shift.status === "checked_out") checkedOut++;
    else if (shift.status === "scheduled") scheduled++;

    const s = staffMap.get(shift.staffId);
    if (s) {
      staffByRole[s.role] = (staffByRole[s.role] || 0) + 1;
    }
  }

  return {
    totalShifts: shifts.length,
    checkedIn,
    checkedOut,
    scheduled,
    staffByRole,
  };
}

// =========== USER RESTAURANT ROLE OPERATIONS ===========

export async function assignUserRole(data: {
  userId: string;
  restaurantId: string;
  role: "owner" | "manager" | "staff";
  assignedBy: string;
}): Promise<UserRestaurantRole> {
  const id = crypto.randomUUID();
  const urr: UserRestaurantRole = {
    id,
    userId: data.userId,
    restaurantId: data.restaurantId,
    role: data.role,
    assignedAt: Date.now(),
    assignedBy: data.assignedBy,
  };

  const primaryKey = kUserRestaurantRole(data.userId, data.restaurantId);
  const indexKey = [...kUserRestaurantRoleByRestaurant(data.restaurantId), id] as Deno.KvKey;

  await kv.atomic()
    .set(primaryKey, urr)
    .set(indexKey, urr)
    .commit();

  return urr;
}

export async function getUserRestaurantRole(userId: string, restaurantId: string): Promise<UserRestaurantRole | null> {
  const res = await kv.get(kUserRestaurantRole(userId, restaurantId));
  return res.value as UserRestaurantRole | null;
}

export async function listUsersByRestaurant(restaurantId: string): Promise<UserRestaurantRole[]> {
  const users: UserRestaurantRole[] = [];
  const iter = kv.list({ prefix: kUserRestaurantRoleByRestaurant(restaurantId) });
  for await (const res of iter) {
    if (res.value) users.push(res.value as UserRestaurantRole);
  }
  return users;
}

export async function removeUserRole(userId: string, restaurantId: string): Promise<void> {
  const urr = await getUserRestaurantRole(userId, restaurantId);
  if (!urr) return;

  const primaryKey = kUserRestaurantRole(userId, restaurantId);
  const indexKey = [...kUserRestaurantRoleByRestaurant(restaurantId), urr.id] as Deno.KvKey;

  await kv.atomic()
    .delete(primaryKey)
    .delete(indexKey)
    .commit();
}

// ===================== Availability helpers + Smart assignment (Step #2) =====================

function timeToMinutes(t: string): number {
  // "HH:mm"
  const [hh, mm] = (t || "").split(":").map((x) => Number(x));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return NaN;
  return hh * 60 + mm;
}

function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  const aS = timeToMinutes(aStart);
  const aE = timeToMinutes(aEnd);
  const bS = timeToMinutes(bStart);
  const bE = timeToMinutes(bEnd);
  if (![aS, aE, bS, bE].every(Number.isFinite)) return false;
  // overlap if intervals intersect
  return aS < bE && bS < aE;
}

function getDayOfWeekFromIsoDate(date: string): number | null {
  // date is "YYYY-MM-DD"
  const d = new Date(date + "T00:00:00");
  const dow = d.getDay(); // 0..6 (Sun..Sat)
  return Number.isFinite(dow) ? dow : null;
}

export async function listAvailabilityForStaff(
  staffId: string,
): Promise<(StaffAvailability | null)[]> {
  const out: (StaffAvailability | null)[] = [];
  for (let dow = 0; dow <= 6; dow++) {
    out.push(await getStaffAvailability(staffId, dow));
  }
  return out;
}

export async function listRestaurantAvailabilityMatrix(restaurantId: string) {
  const staff = await listStaff(restaurantId);
  const rows = [];
  for (const s of staff) {
    const days = await listAvailabilityForStaff(s.id);
    rows.push({
      staffId: s.id,
      firstName: s.firstName,
      lastName: s.lastName,
      role: s.role,
      email: s.email,
      days,
    });
  }
  return rows;
}

/**
 * Check if staff can be assigned to a shift without conflicts.
 * Rules:
 * 1) If there is an availability record for that day and available=false → block
 * 2) If there is time overlap with existing assignments on that date → block
 * Missing availability record == allowed (neutral).
 */
export async function canAssignStaffToShift(args: {
  restaurantId: string;
  staffId: string;
  date: string;
  startTime: string;
  endTime: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const dow = getDayOfWeekFromIsoDate(args.date);
  if (dow === null) {
    return { ok: false, reason: "Invalid date" };
  }

  // Availability (only blocks if explicitly marked unavailable)
  const avail = await getStaffAvailability(args.staffId, dow);
  if (avail && avail.available === false) {
    return { ok: false, reason: "Staff marked as unavailable for this day" };
  }

  // Overlaps on same day for same staff
  const existing = await listShiftsByStaff(args.staffId, args.date);
  for (const sh of existing) {
    if (overlaps(sh.startTime, sh.endTime, args.startTime, args.endTime)) {
      return { ok: false, reason: "Overlapping shift for this staff on the same date" };
    }
  }

  return { ok: true };
}

/**
 * Recommend staff for a desired shift.
 * Scoring:
 * - Not available (explicit) → excluded unless you want to include later
 * - Overlap → excluded
 * - Otherwise include, prioritize:
 *   1) explicit available record
 *   2) preferredShift match (soft)
 */
export async function recommendStaffForShift(args: {
  restaurantId: string;
  date: string;
  startTime: string;
  endTime: string;
  role?: string;
  limit?: number;
}) {
  const limit = typeof args.limit === "number" ? args.limit : 10;

  const dow = getDayOfWeekFromIsoDate(args.date);
  if (dow === null) return [];

  const staff = await listStaff(args.restaurantId);
  const candidates: Array<{
    staffId: string;
    firstName: string;
    lastName: string;
    role: string;
    email: string;
    score: number;
    availability: StaffAvailability | null;
  }> = [];

  for (const s of staff) {
    if (args.role && s.role !== args.role) continue;

    const can = await canAssignStaffToShift({
      restaurantId: args.restaurantId,
      staffId: s.id,
      date: args.date,
      startTime: args.startTime,
      endTime: args.endTime,
    });
    if (!can.ok) continue;

    const avail = await getStaffAvailability(s.id, dow);

    let score = 0;
    if (avail) score += 10;
    if (avail?.available) score += 10;

    // soft match preferredShift
    const pref = (avail?.preferredShift || "").toLowerCase();
    const startMin = timeToMinutes(args.startTime);
    if (Number.isFinite(startMin)) {
      if (pref === "morning" && startMin < 12 * 60) score += 2;
      if (pref === "afternoon" && startMin >= 12 * 60 && startMin < 17 * 60) score += 2;
      if (pref === "evening" && startMin >= 17 * 60) score += 2;
      if (pref === "closing" && startMin >= 20 * 60) score += 2;
    }

    candidates.push({
      staffId: s.id,
      firstName: s.firstName,
      lastName: s.lastName,
      role: s.role,
      email: s.email,
      score,
      availability: avail,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, limit);
}
