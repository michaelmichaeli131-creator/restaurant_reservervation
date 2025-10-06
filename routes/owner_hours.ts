// src/routes/owner_hours.ts
// ניהול שעות פתיחה שבועיות למסעדה — בעלים בלבד
// שיפור עוקף-פרסרים: שמירה ב-GET (/hours/save) דרך url.searchParams

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

function buildWeeklyFromParams(sp: URLSearchParams): WeeklySchedule | undefined {
  let touched = false;
  const weekly: WeeklySchedule = {} as any;
  for (let d = 0 as DayOfWeek; d <= 6; d++) {
    const hasClosed = sp.has(`w${d}_closed`);
    const hasOpen = sp.has(`w${d}_open`);
    const hasClose = sp.has(`w${d}_close`);
    if (!hasClosed && !hasOpen && !hasClose) continue;
    touched = true;

    const closed = sp.get(`w${d}_closed`) === "on";
    const open = toHHMM(sp.get(`w${d}_open`));
    const close = toHHMM(sp.get(`w${d}_close`));

    if (closed) {
      weekly[d] = null;
    } else if (open && close && timeLT(open, close)) {
      weekly[d] = [{ open, close }];
    } else {
      weekly[d] = null;
    }
  }
  return touched ? weekly : undefined;
}

// ---------- GET: דף השעות ----------
ownerHoursRouter.get("/owner/restaurants/:id/hours", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const id = ctx.params.id!;
  debugLog("[owner_hours][GET] enter", { path: ctx.request.url.pathname, id });

  const r = await getRestaurant(id);
  debugLog("[owner_hours][GET] load", { id, found: !!r, ownerId: r?.ownerId, userId: (ctx.state as any)?.user?.id });

  if (!r) {
    ctx.response.status = Status.NotFound;
    await render(ctx, "error", { title: "לא נמצא", message: "המסעדה לא נמצאה." });
    return;
  }
  if (r.ownerId !== (ctx.state as any)?.user?.id) {
    ctx.response.status = Status.Forbidden;
    await render(ctx, "error", { title: "אין הרשאה", message: "אין הרשאה למסעדה זו." });
    return;
  }

  const saved = ctx.request.url.searchParams.get("saved") === "1";
  await render(ctx, "owner_hours.eta", {
    restaurant: r,
    saved,
    dayLabels: DAY_LABELS,
  });
});

// ---------- GET: שמירה (עוקף-פרסרים) ----------
ownerHoursRouter.get("/owner/restaurants/:id/hours/save", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  if (!r) {
    ctx.response.status = Status.NotFound;
    await render(ctx, "error", { title: "לא נמצא", message: "המסעדה לא נמצאה." });
    return;
  }
  if (r.ownerId !== (ctx.state as any)?.user?.id) {
    ctx.response.status = Status.Forbidden;
    await render(ctx, "error", { title: "אין הרשאה", message: "אין הרשאה למסעדה זו." });
    return;
  }

  const sp = ctx.request.url.searchParams;

  const patch: Partial<typeof r> = {};

  if (sp.has("capacity")) {
    const n = Number(sp.get("capacity"));
    if (Number.isFinite(n) && n > 0) patch.capacity = Math.floor(n);
  }
  if (sp.has("slotIntervalMinutes")) {
    const s = Number(sp.get("slotIntervalMinutes"));
    if (Number.isFinite(s) && s >= 5 && s <= 180) patch.slotIntervalMinutes = Math.floor(s);
  }

  const weekly = buildWeeklyFromParams(sp);
  if (weekly) patch.weeklySchedule = weekly;

  debugLog("[owner_hours][SAVE][GET] patch", patch);

  await updateRestaurant(id, patch as any);

  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", `/owner/restaurants/${encodeURIComponent(id)}/hours?saved=1`);
});

// ---------- POST (נשאר למי שמעדיף) ----------
ownerHoursRouter.post("/owner/restaurants/:id/hours", async (ctx) => {
  // נשאיר התאמה לאחור: פשוט נעביר לנתיב ה-GET עם אותם פרמטרים אם יש query (או נפנה חזרה לדף)
  const id = ctx.params.id!;
  const sp = ctx.request.url.searchParams;
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location",
    `/owner/restaurants/${encodeURIComponent(id)}/hours/save?${sp.toString()}`
  );
});

export default ownerHoursRouter;
export { ownerHoursRouter };
