// src/routes/owner_hours.ts
// ניהול שעות פתיחה שבועיות — גרסה פשוטה: טופס HTML רגיל (ללא JS)
// קורא form/x-www-form-urlencoded (או formData/json כפאלבק), שומר capacity/slot והשעות.

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import {
  getRestaurant,
  updateRestaurant,
  type WeeklySchedule,
  type DayOfWeek,
} from "../database.ts";
import { requireOwner } from "../lib/auth.ts";
import { debugLog } from "../lib/debug.ts";

const ownerHoursRouter = new Router();
const DAY_LABELS = ["ראשון","שני","שלישי","רביעי","חמישי","שישי","שבת"] as const;

function toHHMM(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const t = s.replace(".", ":");
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Math.max(0, Math.min(23, Number(m[1])));
  const mi = Math.max(0, Math.min(59, Number(m[2])));
  return `${String(h).padStart(2,"0")}:${String(mi).padStart(2,"0")}`;
}
function timeLT(a: string, b: string): boolean {
  const [h1,m1] = a.split(":").map(Number);
  const [h2,m2] = b.split(":").map(Number);
  return h1 < h2 || (h1 === h2 && m1 < m2);
}

// קריאת גוף: קודם form (oak), אח"כ formData/json (fetch) כפאלבק
async function readFormLike(ctx: any): Promise<Map<string,string>> {
  // oak form
  try {
    if (typeof ctx.request?.body === "function") {
      const b = ctx.request.body({ type: "form" });
      const form = await b.value;
      const map = new Map<string,string>();
      for (const [k, v] of form.entries()) map.set(k, String(v));
      return map;
    }
  } catch (e) {
    debugLog("[owner_hours][POST] oak form failed", String(e));
  }

  // fetch formData
  try {
    if (typeof ctx.request?.formData === "function") {
      const fd = await ctx.request.formData();
      const map = new Map<string,string>();
      for (const [k, v] of fd.entries()) if (typeof v === "string") map.set(k, v);
      return map;
    }
  } catch (e) {
    debugLog("[owner_hours][POST] fetch formData failed", String(e));
  }

  // json כפאלבק (אם בכל זאת שלחו JSON)
  try {
    const ct = ctx.request?.headers?.get?.("content-type") || "";
    if (ct.includes("application/json")) {
      const obj = await (typeof ctx.request?.json === "function" ? ctx.request.json() : Promise.resolve({}));
      const map = new Map<string,string>();
      for (const [k, v] of Object.entries(obj || {})) map.set(k, typeof v === "string" ? v : JSON.stringify(v));
      return map;
    }
  } catch (e) {
    debugLog("[owner_hours][POST] json fallback failed", String(e));
  }

  return new Map();
}

function buildWeeklyFromForm(form: Map<string,string>): WeeklySchedule | undefined {
  // אם אין אף שדה רלוונטי, נחזיר undefined (לא לשנות DB)
  let anyTouched = false;
  const weekly: WeeklySchedule = {} as any;

  for (let d = 0 as DayOfWeek; d <= 6; d++) {
    const hasClosed = form.has(`w${d}_closed`);
    const hasOpen = form.has(`w${d}_open`);
    const hasClose = form.has(`w${d}_close`);
    if (!hasClosed && !hasOpen && !hasClose) {
      continue; // לא נגעו ביום → לא משנים אותו
    }
    anyTouched = true;

    const closed = form.get(`w${d}_closed`) === "on";
    const open = toHHMM(form.get(`w${d}_open`));
    const close = toHHMM(form.get(`w${d}_close`));

    if (closed) {
      weekly[d] = null;
    } else if (open && close && timeLT(open, close)) {
      weekly[d] = [{ open, close }];
    } else {
      // נגעו ביום אבל נתנו ערכים לא חוקיים → נסגור מפורשות כדי לא להשאיר מצב עמום
      weekly[d] = null;
    }
  }

  return anyTouched ? weekly : undefined;
}

// --------- GET ----------
ownerHoursRouter.get("/owner/restaurants/:id/hours", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const id = ctx.params.id!;
  debugLog("[owner_hours][GET] enter", { path: ctx.request.url.pathname, id });

  const r = await getRestaurant(id);
  debugLog("[owner_hours][GET] load", { id, found: !!r, ownerId: r?.ownerId, userId: (ctx.state as any)?.user?.id });

  if (!r) { ctx.response.status = Status.NotFound; await render(ctx, "error", { title: "לא נמצא", message: "המסעדה לא נמצאה." }); return; }
  if (r.ownerId !== (ctx.state as any)?.user?.id) {
    ctx.response.status = Status.Forbidden; await render(ctx, "error", { title: "אין הרשאה", message: "אין הרשאה למסעדה זו." }); return;
  }

  const saved = ctx.request.url.searchParams.get("saved") === "1";
  await render(ctx, "owner_hours.eta", {
    restaurant: r,
    saved,
    dayLabels: DAY_LABELS,
  });
});

// --------- POST ----------
ownerHoursRouter.post("/owner/restaurants/:id/hours", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  if (!r) { ctx.response.status = Status.NotFound; await render(ctx, "error", { title: "לא נמצא", message: "המסעדה לא נמצאה." }); return; }
  if (r.ownerId !== (ctx.state as any)?.user?.id) {
    ctx.response.status = Status.Forbidden; await render(ctx, "error", { title: "אין הרשאה", message: "אין הרשאה למסעדה זו." }); return;
  }

  const form = await readFormLike(ctx);

  const patch: Partial<typeof r> = {};

  // capacity
  if (form.has("capacity")) {
    const n = Number(form.get("capacity"));
    if (Number.isFinite(n) && n > 0) patch.capacity = Math.floor(n);
  }

  // slot
  if (form.has("slotIntervalMinutes")) {
    const s = Number(form.get("slotIntervalMinutes"));
    if (Number.isFinite(s) && s >= 5 && s <= 180) patch.slotIntervalMinutes = Math.floor(s);
  }

  // weekly
  const weekly = buildWeeklyFromForm(form);
  if (weekly) patch.weeklySchedule = weekly;

  debugLog("[owner_hours][POST] patch", patch);

  await updateRestaurant(id, patch as any);

  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", `/owner/restaurants/${encodeURIComponent(id)}/hours?saved=1`);
});

export default ownerHoursRouter;
export { ownerHoursRouter };
