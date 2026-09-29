// src/routes/owner_hours.ts
// ניהול שעות פתיחה שבועיות למסעדה — בעלים בלבד
// שמירה ב-GET (/hours/save) דרך url.searchParams

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import {
  getRestaurant,
  updateRestaurant,
} from "../database.ts";
import { requireOwner } from "../lib/auth.ts";
import { debugLog } from "../lib/debug.ts";

import { parseHoursSettings } from "../lib/hours_settings.ts";

const ownerHoursRouter = new Router();

const DAY_LABELS = ["ראשון","שני","שלישי","רביעי","חמישי","שישי","שבת"] as const;

// ---------- GET: דף השעות ----------
ownerHoursRouter.get("/owner/restaurants/:id/hours", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const id = ctx.params.id!;
  debugLog("[owner_hours][GET] enter", { path: ctx.request.url.pathname, id });

  const r = await getRestaurant(id);
  debugLog("[owner_hours][GET] load", {
    id,
    found: !!r,
    ownerId: r?.ownerId,
    userId: (ctx.state as any)?.user?.id,
  });

  if (!r) {
    ctx.response.status = Status.NotFound;
    await render(ctx, "error", {
      title: "לא נמצא",
      message: "המסעדה לא נמצאה.",
    });
    return;
  }
  if (r.ownerId !== (ctx.state as any)?.user?.id) {
    ctx.response.status = Status.Forbidden;
    await render(ctx, "error", {
      title: "אין הרשאה",
      message: "אין הרשאה למסעדה זו.",
    });
    return;
  }

  const saved = ctx.request.url.searchParams.get("saved") === "1";
  await render(ctx, "owner_hours.eta", {
  page: "owner_hours",  
    restaurant: r,
    saved,
    dayLabels: DAY_LABELS,
  });
});

// ---------- GET: שמירה ----------
ownerHoursRouter.get("/owner/restaurants/:id/hours/save", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  if (!r) {
    ctx.response.status = Status.NotFound;
    await render(ctx, "error", {
      title: "לא נמצא",
      message: "המסעדה לא נמצאה.",
    });
    return;
  }
  if (r.ownerId !== (ctx.state as any)?.user?.id) {
    ctx.response.status = Status.Forbidden;
    await render(ctx, "error", {
      title: "אין הרשאה",
      message: "אין הרשאה למסעדה זו.",
    });
    return;
  }

  const sp = ctx.request.url.searchParams;
  let patch: Record<string, unknown>;
  try {
    patch = parseHoursSettings(sp, r.weeklySchedule as Record<string, unknown> || {});
  } catch {
    const lang = String(sp.get('lang') || (ctx.state as any).lang || 'en');
    const words = lang === 'he'
      ? ['ההגדרות לא נשמרו', 'בדקו את הקיבולת, מרווחי ההזמנה ומשך הישיבה. בכל יום פתוח נדרשות שעת פתיחה ושעת סגירה מאוחרת ממנה.']
      : lang === 'ka'
      ? ['პარამეტრები არ შენახულა', 'შეამოწმეთ ტევადობა, ჯავშნის ინტერვალი და ხანგრძლივობა. სამუშაო დღეებში დახურვის დრო გახსნის დროზე გვიან უნდა იყოს.']
      : ['Settings were not saved', 'Check capacity, booking interval and dining duration. Every open day needs an opening time and a later closing time.'];
    ctx.response.status = Status.BadRequest;
    await render(ctx, 'error', {title:words[0], message:words[1]});
    return;
  }

  debugLog("[owner_hours][SAVE][GET] patch", patch);

  await updateRestaurant(id, patch as any);

  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set(
    "Location",
    `/owner/restaurants/${encodeURIComponent(id)}/hours?saved=1&lang=${encodeURIComponent(sp.get("lang") || (ctx.state as any).lang || "en")}`,
  );
});

// ---------- POST (תאימות לאחור) ----------
ownerHoursRouter.post("/owner/restaurants/:id/hours", async (ctx) => {
  const id = ctx.params.id!;
  const sp = ctx.request.url.searchParams;
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set(
    "Location",
    `/owner/restaurants/${encodeURIComponent(id)}/hours/save?${sp.toString()}`,
  );
});

export default ownerHoursRouter;
export { ownerHoursRouter };

