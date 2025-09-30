// src/routes/admin.ts
import { Router, Status } from "jsr:@oak/oak";
import {
  listRestaurants,
  getRestaurant,
  updateRestaurant,
  type Restaurant,
  // פונקציות איפוס מה-DB (אם הוספת לפי ההנחיות הקודמות)
  resetRestaurants,
  resetReservations,
  resetUsers,
  resetAll,
} from "../database.ts";

const ADMIN_SECRET = Deno.env.get("ADMIN_SECRET") ?? "";

// ------- utils -------
function getAdminKey(ctx: any): string | null {
  const urlKey = ctx.request.url.searchParams.get("key");
  const headerKey = ctx.request.headers.get("x-admin-key");
  return (urlKey ?? headerKey ?? "").trim() || null;
}

function assertAdmin(ctx: any): boolean {
  const key = getAdminKey(ctx);
  if (!ADMIN_SECRET || !key || key !== ADMIN_SECRET) {
    ctx.response.status = Status.Unauthorized;
    ctx.response.body = "Unauthorized (missing/invalid admin key)";
    return false;
  }
  return true;
}

function page(layout: { title: string; body: string }) {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${layout.title}</title>
  <link rel="stylesheet" href="/static/styles.css"/>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:1100px;margin:32px auto;padding:0 16px}
    header{display:flex;align-items:center;gap:12px;margin-bottom:20px}
    .pill{background:#eef;border:1px solid #ccd;border-radius:999px;padding:4px 10px;font-size:12px}
    table{width:100%;border-collapse:collapse;margin-top:16px}
    th,td{border-bottom:1px solid #eee;padding:10px;vertical-align:top;text-align:right}
    th{background:#fafafa;font-weight:600}
    .row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
    .btn{display:inline-block;background:#111;color:#fff;border-radius:8px;padding:8px 12px;text-decoration:none;border:none;cursor:pointer}
    .btn.secondary{background:#555}
    .btn.warn{background:#b00020}
    .card{border:1px solid #eee;border-radius:12px;padding:16px}
    .muted{color:#777}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}
    @media (max-width:800px){.grid{grid-template-columns:1fr}}
    input[type="password"],input[type="text"]{border:1px solid #ddd;border-radius:8px;padding:8px 10px;width:280px;max-width:100%}
    form.inline{display:inline}
    .badge{display:inline-block;background:#eef;border:1px solid #ccd;border-radius:6px;padding:2px 6px;font-size:12px;margin-inline-start:6px}
    .code{font-family:ui-monospace,Consolas,monospace;background:#f6f6f8;border:1px solid #eee;border-radius:6px;padding:6px 8px;display:inline-block}
  </style>
</head>
<body>
  <header>
    <h1 style="margin:0">GeoTable · ניהול</h1>
    <span class="pill"><small>ADMIN</small></span>
  </header>
  ${layout.body}
</body>
</html>`;
}

function renderRestaurantRow(r: Restaurant, key: string) {
  const approved = r.approved ? "✅ מאושרת" : "⏳ ממתינה";
  const caps = `קיבולת: ${r.capacity ?? "-"} · סלוט: ${r.slotIntervalMinutes ?? "-"}ד' · שירות: ${r.serviceDurationMinutes ?? "-"}ד'`;
  return `
  <tr>
    <td><strong>${r.name}</strong><br/><small class="muted">${r.city} · ${r.address}</small></td>
    <td>${approved}<br/><small class="muted">${caps}</small></td>
    <td>
      <div class="row">
        ${
          r.approved
            ? `<span class="badge">פעילה</span>`
            : `<form class="inline" method="post" action="/admin/restaurants/${r.id}/approve?key=${encodeURIComponent(key)}">
                 <button class="btn" type="submit">אשר מסעדה</button>
               </form>`
        }
        <a class="btn secondary" href="/restaurants/${r.id}" target="_blank" rel="noopener">פתח דף מסעדה</a>
      </div>
    </td>
  </tr>`;
}

// ------- router -------
const adminRouter = new Router();

/** מסך כניסה: GET -> שולח ל-/admin עם ?key= */
adminRouter.get("/admin/login", (ctx) => {
  const body = `
  <div class="card" style="max-width:520px">
    <h2 style="margin-top:0">כניסת אדמין</h2>
    <p class="muted">הזן/ני את מפתח האדמין (ADMIN_SECRET) שהוגדר ב־Environment Variables.</p>
    <form method="get" action="/admin">
      <label for="key">מפתח אדמין</label><br/>
      <input id="key" name="key" type="password" placeholder="הדבק כאן את המפתח" required/>
      <button class="btn" type="submit" style="margin-inline-start:8px">כניסה</button>
    </form>
    <p class="muted" style="margin-top:10px">אין יצירת משתמשים כאן — זו גישה עם מפתח בלבד.</p>
  </div>`;
  ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
  ctx.response.body = page({ title: "כניסת אדמין", body });
});

/** דשבורד אדמין */
adminRouter.get("/admin", async (ctx) => {
  if (!assertAdmin(ctx)) return;
  const key = getAdminKey(ctx)!;

  const all = await listRestaurants("", /*onlyApproved*/ false);
  const pending = all.filter((r) => !r.approved);
  const approved = all.filter((r) => r.approved);

  const body = `
  <!-- כפתורי איפוס בראש העמוד -->
  <section class="card" style="margin-bottom:20px">
    <h2 style="margin-top:0;color:#b00020">⚠️ פעולות אדמין (Reset)</h2>
    <div class="row" style="margin-top:6px">
      <form method="post" action="/admin/reset?what=restaurants&confirm=1&key=${encodeURIComponent(key)}">
        <button type="submit" class="btn warn"
          onclick="return confirm('לאפס את כל המסעדות? הפעולה בלתי הפיכה!')">
          איפוס כל המסעדות
        </button>
      </form>
      <form method="post" action="/admin/reset?what=reservations&confirm=1&key=${encodeURIComponent(key)}">
        <button type="submit" class="btn warn"
          onclick="return confirm('לאפס את כל ההזמנות?')">
          איפוס כל ההזמנות
        </button>
      </form>
      <form method="post" action="/admin/reset?what=users&confirm=1&key=${encodeURIComponent(key)}">
        <button type="submit" class="btn warn"
          onclick="return confirm('לאפס את כל המשתמשים? שים לב: זה ימחק גם בעלי מסעדות!')">
          איפוס כל המשתמשים
        </button>
      </form>
      <form method="post" action="/admin/reset?what=all&confirm=1&key=${encodeURIComponent(key)}">
        <button type="submit" class="btn warn"
          onclick="return confirm('איפוס כללי: משתמשים + מסעדות + הזמנות. להמשיך?')">
          איפוס כולל (הכול)
        </button>
      </form>
      <a class="btn secondary" href="/admin/tools?key=${encodeURIComponent(key)}">עוד כלים…</a>
    </div>
  </section>

  <div class="grid">
    <section class="card">
      <h2 style="margin-top:0">ממתינות לאישור (${pending.length})</h2>
      ${
        pending.length === 0
          ? `<p class="muted">אין מסעדות ממתינות כרגע.</p>`
          : `<table>
              <thead><tr><th>מסעדה</th><th>סטטוס</th><th>פעולות</th></tr></thead>
              <tbody>${pending.map((r) => renderRestaurantRow(r, key)).join("")}</tbody>
            </table>`
      }
    </section>

    <section class="card">
      <h2 style="margin-top:0">מאושרות (${approved.length})</h2>
      ${
        approved.length === 0
          ? `<p class="muted">עוד לא אושרו מסעדות.</p>`
          : `<table>
              <thead><tr><th>מסעדה</th><th>סטטוס</th><th>פעולות</th></tr></thead>
              <tbody>${approved.map((r) => renderRestaurantRow(r, key)).join("")}</tbody>
            </table>`
      }
    </section>
  </div>

  <p class="muted" style="margin-top:18px">
    נכנסת עם מפתח אדמין ב-<span class="code">?key=${key.replace(/./g, "•")}</span>.
    אפשר גם לשלוח את המפתח בכותרת <code>x-admin-key</code> בבקשות POST.
  </p>`;
  ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
  ctx.response.body = page({ title: "לוח בקרה · Admin", body });
});

/** עמוד כלים */
adminRouter.get("/admin/tools", (ctx) => {
  if (!assertAdmin(ctx)) return;
  const key = getAdminKey(ctx)!;
  const body = `
  <div class="card">
    <h2 style="margin-top:0">Reset · כלי אדמין</h2>
    <p class="muted">אפשר להריץ איפוסים דרך הקישורים הבאים (תופיע בקשת אישור).</p>
    <ul>
      <li><a class="btn warn" href="/admin/reset?what=reservations&key=${encodeURIComponent(key)}">אפס רק הזמנות</a></li>
      <li><a class="btn warn" href="/admin/reset?what=restaurants&key=${encodeURIComponent(key)}">אפס רק מסעדות</a></li>
      <li><a class="btn warn" href="/admin/reset?what=users&key=${encodeURIComponent(key)}">אפס רק משתמשים</a></li>
      <li><a class="btn warn" href="/admin/reset?what=all&key=${encodeURIComponent(key)}">אפס הכל</a></li>
    </ul>
  </div>`;
  ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
  ctx.response.body = page({ title: "Admin · Reset", body });
});

// מאחורי הקלעים נשתמש בפונקציה אחת גם ל-GET (אישור) וגם ל-POST (ביצוע)
async function handleReset(ctx: any) {
  if (!assertAdmin(ctx)) return;
  const key = getAdminKey(ctx)!;
  const url = ctx.request.url;
  const what = (url.searchParams.get("what") ?? "").toLowerCase();  // reservations | restaurants | users | all
  const confirm = url.searchParams.get("confirm") === "1";

  const actions: Record<string, () => Promise<any>> = {
    reservations: resetReservations,
    restaurants: resetRestaurants,
    users: resetUsers,
    all: resetAll,
  };

  if (!(what in actions)) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "bad 'what' (use: reservations|restaurants|users|all)";
    return;
  }

  if (!confirm && ctx.request.method === "GET") {
    const body = `
      <div class="card" style="max-width:680px">
        <h2 style="margin-top:0">אישור פעולה</h2>
        <p>האם לאפס את: <strong>${what}</strong>?</p>
        <div class="row">
          <a class="btn warn" href="/admin/reset?what=${encodeURIComponent(what)}&confirm=1&key=${encodeURIComponent(key)}">אשר מחיקה</a>
          <a class="btn secondary" href="/admin/tools?key=${encodeURIComponent(key)}">ביטול</a>
        </div>
      </div>`;
    ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
    ctx.response.body = page({ title: "אישור מחיקה · Admin", body });
    return;
  }

  // ביצוע (POST עם confirm=1, או GET עם confirm=1)
  const result = await actions[what]();
  const body = `
    <div class="card" style="max-width:720px">
      <h2 style="margin-top:0">הושלם</h2>
      <p>בוצע איפוס: <strong>${what}</strong></p>
      <pre class="code" style="white-space:pre-wrap">${JSON.stringify(result, null, 2)}</pre>
      <div class="row" style="margin-top:10px">
        <a class="btn" href="/admin/tools?key=${encodeURIComponent(key)}">חזרה לכלים</a>
        <a class="btn secondary" href="/admin?key=${encodeURIComponent(key)}">חזרה לדשבורד</a>
      </div>
    </div>`;
  ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
  ctx.response.body = page({ title: "הושלם · Reset", body });
}

/** מסכי אישור (GET) ואיפוס (POST) */
adminRouter.get("/admin/reset", handleReset);
adminRouter.post("/admin/reset", handleReset);

/** אישור/ביטול מסעדה */
adminRouter.post("/admin/restaurants/:id/approve", async (ctx) => {
  if (!assertAdmin(ctx)) return;
  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  if (!r) { ctx.response.status = Status.NotFound; ctx.response.body = "Restaurant not found"; return; }
  await updateRestaurant(id, { approved: true });
  const key = getAdminKey(ctx)!;
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", `/admin?key=${encodeURIComponent(key)}`);
});

adminRouter.post("/admin/restaurants/:id/unapprove", async (ctx) => {
  if (!assertAdmin(ctx)) return;
  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  if (!r) { ctx.response.status = Status.NotFound; ctx.response.body = "Restaurant not found"; return; }
  await updateRestaurant(id, { approved: false });
  const key = getAdminKey(ctx)!;
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", `/admin?key=${encodeURIComponent(key)}`);
});

export { adminRouter };
