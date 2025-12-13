// services/audit_log.ts
// --------------------------------------------------------
// Audit log (שלב 7.4): רישום פעולות ניהול עובדים ועוד.
// נשמר ב־Deno KV בפורמט append-only לפי מסעדה.
//
// Key scheme:
//   ["audit", restaurantId, ts, eventId] -> AuditEvent
//
// מאפשר שליפה לפי מסעדה (מהחדש לישן) עם limit.

import { kv, type User } from "../database.ts";

export type AuditAction =
  | "staff.created"
  | "staff.status_changed"
  | "staff.password_reset_link_created"
  | "staff.permissions_changed"
  | "staff.approval_changed";

export interface AuditEvent {
  id: string;
  ts: number;
  restaurantId: string;
  actorUserId: string;
  actorEmail?: string;
  action: AuditAction;
  targetType?: "staff" | "user";
  targetId?: string;
  meta?: Record<string, unknown>;
}

function now() {
  return Date.now();
}

/**
 * רישום אירוע Audit.
 * שים לב: זה append-only, אין עדכון/מחיקה.
 */
export async function logAuditEvent(args: {
  restaurantId: string;
  actor: Pick<User, "id" | "email">;
  action: AuditAction;
  targetType?: AuditEvent["targetType"];
  targetId?: string;
  meta?: AuditEvent["meta"];
}): Promise<AuditEvent> {
  const event: AuditEvent = {
    id: crypto.randomUUID(),
    ts: now(),
    restaurantId: args.restaurantId,
    actorUserId: args.actor.id,
    actorEmail: args.actor.email,
    action: args.action,
    targetType: args.targetType,
    targetId: args.targetId,
    meta: args.meta,
  };

  await kv.set(["audit", event.restaurantId, event.ts, event.id], event);
  return event;
}

/**
 * שליפת audit events למסעדה (מהחדש לישן).
 */
export async function listAuditEventsForRestaurant(restaurantId: string, limit = 50): Promise<AuditEvent[]> {
  const out: AuditEvent[] = [];

  // reverse: newest first
  for await (const row of kv.list<AuditEvent>({ prefix: ["audit", restaurantId] }, { reverse: true, limit })) {
    if (row.value) out.push(row.value);
  }

  return out;
}
