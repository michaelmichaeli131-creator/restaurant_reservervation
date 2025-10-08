// src/routes/admin_users.ts
import { Router, Status } from "jsr:@oak/oak";
import {
  listUsersWithRestaurants,   // [{...user, restaurants: Restaurant[]}]
  setUserActive,              // (userId: string, isActive: boolean) => Promise<boolean>
} from "../database.ts";

/* ========= Admin utils (תואם admin.ts) ========= */
const ADMIN_SECRET = Deno.env.get("ADMIN_SECRET") ?? "";
const BUILD_TAG = new Date().toISOString().slice(0,19).replace("T"," ");

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
function setNoStore(ctx: any) {
  ctx.response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  ctx.response.headers.set("Pragma", "no-cache");
  ctx.response.headers.set("Expires", "0");
}
function page(layout: { title: string; body: string; key?: string }) {
  const keyMasked = (layout.key ?? "").replace(/./g, "•");
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
    .debug{background:#fff8d6;border:1px solid #f1d17a;padding:8px 12px;border-radius:8px;margin:8px 0;color:#754c00}
    table{width:100%;border-collapse:collapse;margin-top:16px}
    th,td{border-bottom:1px solid #eee;padding:10px;vertical-align:top;text-align:right}
    th{background:#fafafa;font-weight:600}
    .row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
    .btn{display:inline-block;background:#111;color:#fff;border-radius:8px;padding:8px 12px;text-decoration:none;border:none;cursor:pointer}
    .btn.secondary{background:#555}
    .btn.warn{background:#b00020}
    .btn.ghost{background:#f4f4f6;color:#111}
    .card{border:1px solid #eee;border-radius:12px;padding:16px;background:#fff}
    .muted{color:#777}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}
    @media (max-width:1000px){.grid{grid-template-columns:1fr}}
    input[type="password"],input[type="text"]{border:1px solid #ddd;border-radius:8px;padding:8px 10px;width:280px;max-width:100%}
    form.inline{display:inline}
    .badge{display:inline-block;background:#eef;border:1px solid #ccd;border-radius:6px;padding:2px 6px;font-size:12px;margin-inline-start:6px}
    .code{font-family:ui-monospace,Consolas,monospace;background:#f6f6f8;border:1px solid #eee;border-radius:6px;padding:6px 8px;display:inline-block}
    .tabs{display:flex;gap:6px;margin:12px 0}
    .tab{padding:6px 10px;border:1px solid #ddd;border-radius:10px;text-decoration:none;color:#111;background:#f9f9fb}
    .tab.active{background:#111;color:#fff;border-color:#111}
  </style>
</head>
<body>
  <header>
    <h1 style="margin:0">GeoTable · ניהול</h1>
    <span class="pill"><small>ADMIN</small></span>
  </header>
  <div class="debug">Build: ${BUILD_TAG}</div>
  ${layout.body}
  <div class="muted" style="margin-top:18px">Key: ${keyMasked}</div>
</body>
</html>`;
}

/* ========= Users List page ========= */
const router = new Router();

router.get("/admin/users", async (ctx) => {
  if (!assertAdmin(ctx)) return;
  setNoStore(ctx);
  const key = getAdminKey(ctx)!;

  const users = await listUsersWithRestaurants(); // [{...user, restaurants: []}]
  const active = users.filter((u: any) => u.isActive !== false);
  const inactive = users.filter((u: any) => u.isActive === false);

  const rows = (list: any[]) => list.map((u: any) => `
    <tr>
      <td><strong>${(u.firstName ?? "") + " " + (u.lastName ?? "")}</strong><br/><small class="muted" dir="ltr">${u.email}</small></td>
      <td>${u.role ?? "user"} <span class="badge">${u.provider ?? "local"}</span>${u.emailVerified ? ' <span class="badge">מאומת</span>' : ''}</td>
      <td>${u.isActive === false ? "❌ מבוטל" : "✅ פעיל"}</td>
      <td>
        ${u.restaurants?.length
          ? u.restaurants.map((r: any) =>
              `<div><a href="/restaurants/${r.id}" target="_blank" rel="noopener">${r.name}</a></div>`
            ).join("")
          : `<span class="muted">אין</span>`}
      </td>
      <td>
        ${
          u.isActive === false
            ? `<form class="inline" method="post" action="/admin/users/${u.id}/activate?key=${encodeURIComponent(key)}">
                 <button class="btn" type="submit">הפעל</button>
               </form>`
            : `<form class="inline" method="post" action="/admin/users/${u.id}/deactivate?key=${encodeURIComponent(key)}" onsubmit="return confirm('לבטל את המשתמש ${u.email}?')">
                 <button class="btn warn" type="submit">בטל</button>
               </form>`
        }
      </td>
    </tr>
  `).join("");

  const body = `
  <section class="card" style="margin-bottom:20px">
    <div class="row" style="justify-content:space-between;align-items:center">
      <h2 style="margin:0">ניהול משתמשים</h2>
      <div class="tabs">
        <a class="tab" href="/admin?key=${encodeURIComponent(key)}">מסעדות</a>
        <a class="tab active" href="/admin/users?key=${encodeURIComponent(key)}">משתמשים</a>
        <a class="tab" href="/admin/tools?key=${encodeURIComponent(key)}">כלים</a>
      </div>
    </div>
  </section>

  <div class="grid">
    <section class="card">
      <h3 style="margin-top:0">משתמשים פעילים (${active.length})</h3>
      ${
        active.length === 0
          ? `<p class="muted">אין משתמשים פעילים.</p>`
          : `<table>
              <thead><tr><th>משתמש</th><th>תפקיד</th><th>סטטוס</th><th>מסעדות</th><th>פעולות</th></tr></thead>
              <tbody>${rows(active)}</tbody>
            </table>`
      }
    </section>

    <section class="card">
      <h3 style="margin-top:0">משתמשים מבוטלים (${inactive.length})</h3>
      ${
        inactive.length === 0
          ? `<p class="muted">אין משתמשים מבוטלים.</p>`
          : `<table>
              <thead><tr><th>משתמש</th><th>תפקיד</th><th>סטטוס</th><th>מסעדות</th><th>פעולות</th></tr></thead>
              <tbody>${rows(inactive)}</tbody>
            </table>`
      }
    </section>
  </div>`;

  ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
  ctx.response.body = page({ title: "Admin · Users", body, key });
});

/* ========= Actions: deactivate / activate ========= */
router.post("/admin/users/:id/deactivate", async (ctx) => {
  if (!assertAdmin(ctx)) return;
  setNoStore(ctx);
  const id = ctx.params.id!;
  await setUserActive(id, false);
  const key = getAdminKey(ctx)!;
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", `/admin/users?key=${encodeURIComponent(key)}`);
});

router.post("/admin/users/:id/activate", async (ctx) => {
  if (!assertAdmin(ctx)) return;
  setNoStore(ctx);
  const id = ctx.params.id!;
  await setUserActive(id, true);
  const key = getAdminKey(ctx)!;
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", `/admin/users?key=${encodeURIComponent(key)}`);
});

export { router as adminUsersRouter };
export default router;
