// src/routes/admin.ts
import { Router, Status } from "jsr:@oak/oak";
import {
  listRestaurants,
  getRestaurant,
  updateRestaurant,
  type Restaurant,
  resetRestaurants,
  resetReservations,
  resetUsers,
  resetAll,
  deleteRestaurantCascade,
  // יכולות אופציונליות — נטענות דינמית
  // listUsersWithRestaurants,
  // listRestaurantsWithOwners,
  // setUserActive,
  // deleteUserCascade,
} from "../database.ts";

const ADMIN_SECRET = Deno.env.get("ADMIN_SECRET") ?? "";
const BUILD_TAG = new Date().toISOString().slice(0,19).replace("T"," ");

/* ================== טעינה דינמית של יכולות אופציונליות מה-DB ================== */
type DBExtra = {
  listUsersWithRestaurants?: (q?: string) => Promise<any[]>;
  listRestaurantsWithOwners?: (q?: string) => Promise<(Restaurant & { owner?: any | null })[]>;
  setUserActive?: (userId: string, isActive: boolean) => Promise<boolean>;
  deleteUserCascade?: (userId: string) => Promise<boolean | number>;
};
let _dbExtraCache: DBExtra | null = null;

async function getDbExtra(): Promise<DBExtra> {
  if (_dbExtraCache) return _dbExtraCache;
  try {
    const mod = await import("../database.ts");
    _dbExtraCache = {
      listUsersWithRestaurants: mod.listUsersWithRestaurants,
      listRestaurantsWithOwners: mod.listRestaurantsWithOwners,
      setUserActive: mod.setUserActive,
      deleteUserCascade: (mod as any).deleteUserCascade, // אופציונלי
    };
  } catch {
    _dbExtraCache = {};
  }
  return _dbExtraCache!;
}

/* ================== utils ================== */
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

/** תבנית עמוד — גרסת Luxury Dark (ללא /static/styles.css) */
function page(layout: { title: string; body: string; key?: string }) {
  const keyMasked = (layout.key ?? "").replace(/./g, "•");
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="color-scheme" content="dark light">
  <title>${layout.title}</title>

  <!-- עיצוב כהה חדש של SpotBook (תמיד נטען) -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Rubik:wght@300;400;500;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/public/css/spotbook.css?v=${encodeURIComponent(BUILD_TAG)}"/>

  <!-- סגנונות משלימים לאדמין: נשענים על טוקני spotbook.css (--bg, --panel, --bd, --ink, --ink-dim וכו') -->
  <style>
    :root{ --warn:#ef4444; --ok:#22c55e; --ink-dim:#98a2b3; }
    body.sb-body.admin{ margin:0; font-family:'Rubik',system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:var(--ink); }
    .wrap{ max-width:1100px; margin:0 auto; padding:0 16px; }

    /* Appbar */
    .appbar{ position:sticky; top:0; z-index:40; background:linear-gradient(180deg, rgba(10,13,18,.9), rgba(10,13,18,.6)); backdrop-filter:saturate(140%) blur(8px); border-bottom:1px solid var(--bd); }
    .appbar .row{ display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 0; }
    .brand{ display:flex; align-items:center; gap:10px; color:var(--ink); text-decoration:none; }
    .brand .dot{ width:10px; height:10px; border-radius:999px; background:#7dd3fc; box-shadow:0 0 20px rgba(125,211,252,.9); }
    .brand .name{ font-weight:800; letter-spacing:.3px; }

    /* Generic blocks */
    .muted{ color:var(--ink-dim); }
    .pill{ display:inline-block; background:rgba(125,211,252,.12); border:1px solid rgba(125,211,252,.35); border-radius:999px; padding:4px 10px; font-size:12px; }
    .debug{ background:rgba(251,191,36,.12); border:1px solid rgba(251,191,36,.35); padding:8px 12px; border-radius:10px; color:#e9d5ff; margin:12px 0; }
    .grid{ display:grid; grid-template-columns:1fr 1fr; gap:18px; }
    @media (max-width:1000px){ .grid{ grid-template-columns:1fr; } }

    /* Card */
    .card{ border:1px solid var(--bd); border-radius:16px; padding:16px; background:linear-gradient(180deg, rgba(22,26,33,.9), rgba(16,19,25,.94)); box-shadow:0 8px 30px rgba(0,0,0,.25); }

    /* Buttons */
    .btn{ display:inline-block; background:linear-gradient(180deg,#a5e8ff,#7dd3fc); color:#00121a; border-radius:12px; padding:8px 12px; text-decoration:none; border:1px solid transparent; cursor:pointer; font-weight:700; }
    .btn:hover{ filter:brightness(.98); transform:translateY(-1px); }
    .btn.secondary{ background:transparent; color:var(--ink); border-color:#2a3040; }
    .btn.ghost{ background:transparent; color:var(--ink); border-color:transparent; }
    .btn.warn{ background:linear-gradient(180deg, #ffb4b4, #ef4444); color:#220a0a; border-color:transparent; }
    .btn:disabled{ opacity:.6; cursor:not-allowed; }

    /* Tabs */
    .tabs{ display:flex; gap:6px; margin:12px 0; }
    .tab{ padding:8px 12px; border:1px solid #2a3040; border-radius:12px; text-decoration:none; color:var(--ink); background:transparent; }
    .tab.active{ background:rgba(125,211,252,.12); border-color:rgba(125,211,252,.4); }

    /* Tables */
    table{ width:100%; border-collapse:separate; border-spacing:0; margin-top:12px; }
    thead th{ position:sticky; top:0; background:rgba(9,12,16,.9); backdrop-filter:blur(6px); border-bottom:1px solid var(--bd); text-align:right; padding:10px; font-size:12px; color:var(--ink-dim); }
    td{ padding:10px; border-bottom:1px solid rgba(255,255,255,.06); vertical-align:top; text-align:right; }
    tbody tr:hover{ background:rgba(255,255,255,.02); }

    /* Forms */
    .row{ display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
    input[type="password"], input[type="text"]{
      border:1px solid var(--bd); border-radius:10px; padding:8px 10px; width:280px; max-width:100%;
      background:var(--panel); color:var(--ink);
    }
    form.inline{ display:inline; }

    /* Badges / code */
    .badge{ display:inline-block; background:rgba(125,211,252,.12); border:1px solid rgba(125,211,252,.35); border-radius:8px; padding:2px 8px; font-size:12px; margin-inline-start:6px; }
    .code{ font-family:ui-monospace,Consolas,monospace; background:#0f1319; border:1px solid var(--bd); border-radius:10px; padding:8px 10px; display:inline-block; color:var(--ink); }
  </style>
</head>
<body class="sb-body admin">
  <header class="appbar">
    <div class="wrap row">
      <a class="brand" href="/" aria-label="SpotBook">
        <span class="dot" aria-hidden="true"></span>
        <span class="name">SpotBook · Admin</span>
      </a>
      <span class="pill">ADMIN</span>
    </div>
  </header>

  <main class="wrap" style="margin-top:16px">
    <div class="debug">Build: ${BUILD_TAG}</div>
    ${layout.body}
    <div class="muted" style="margin-top:18px">Key: ${keyMasked}</div>
  </main>
</body>
</html>`;
}

/* שורת מסעדה בסיסית */
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
            ? `<form class="inline" method="post" action="/admin/restaurants/${r.id}/unapprove?key=${encodeURIComponent(key)}">
                 <button class="btn secondary" type="submit">השבתה (Unapprove)</button>
               </form>`
            : `<form class="inline" method="post" action="/admin/restaurants/${r.id}/approve?key=${encodeURIComponent(key)}">
                 <button class="btn" type="submit">אישור</button>
               </form>`
        }
        <a class="btn secondary" href="/restaurants/${r.id}" target="_blank" rel="noopener">פתח דף מסעדה</a>
        <form class="inline" method="post" action="/admin/restaurants/${r.id}/delete?key=${encodeURIComponent(key)}" onsubmit="return confirm('למחוק לצמיתות את &quot;${r.name}&quot; וכל ההזמנות שלה?')">
          <button class="btn warn" type="submit">הסר מהאתר</button>
        </form>
      </div>
    </td>
  </tr>`;
}

/** גרסה שמציגה גם בעלים (ותיקון סטטוס בעלים: isActive===false → מבוטל, אחרת פעיל) */
function renderRestaurantRowWithOwner(
  r: Restaurant & { owner?: { id: string; firstName?: string; lastName?: string; email?: string; isActive?: boolean } | null },
  key: string,
) {
  const ownerName = r.owner ? `${r.owner.firstName ?? ""} ${r.owner.lastName ?? ""}`.trim() || "—" : "—";
  const ownerEmail = r.owner?.email || "—";
  const ownerStatus = r.owner ? (r.owner.isActive === false ? "מבוטל" : "פעיל") : "—";
  const approved = r.approved ? "✅ מאושרת" : "⏳ ממתינה";
  const caps = `קיבולת: ${r.capacity ?? "-"} · סלוט: ${r.slotIntervalMinutes ?? "-"}ד' · שירות: ${r.serviceDurationMinutes ?? "-"}ד'`;
  return `
  <tr>
    <td><strong>${r.name}</strong><br/><small class="muted">${r.city} · ${r.address}</small></td>
    <td>${ownerName}<br/><small class="muted" dir="ltr">${ownerEmail}</small></td>
    <td>${ownerStatus}</td>
    <td>${approved}<br/><small class="muted">${caps}</small></td>
    <td>
      <div class="row">
        ${
          r.approved
            ? `<form class="inline" method="post" action="/admin/restaurants/${r.id}/unapprove?key=${encodeURIComponent(key)}">
                 <button class="btn secondary" type="submit">השבתה</button>
               </form>`
            : `<form class="inline" method="post" action="/admin/restaurants/${r.id}/approve?key=${encodeURIComponent(key)}">
                 <button class="btn" type="submit">אישור</button>
               </form>`
        }
        <a class="btn secondary" href="/restaurants/${r.id}" target="_blank" rel="noopener">דף מסעדה</a>
        <form class="inline" method="post" action="/admin/restaurants/${r.id}/delete?key=${encodeURIComponent(key)}" onsubmit="return confirm('למחוק לצמיתות את &quot;${r.name}&quot; וכל ההזמנות שלה?')">
          <button class="btn warn" type="submit">הסר</button>
        </form>
      </div>
    </td>
  </tr>`;
}

/* ================== router ================== */
const adminRouter = new Router();

/** כניסת אדמין */
adminRouter.get("/admin/login", (ctx) => {
  setNoStore(ctx);
  const body = `
  <div class="card" style="max-width:520px">
    <h2 style="margin-top:0">כניסת אדמין</h2>
    <p class="muted">הזן/ני את מפתח האדמין (ADMIN_SECRET) שהוגדר ב־Environment Variables.</p>
    <form method="get" action="/admin">
      <label for="key">מפתח אדמין</label><br/>
      <input id="key" name="key" type="password" placeholder="הדבק כאן את המפתח" required/>
      <button class="btn" type="submit" style="margin-inline-start:8px">כניסה</button>
    </form>
  </div>`;
  ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
  ctx.response.body = page({ title: "כניסת אדמין", body });
});

/** דשבורד אדמין (מסעדות, ואם אפשר — גם בעלים) */
adminRouter.get("/admin", async (ctx) => {
  if (!assertAdmin(ctx)) return;
  setNoStore(ctx);
  const key = getAdminKey(ctx)!;

  const { listRestaurantsWithOwners } = await getDbExtra();

  let rows: (Restaurant & { owner?: any | null })[];
  if (typeof listRestaurantsWithOwners === "function") {
    rows = await listRestaurantsWithOwners(""); // עם בעלים
  } else {
    const basic = await listRestaurants("", /*onlyApproved*/ false);
    rows = basic as any;
  }

  const pending = rows.filter((r) => !r.approved);
  const approved = rows.filter((r) => r.approved);

  const tables = (withOwners: boolean) => `
    <div class="grid">
      <section class="card">
        <h2 style="margin-top:0">ממתינות לאישור (${pending.length})</h2>
        ${
          pending.length === 0
            ? `<p class="muted">אין מסעדות ממתינות כרגע.</p>`
            : `<table>
                <thead><tr>
                  <th>מסעדה</th>${withOwners ? "<th>בעלים</th><th>סטטוס בעלים</th>" : ""}
                  <th>סטטוס</th><th>פעולות</th>
                </tr></thead>
                <tbody>${
                  pending.map((r) =>
                    withOwners ? renderRestaurantRowWithOwner(r as any, key) : renderRestaurantRow(r as any, key)
                  ).join("")
                }</tbody>
              </table>`
        }
      </section>

      <section class="card">
        <h2 style="margin-top:0">מאושרות (${approved.length})</h2>
        ${
          approved.length === 0
            ? `<p class="muted">עוד לא אושרו מסעדות.</p>`
            : `<table>
                <thead><tr>
                  <th>מסעדה</th>${withOwners ? "<th>בעלים</th><th>סטטוס בעלים</th>" : ""}
                  <th>סטטוס</th><th>פעולות</th>
                </tr></thead>
                <tbody>${
                  approved.map((r) =>
                    withOwners ? renderRestaurantRowWithOwner(r as any, key) : renderRestaurantRow(r as any, key)
                  ).join("")
                }</tbody>
              </table>`
        }
      </section>
    </div>`;

  const body = `
  <section class="card" style="margin-bottom:20px">
    <div class="row" style="justify-content:space-between;align-items:center">
      <h2 style="margin:0;color:#7dd3fc">פעולות אדמין (Reset)</h2>
      <div class="tabs">
        <a class="tab active" href="/admin?key=${encodeURIComponent(key)}">מסעדות</a>
        <a class="tab" href="/admin/users?key=${encodeURIComponent(key)}">משתמשים</a>
        <a class="tab" href="/admin/tools?key=${encodeURIComponent(key)}">כלים</a>
      </div>
    </div>
    <div class="row" style="margin-top:6px">
      <form method="post" action="/admin/reset?what=restaurants&confirm=1&key=${encodeURIComponent(key)}">
        <button type="submit" class="btn warn" onclick="return confirm('לאפס את כל המסעדות? הפעולה בלתי הפיכה!')">איפוס כל המסעדות</button>
      </form>
      <form method="post" action="/admin/reset?what=reservations&confirm=1&key=${encodeURIComponent(key)}">
        <button type="submit" class="btn warn" onclick="return confirm('לאפס את כל ההזמנות?')">איפוס כל ההזמנות</button>
      </form>
      <form method="post" action="/admin/reset?what=users&confirm=1&key=${encodeURIComponent(key)}">
        <button type="submit" class="btn warn" onclick="return confirm('לאפס את כל המשתמשים? שים לב: זה ימחק גם בעלי מסעדות!')">איפוס כל המשתמשים</button>
      </form>
      <form method="post" action="/admin/reset?what=all&confirm=1&key=${encodeURIComponent(key)}">
        <button type="submit" class="btn warn" onclick="return confirm('איפוס כללי: משתמשים + מסעדות + הזמנות. להמשיך?')">איפוס כולל (הכול)</button>
      </form>
      <a class="btn ghost" href="/admin/tools?key=${encodeURIComponent(key)}">עוד כלים…</a>
    </div>
  </section>
  ${tables(typeof listRestaurantsWithOwners === "function")}
  `;
  ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
  ctx.response.body = page({ title: "לוח בקרה · Admin", body, key });
});

/** עמוד כלים */
adminRouter.get("/admin/tools", (ctx) => {
  if (!assertAdmin(ctx)) return;
  setNoStore(ctx);
  const key = getAdminKey(ctx)!;
  const body = `
  <div class="card">
    <div class="row" style="justify-content:space-between;align-items:center">
      <h2 style="margin-top:0">Reset · כלי אדמין</h2>
      <div class="tabs">
        <a class="tab" href="/admin?key=${encodeURIComponent(key)}">מסעדות</a>
        <a class="tab" href="/admin/users?key=${encodeURIComponent(key)}">משתמשים</a>
        <a class="tab active" href="/admin/tools?key=${encodeURIComponent(key)}">כלים</a>
      </div>
    </div>
    <p class="muted">אפשר להריץ איפוסים דרך הקישורים הבאים (תופיע בקשת אישור).</p>
    <ul>
      <li><a class="btn warn" href="/admin/reset?what=reservations&key=${encodeURIComponent(key)}">אפס רק הזמנות</a></li>
      <li><a class="btn warn" href="/admin/reset?what=restaurants&key=${encodeURIComponent(key)}">אפס רק מסעדות</a></li>
      <li><a class="btn warn" href="/admin/reset?what=users&key=${encodeURIComponent(key)}">אפס רק משתמשים</a></li>
      <li><a class="btn warn" href="/admin/reset?what=all&key=${encodeURIComponent(key)}">אפס הכל</a></li>
    </ul>
  </div>`;
  ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
  ctx.response.body = page({ title: "Admin · Reset", body, key });
});

/* --- Reset: GET (אישור) + POST (ביצוע) --- */
async function handleReset(ctx: any) {
  if (!assertAdmin(ctx)) return;
  setNoStore(ctx);
  const key = getAdminKey(ctx)!;
  const url = ctx.request.url;
  const what = (url.searchParams.get("what") ?? "").toLowerCase();
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
    ctx.response.body = page({ title: "אישור מחיקה · Admin", body, key });
    return;
  }

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
  ctx.response.body = page({ title: "הושלם · Reset", body, key });
}
adminRouter.get("/admin/reset", handleReset);
adminRouter.post("/admin/reset", handleReset);

/* --- אישור/ביטול מסעדה --- */
adminRouter.post("/admin/restaurants/:id/approve", async (ctx) => {
  if (!assertAdmin(ctx)) return;
  setNoStore(ctx);
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
  setNoStore(ctx);
  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  if (!r) { ctx.response.status = Status.NotFound; ctx.response.body = "Restaurant not found"; return; }
  await updateRestaurant(id, { approved: false });
  const key = getAdminKey(ctx)!;
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", `/admin?key=${encodeURIComponent(key)}`);
});

/* --- הסרה מהאתר (מחיקה מלאה) --- */
adminRouter.post("/admin/restaurants/:id/delete", async (ctx) => {
  if (!assertAdmin(ctx)) return;
  setNoStore(ctx);
  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  if (!r) { ctx.response.status = Status.NotFound; ctx.response.body = "Restaurant not found"; return; }

  const result = await deleteRestaurantCascade(id);
  const key = getAdminKey(ctx)!;

  const body = `
    <div class="card" style="max-width:720px">
      <h2 style="margin-top:0">הוסרה מהאתר</h2>
      <p>המסעדה <strong>${r.name}</strong> נמחקה מהמערכת, כולל ההזמנות שלה.</p>
      <pre class="code" style="white-space:pre-wrap">${JSON.stringify(result, null, 2)}</pre>
      <div class="row" style="margin-top:10px">
        <a class="btn" href="/admin?key=${encodeURIComponent(key)}">חזרה לדשבורד</a>
      </div>
    </div>`;
  ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
  ctx.response.body = page({ title: "הוסרה מהאתר", body, key });
});

/* ========= Users Admin ========= */
adminRouter.get("/admin/users", async (ctx) => {
  if (!assertAdmin(ctx)) return;
  setNoStore(ctx);
  const key = getAdminKey(ctx)!;

  const { listUsersWithRestaurants } = await getDbExtra();
  if (typeof listUsersWithRestaurants !== "function") {
    const body = `
      <div class="card" style="max-width:720px">
        <h2 style="margin-top:0">ניהול משתמשים</h2>
        <p class="muted">הפיצ’ר הזה מחייב פונקציה <code class="code">listUsersWithRestaurants</code> ב־<code class="code">database.ts</code>.</p>
        <p class="muted">הוסף/י את הייצוא ואז טען/י שוב את העמוד.</p>
        <div class="row" style="margin-top:10px">
          <a class="btn" href="/admin?key=${encodeURIComponent(key)}">חזרה למסעדות</a>
          <a class="btn secondary" href="/admin/tools?key=${encodeURIComponent(key)}">כלים</a>
        </div>
      </div>`;
    ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
    ctx.response.body = page({ title: "Admin · Users (disabled)", body, key });
    return;
  }

  const users = await listUsersWithRestaurants(); // [{...user, restaurants: []}]
  const active = users.filter((u: any) => u.isActive !== false);
  const inactive = users.filter((u: any) => u.isActive === false);

  const rows = (list: any[]) => list.map(u => `
    <tr>
      <td><strong>${u.firstName ?? ""} ${u.lastName ?? ""}</strong><br/><small class="muted" dir="ltr">${u.email}</small></td>
      <td>${u.role ?? "user"} <span class="badge">${u.provider ?? "local"}</span></td>
      <td>${u.isActive === false ? "❌ מבוטל" : "✅ פעיל"}</td>
      <td>${
        u.restaurants?.length
          ? u.restaurants.map((r:any)=>`<div><a href="/restaurants/${r.id}" target="_blank" rel="noopener">${r.name}</a></div>`).join("")
          : `<span class="muted">אין</span>`
      }</td>
      <td>
        ${
          u.isActive === false
            ? `<form class="inline" method="post" action="/admin/users/${u.id}/activate?key=${encodeURIComponent(key)}">
                 <button class="btn" type="submit">הפעל</button>
               </form>`
            : `<form class="inline" method="post" action="/admin/users/${u.id}/deactivate?key=${encodeURIComponent(key)}" onsubmit="return confirm('לבטל את המשתמש ${u.email}?')">
                 <button class="btn secondary" type="submit">בטל</button>
               </form>`
        }
        <form class="inline" method="post" action="/admin/users/${u.id}/delete?key=${encodeURIComponent(key)}"
              onsubmit="return confirm('מחיקת משתמש תמחק גם את כל המסעדות וההזמנות שבבעלותו. להמשיך?')">
          <button class="btn warn" type="submit">מחק</button>
        </form>
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

adminRouter.post("/admin/users/:id/deactivate", async (ctx) => {
  if (!assertAdmin(ctx)) return;
  setNoStore(ctx);
  const { setUserActive } = await getDbExtra();
  if (typeof setUserActive !== "function") {
    ctx.response.status = Status.NotImplemented;
    ctx.response.body = "setUserActive is not implemented in database.ts";
    return;
  }
  const id = ctx.params.id!;
  await setUserActive(id, false);
  const key = getAdminKey(ctx)!;
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", `/admin/users?key=${encodeURIComponent(key)}`);
});

adminRouter.post("/admin/users/:id/activate", async (ctx) => {
  if (!assertAdmin(ctx)) return;
  setNoStore(ctx);
  const { setUserActive } = await getDbExtra();
  if (typeof setUserActive !== "function") {
    ctx.response.status = Status.NotImplemented;
    ctx.response.body = "setUserActive is not implemented in database.ts";
    return;
  }
  const id = ctx.params.id!;
  await setUserActive(id, true);
  const key = getAdminKey(ctx)!;
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", `/admin/users?key=${encodeURIComponent(key)}`);
});

/** מחיקת משתמש (Cascade) — אופציונלי; רץ רק אם הוגדר ב-DB */
adminRouter.post("/admin/users/:id/delete", async (ctx) => {
  if (!assertAdmin(ctx)) return;
  setNoStore(ctx);
  const { deleteUserCascade } = await getDbExtra();
  if (typeof deleteUserCascade !== "function") {
    ctx.response.status = Status.NotImplemented;
    ctx.response.body = "deleteUserCascade is not implemented in database.ts";
    return;
  }
  const id = ctx.params.id!;
  await deleteUserCascade(id);
  const key = getAdminKey(ctx)!;
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", `/admin/users?key=${encodeURIComponent(key)}`);
});

export { adminRouter };
export default adminRouter;
