// services/shift_service.ts
// Shift management business logic

import { kv } from "../database.ts";
import type { StaffMember, ShiftTemplate, ShiftAssignment, StaffAvailability } from "../database.ts";

// =========== Key Helpers ===========

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

function kShiftAssignmentByDate(restaurantId: string, date: string): Deno.KvKey {
  return ["shift_assignment_by_date", restaurantId, date];
}

function kShiftAssignmentByStaff(staffId: string, date: string): Deno.KvKey {
  return ["shift_assignment_by_staff", staffId, date];
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

  // Store by ID and by date for easy querying
  const tx = kv.atomic()
    .set(kShiftAssignment(data.restaurantId, id), assignment)
    .set(kShiftAssignmentByDate(data.restaurantId, data.date), assignment)
    .set(kShiftAssignmentByStaff(data.staffId, data.date), assignment);

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

  await kv.set(kShiftAssignment(restaurantId, assignmentId), updated);
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

  await kv.set(kShiftAssignment(restaurantId, assignmentId), updated);
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

  await kv.set(kShiftAssignment(restaurantId, assignmentId), updated);
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
