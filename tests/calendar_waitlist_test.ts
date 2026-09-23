import { kv } from "../database.ts";
import {
  createCalendarWaitlist,
  listCalendarWaitlist,
  markWaitlistConverted,
  updateCalendarWaitlistStatus,
  validateWaitlistDate,
  validateWaitlistInput,
} from "../services/calendar_waitlist.ts";

function assert(condition: unknown, explanation: string): asserts condition {
  if (!condition) throw new Error(explanation);
}

async function rejects(operation: () => Promise<unknown>, explanation: string) {
  try { await operation(); } catch (error) {
    if (error instanceof RangeError || error instanceof Error) return;
    throw error;
  }
  throw new Error(explanation);
}

Deno.test("Calendar v2 waitlist stays isolated from existing reservation data", async () => {
  const restaurantId = "calendar-v2-test-" + crypto.randomUUID();
  const otherRestaurantId = restaurantId + "-other";
  const date = "2026-11-12";
  const data = {
    date, time: "19:30", name: "Test Guest", phone: "+972 50 123 4567",
    people: 3, area: "Terrace", note: "A test request",
  };
  try {
    assert(validateWaitlistDate(date) === date, "valid date rejected");
    await rejects(async () => { validateWaitlistDate("2026-02-30"); }, "impossible day accepted");
    await rejects(async () => { validateWaitlistInput({ ...data, people: 0 }); }, "invalid party accepted");
    await rejects(async () => { validateWaitlistInput({ ...data, time: "25:70" }); }, "invalid time accepted");
    await rejects(async () => { validateWaitlistInput({ ...data, phone: "x" }); }, "invalid phone accepted");

    const first = await createCalendarWaitlist(restaurantId, data);
    const second = await createCalendarWaitlist(restaurantId, { ...data, time: "20:00" });
    assert(first.id !== second.id, "waitlist ids must be unique");
    assert(first.status === "waiting" && first.source === "staff", "initial status or source incorrect");
    assert((await listCalendarWaitlist(restaurantId, date)).length === 2, "entries not persisted");
    assert((await listCalendarWaitlist(otherRestaurantId, date)).length === 0, "restaurant data leaked");

    const offered = await updateCalendarWaitlistStatus(restaurantId, date, first.id, "offered");
    assert(offered?.status === "offered", "offered status not persisted");
    const waiting = await updateCalendarWaitlistStatus(restaurantId, date, first.id, "waiting");
    assert(waiting?.status === "waiting", "return to waiting failed");
    const cancelled = await updateCalendarWaitlistStatus(restaurantId, date, first.id, "cancelled");
    assert(cancelled?.status === "cancelled", "cancel did not persist");
    await rejects(
      () => updateCalendarWaitlistStatus(restaurantId, date, first.id, "offered"),
      "cancelled request was incorrectly reopened",
    );
    await rejects(
      () => markWaitlistConverted(restaurantId, date, second.id, crypto.randomUUID()),
      "converted an entry without a real reservation",
    );
    assert((await listCalendarWaitlist(restaurantId, date)).length === 2, "status changes deleted entries");
    assert((await listCalendarWaitlist(otherRestaurantId, date)).length === 0, "isolation failed");
  } finally {
    for await (const row of kv.list({ prefix: ["calendar_waitlist_v2", restaurantId] })) {
      await kv.delete(row.key);
    }
  }
});
