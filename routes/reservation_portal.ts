// src/routes/reservation_portal.ts
// דף הזמנה ללקוח: אישור, ביטול, שינוי מועד — דרך קישור שנשלח במייל

import { Router, Status } from "jsr:@oak/oak";
import { verifyReservationToken } from "../lib/token.ts";
import {
  getRestaurant,
  // פונקציות זמינות קיימות בפרויקט – מתבססים עליהן:
  // קיימים לפי הקוד שלך: checkAvailability, listAvailableSlotsAround, type Reservation
  checkAvailability,
  listAvailableSlotsAround,
  type Reservation,
} from "../database.ts";

// ⚠️ ננסה לטעון פונקציות עדכון/שליפה להזמנה באופן בטוח (שמות נפוצים)
type DBExtra = Partial<{
  getReservation: (id: string) => Promise<Reservation | null>;
  getReservationById: (id: string) => Promise<Reservation | null>;
  updateReservation: (id: string, patch: Partial<Reservation>) => Promise<Reservation | null>;
  setReservationStatus: (id: string, status: string) => Promise<boolean>;
}>;
let _db: DBExtra | null = null;
async function db(): Promise<DBExtra> {
  if (_db) return _db;
  const mod = await import("../database.ts");
  _db = {
    getReservation: (mod as any).getReservation,
    getReservationById: (mod as any).getReservationById ?? (mod as any).getReservation,
    updateReservation: (mod as any).updateReservation,
    setReservationStatus: (mod as any).setReservationStatus,
  };
  return _db!;
}

const BASE_URL_ENV = Deno.env.get("APP_BASE_URL")?.replace(/\/+$/, "") ?? "";

function html(layout: { title: string; body: string }): string {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${layout.title}</title>
  <style>
    :root{--bg:#f6f7f9;--card:#fff;--ink:#111;--muted:#6b7280;--red:#b00020;--ok:#0a7a28}
    body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial}
    header{padding:14px 18px;background:#fff;border-bottom:1px solid #eee;position:sticky;top:0}
    main{max-width:760px;margin:18px auto;padding:0 14px}
    .card{background:#fff;border:1px solid #eee;border-radius:12px;padding:16px;margin:12px 0}
    .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
    .muted{color:var(--muted)}
    .btn{background:#111;color:#fff;border:none;border-radius:10px;padding:10px 14px;cursor:pointer;text-decoration:none;display:inline-block}
    .btn.ok{background:var(--ok)}
    .btn.warn{background:var(--red)}
    .btn.ghost{background:#f4f4f6;color:#111}
    input,select{border:1px solid #ddd;border-radius:8px;padding:8px 10px}
    .alert{border-radius:10px;padding:10px 12px;margin:10px 0}
    .alert.ok{background:#e7f7ec;border:1px solid #bde7c8}
    .alert.err{background:#fde7e9;border:1px solid #f4c2c7}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
    @media (max-width:800px){.grid{grid-template-columns:1fr}}
    .mono{font-family:ui-monospace,Consolas,monospace}
  </style>
</head>
<body>
  <header><strong>דף הזמנה</strong></header>
  <main>
    ${layout.body}
  </main>
</body>
</html>`;
}

function fmtDateTime(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${da}/${m}/${y} · ${hh}:${mi}`;
}

// --------------- Router ---------------
const reservationPortal = new Router();

// תצוגת ההזמנה
reservationPortal.get("/r/:token", async (ctx) => {
  const token = ctx.params.token!;
  const payload = await verifyReservationToken(token);
  if (!payload) {
    ctx.response.status = Status.Unauthorized;
    ctx.response.body = html({
      title: "קישור לא תקין",
      body: `<div class="card"><div class="alert err">הקישור פג תוקף או שגוי.</div></div>`,
    });
    return;
  }
  const { getReservation, getReservationById } = await db();
  const getRes = getReservationById ?? getReservation;
  if (typeof getRes !== "function") {
    ctx.response.status = Status.NotImplemented;
    ctx.response.body = html({
      title: "חסר יישום",
      body: `<div class="card"><div class="alert err">getReservationById/getReservation לא ממומש ב־database.ts</div></div>`,
    });
    return;
  }
  const r = await getRes(payload.rid);
  if (!r) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = html({ title: "לא נמצאה הזמנה", body: `<div class="card">ההזמנה לא נמצאה.</div>` });
    return;
  }
  const restaurant = r.restaurantId ? await getRestaurant(r.restaurantId) : null;
  const when = new Date(r.startTime ?? r.dateTime ?? r.datetime ?? r.date ?? Date.now());

  const origin = BASE_URL_ENV || `${ctx.request.url.protocol}//${ctx.request.url.host}`;
  const selfUrl = `${origin}/r/${encodeURIComponent(token)}`;

  const body = `
    <div class="card">
      <h2 style="margin-top:0">${restaurant?.name ?? "הזמנה"}</h2>
      <div class="muted">${restaurant?.city ?? ""} ${restaurant?.address ? "· " + restaurant.address : ""}</div>
      <p>מספר הזמנה: <span class="mono">${r.id}</span></p>
      <p>מועד נוכחי: <strong>${fmtDateTime(when)}</strong> · מספר סועדים: <strong>${r.partySize ?? r.size ?? r.guests ?? 2}</strong></p>
      <p>סטטוס: <strong>${r.status ?? "pending"}</strong></p>

      <div class="grid">
        <form method="post" action="${selfUrl}?action=confirm">
          <button class="btn ok" type="submit">אישור הזמנה</button>
        </form>

        <form method="post" action="${selfUrl}?action=cancel" onsubmit="return confirm('לבטל את ההזמנה?')">
          <button class="btn warn" type="submit">ביטול הזמנה</button>
        </form>
      </div>
    </div>

    <div class="card">
      <h3 style="margin-top:0">שינוי מועד</h3>
      <form method="post" action="${selfUrl}?action=reschedule" class="row">
        <label>תאריך <input type="date" name="date" required/></label>
        <label>שעה <input type="time" name="time" required/></label>
        <label>מס׳ סועדים <input type="number" name="party" min="1" step="1" value="${r.partySize ?? r.size ?? 2}" required/></label>
        <button class="btn" type="submit">בקש שינוי</button>
      </form>
      <p class="muted">טיפ: אם אין זמינות בשעה שביקשת, נציע חלופות קרובות.</p>
    </div>
  `;
  ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
  ctx.response.body = html({ title: "דף הזמנה", body });
});

// פעולות: אישור / ביטול / שינוי מועד
reservationPortal.post("/r/:token", async (ctx) => {
  const token = ctx.params.token!;
  const action = (ctx.request.url.searchParams.get("action") ?? "").toLowerCase();

  const payload = await verifyReservationToken(token);
  if (!payload) {
    ctx.response.status = Status.Unauthorized;
    ctx.response.body = html({ title: "קישור לא תקין", body: `<div class="card"><div class="alert err">הקישור פג תוקף או שגוי.</div></div>` });
    return;
  }

  const { getReservation, getReservationById, updateReservation, setReservationStatus } = await db();
  const getRes = getReservationById ?? getReservation;
  if (typeof getRes !== "function") {
    ctx.response.status = Status.NotImplemented;
    ctx.response.body = html({ title: "חסר יישום", body: `<div class="card"><div class="alert err">getReservationById/getReservation לא ממומש ב־database.ts</div></div>` });
    return;
  }

  const r = await getRes(payload.rid);
  if (!r) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = html({ title: "לא נמצאה הזמנה", body: `<div class="card">ההזמנה לא נמצאה.</div>` });
    return;
  }

  async function patchReservation(id: string, patch: Partial<Reservation>): Promise<boolean> {
    if (typeof updateReservation === "function") {
      const res = await updateReservation(id, patch);
      return !!res;
    }
    if (typeof setReservationStatus === "function" && patch.status) {
      return await setReservationStatus(id, String(patch.status));
    }
    // אם אין פונקציות עדכון—נחזיר 501
    return false;
  }

  if (action === "confirm") {
    const ok = await patchReservation(r.id, { status: "confirmed" as any });
    if (!ok) {
      ctx.response.status = Status.NotImplemented;
      ctx.response.body = html({ title: "לא נתמך", body: `<div class="card"><div class="alert err">updateReservation/setReservationStatus לא ממומש.</div></div>` });
      return;
    }
    ctx.response.body = html({ title: "הוזמן", body: `<div class="card"><div class="alert ok">ההזמנה אושרה בהצלחה 🎉</div><p>נפגש ב־<strong>${fmtDateTime(new Date(r.startTime))}</strong>.</p></div>` });
    return;
  }

  if (action === "cancel") {
    const ok = await patchReservation(r.id, { status: "canceled" as any });
    if (!ok) {
      ctx.response.status = Status.NotImplemented;
      ctx.response.body = html({ title: "לא נתמך", body: `<div class="card"><div class="alert err">updateReservation/setReservationStatus לא ממומש.</div></div>` });
      return;
    }
    ctx.response.body = html({ title: "בוטל", body: `<div class="card"><div class="alert ok">ההזמנה בוטלה. חבל לראות אותך הולך 😢</div></div>` });
    return;
  }

  if (action === "reschedule") {
    const body = ctx.request.body({ type: "form" });
    const data = await body.value;
    const date = String(data.get("date") ?? "");
    const time = String(data.get("time") ?? "");
    const party = Math.max(1, Number(data.get("party") ?? r.partySize ?? r.size ?? 2));

    // compose datetime (local)
    const iso = `${date}T${time}:00`;
    const newStart = new Date(iso);
    if (isNaN(newStart.getTime())) {
      ctx.response.status = Status.BadRequest;
      ctx.response.body = html({ title: "שגיאת קלט", body: `<div class="card"><div class="alert err">תאריך/שעה לא תקינים.</div></div>` });
      return;
    }

    // בדיקת זמינות
    const ok = await checkAvailability(r.restaurantId, newStart, party);
    if (!ok) {
      // הצעת חלופות
      const suggestions = await listAvailableSlotsAround(r.restaurantId, newStart, party, 6 /* עד 6 חלונות */);
      const list = (suggestions ?? []).map((s: { startTime: string | Date }) => {
        const d = new Date(s.startTime);
        return `<li>${fmtDateTime(d)}</li>`;
      }).join("") || "<li>אין חלופות קרובות</li>";
      ctx.response.body = html({
        title: "אין זמינות",
        body: `
          <div class="card">
            <div class="alert err">אין זמינות בשעה שביקשת.</div>
            <p>חלופות מוצעות:</p>
            <ul>${list}</ul>
            <p><a class="btn ghost" href="${ctx.request.url.pathname}">חזרה</a></p>
          </div>
        `
      });
      return;
    }

    // עדכון זמן ההזמנה
    const updated = await patchReservation(r.id, { startTime: newStart as any, partySize: party as any, status: (r.status ?? "pending") as any });
    if (!updated) {
      ctx.response.status = Status.NotImplemented;
      ctx.response.body = html({ title: "לא נתמך", body: `<div class="card"><div class="alert err">updateReservation/setReservationStatus לא ממומש.</div></div>` });
      return;
    }

    ctx.response.body = html({
      title: "בוצע שינוי",
      body: `<div class="card"><div class="alert ok">מועד ההזמנה עודכן ל־<strong>${fmtDateTime(newStart)}</strong>.</div></div>`
    });
    return;
  }

  // פעולה לא ידועה
  ctx.response.status = Status.BadRequest;
  ctx.response.body = html({ title: "פעולה לא מוכרת", body: `<div class="card"><div class="alert err">action לא נתמך.</div></div>` });
});

export { reservationPortal };
export default reservationPortal;
