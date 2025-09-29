// src/routes/admin.ts
import { Router, Status } from "jsr:@oak/oak";
import {
  listRestaurants,
  getRestaurant,
  updateRestaurant,
  type Restaurant,
} from "../database.ts";

const ADMIN_SECRET = Deno.env.get("ADMIN_SECRET") ?? "";

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

function html(layout: { title: string; body: string }) {
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
    .ok{color:#0a0}
    .warn{color:#b58900}
    .danger{color:#c00}
    .btn{display:inline-block;background:#111;color:#fff;border-radius:8px;padding:8px 12px;text-decoration:none;border:none;cursor:pointer}
    .btn.secondary{background:#555}
    .btn.link{background:transparent;color:#06c;text-decoration:underline;padding:0}
    form{display:inline}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}
    @media (max-width:800px){.grid{grid-template-columns:1fr}}
    small.mono{font-family:ui-monospace,Menlo,Consolas,monospace;color:#777}
    .muted{color:#777}
    .card{border:1px solid #eee;border-radius:12px;padding:16px}
    .badge{display:inline-block;background:#eef;border:1px solid #ccd;border-radius:6px;padding:2px 6px;font-size:12px;margin-inline-start:6px}
  </style>
</head>
<body>
  <header>
    <h1 style="margin:0">GeoTable · ניהול</h1>
    <span class="pill"><small class="mono">ADMIN</small></span>
  </header>
  ${layout.body}
</body>
</html>`;
}

function renderRestaurantRow(r: Restaurant, key: string) {
  const approved = r.approved ? "✅ מאושרת" : "⏳ ממתינה";
  const caps = `קיבולת: ${r.capacity} · סלוט: ${r.slotIntervalMinutes}ד' · שירות: ${r.serviceDurationMinutes}ד'`;
  return `
  <tr>
    <td><strong>${r.name}</strong><br/><small class="muted">${r.city} · ${r.address}</small></td>
    <td>${approved}<br/><small class="muted">${caps}</small></td>
    <td>
      <div class="row">
        ${
          r.approved
            ? `<span class="badge">פעילה</span>`
            : `<form method="post" action="/admin/restaurants/${r.id}/approve?key=${encodeURIComponent(key)}">
                 <button class="btn" type="submit">אשר מסעדה</button>
               </form>`
        }
        <a class="btn secondary" href="/restaurants/${r.id}" target="_blank" rel="noopener">פתח דף מסעדה</a>
      </div>
    </td>
  </tr>`;
}

export const adminRouter = new Router();

// דשבורד: מציג ממתינות/מאושרות, קישורי פעולה
adminRouter.get("/admin", async (ctx) => {
  if (!assertAdmin(ctx)) return;
  const key = getAdminKey(ctx)!;

  // כל המסעדות (כולל לא מאושרות)
  const all = await listRestaurants("", /*onlyApproved*/ false);
  const pending = all.filter((r) => !r.approved);
  const approved = all.filter((r) => r.approved);

  const body = `
  <div class="grid">
    <section class="card">
      <h2 style="margin-top:0">ממתינות לאישור (${pending.length})</h2>
      ${
        pending.length === 0
          ? `<p class="muted">אין מסעדות ממתינות כרגע.</p>`
          : `<table>
              <thead><tr><th>מסעדה</th><th>סטטוס</th><th>פעולות</th></tr></thead>
              <tbody>
                ${pending.map((r) => renderRestaurantRow(r, key)).join("")}
              </tbody>
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
              <tbody>
                ${approved.map((r) => renderRestaurantRow(r, key)).join("")}
              </tbody>
            </table>`
      }
    </section>
  </div>

  <p class="muted" style="margin-top:18px">
    נכנסת עם מפתח אדמין ב-<code>?key=${key.replace(/./g, "•")}</code>.
    אפשר גם לשלוח את המפתח בכותרת <code>x-admin-key</code> בבקשות POST.
  </p>
  `;

  ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
  ctx.response.body = html({ title: "לוח בקרה · Admin", body });
});

// אישור מסעדה (POST)
adminRouter.post("/admin/restaurants/:id/approve", async (ctx) => {
  if (!assertAdmin(ctx)) return;
  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  if (!r) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Restaurant not found";
    return;
  }
  await updateRestaurant(id, { approved: true });
  // חזרה לדשבורד — שומרים את ה-key ב-URL כדי שלא תאבד כניסה
  const key = getAdminKey(ctx)!;
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", `/admin?key=${encodeURIComponent(key)}`);
});

// ביטול אישור (הופך ללא מאושרת) — אופציונלי
adminRouter.post("/admin/restaurants/:id/unapprove", async (ctx) => {
  if (!assertAdmin(ctx)) return;
  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  if (!r) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Restaurant not found";
    return;
  }
  await updateRestaurant(id, { approved: false });
  const key = getAdminKey(ctx)!;
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", `/admin?key=${encodeURIComponent(key)}`);
});

// עמוד עזרה קטן לאדמין (אופציונלי)
adminRouter.get("/admin/help", (ctx) => {
  if (!assertAdmin(ctx)) return;
  const body = `
    <h2>עזרה</h2>
    <ul>
      <li>כדי להיכנס: <code>/admin?key=ADMIN_SECRET</code></li>
      <li>כדי לאשר מסעדה: לחצן "אשר מסעדה" בדשבורד.</li>
      <li>ניתן לשלוח את המפתח גם בכותרת <code>x-admin-key</code>.</li>
    </ul>`;
  ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
  ctx.response.body = html({ title: "עזרה · Admin", body });
});
