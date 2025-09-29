// src/routes/admin.ts
import { Router, Status } from "jsr:@oak/oak";
import {
  listRestaurants,
  getRestaurant,
  updateRestaurant,
  type Restaurant,
} from "../database.ts";

const ADMIN_SECRET = Deno.env.get("ADMIN_SECRET") ?? "";

/** Helper: קריאת טופס בצורה תואמת ל-Oak v17 וגם לגרסאות ישנות יותר */
async function readForm(ctx: any): Promise<FormData | URLSearchParams> {
  const reqAny = (ctx.request as any);

  // Oak v17+ (Web API):
  if (typeof reqAny.formData === "function") {
    try {
      const fd = await reqAny.formData();
      if (fd) return fd as FormData;
    } catch { /* ignore */ }
  }

  // Oak ישן (body() כפונקציה):
  if (typeof reqAny.body === "function") {
    try {
      const body = reqAny.body({ type: "form" });
      const val = await body.value; // URLSearchParams
      if (val) return val as URLSearchParams;
    } catch { /* ignore */ }
  }

  // fallback: x-www-form-urlencoded כטקסט
  try {
    if (typeof reqAny.text === "function") {
      const text = await reqAny.text();
      return new URLSearchParams(text ?? "");
    }
  } catch {}

  // ברירת מחדל: פרמטרי ה-URL
  return new URLSearchParams(ctx.request.url.searchParams);
}

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
    .card{border:1px solid #eee;border-radius:12px;padding:16px}
    .muted{color:#777}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}
    @media (max-width:800px){.grid{grid-template-columns:1fr}}
    input[type="password"],input[type="text"]{border:1px solid #ddd;border-radius:8px;padding:8px 10px;width:280px;max-width:100%}
    form.inline{display:inline}
    .badge{display:inline-block;background:#eef;border:1px solid #ccd;border-radius:6px;padding:2px 6px;font-size:12px;margin-inline-start:6px}
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
            : `<form class="inline" method="post" action="/admin/restaurants/${r.id}/approve?key=${encodeURIComponent(key)}">
                 <button class="btn" type="submit">אשר מסעדה</button>
               </form>`
        }
        <a class="btn secondary" href="/restaurants/${r.id}" target="_blank" rel="noopener">פתח דף מסעדה</a>
      </div>
    </td>
  </tr>`;
}

// <<< שינוי כאן: יצירה בלי export בקצה ההצהרה
const adminRouter = new Router();

// --------- Admin Login (GET) ----------
adminRouter.get("/admin/login", (ctx) => {
  const body = `
  <div class="card" style="max-width:520px">
    <h2 style="margin-top:0">כניסת אדמין</h2>
    <p class="muted">הזן/ני את מפתח האדמין (ADMIN_SECRET) שקבעת ב־Environment Variables.</p>
    <form method="post" action="/admin/login">
      <label for="key">מפתח אדמין</label><br/>
      <input id="key" name="key" type="password" placeholder="הדבק כאן את המפתח" required/>
      <button class="btn" type="submit" style="margin-inline-start:8px">כניסה</button>
    </form>
    <p class="muted" style="margin-top:10px">לא מוגדר? ב־Deno Deploy: Settings → Environment Variables → ADMIN_SECRET</p>
  </div>`;
  ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
  ctx.response.body = page({ title: "כניסת אדמין", body });
});

// --------- Admin Login (POST) ----------
adminRouter.post("/admin/login", async (ctx) => {
  const form = await readForm(ctx);
  const key = (form instanceof URLSearchParams ? form.get("key") : (form as FormData).get("key")) ?? "";
  const val = key.toString().trim();

  if (!ADMIN_SECRET || val !== ADMIN_SECRET) {
    ctx.response.status = Status.Unauthorized;
    ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
    ctx.response.body = page({
      title: "כניסת אדמין",
      body: `<div class="card" style="max-width:520px">
        <h2 style="margin-top:0">כניסת אדמין</h2>
        <p style="color:#c00">מפתח אדמין לא תקין.</p>
        <form method="post" action="/admin/login">
          <label for="key">מפתח אדמין</label><br/>
          <input id="key" name="key" type="password" required/>
          <button class="btn" type="submit" style="margin-inline-start:8px">נסיון נוסף</button>
        </form>
      </div>`,
    });
    return;
  }
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", `/admin?key=${encodeURIComponent(val)}`);
});

// --------- Dashboard ----------
adminRouter.get("/admin", async (ctx) => {
  if (!assertAdmin(ctx)) return;
  const key = getAdminKey(ctx)!;
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
    נכנסת עם מפתח אדמין ב-<code>?key=${key.replace(/./g, "•")}</code>.
    אפשר גם לשלוח את המפתח בכותרת <code>x-admin-key</code> בבקשות POST.
  </p>`;
  ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
  ctx.response.body = page({ title: "לוח בקרה · Admin", body });
});

// --------- Approve / Unapprove ----------
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

// --------- Help (optional) ----------
adminRouter.get("/admin/help", (ctx) => {
  if (!assertAdmin(ctx)) return;
  const body = `
    <div class="card">
      <h2 style="margin-top:0">עזרה</h2>
      <ul>
        <li>כניסה: <code>/admin/login</code> ואז הכנסת המפתח.</li>
        <li>אפשר להגיע ישר: <code>/admin?key=ADMIN_SECRET</code></li>
        <li>ב־POST אפשר לשלוח בכותרת: <code>x-admin-key</code></li>
      </ul>
    </div>`;
  ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
  ctx.response.body = page({ title: "עזרה · Admin", body });
});

// <<< יצוא יחיד
export { adminRouter };
