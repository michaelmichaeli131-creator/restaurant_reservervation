// /src/routes/admin.ts
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
const BUILD_TAG = new Date().toISOString().slice(0, 19).replace("T", " ");

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

function urlWithoutParam(u: URL, param: string) {
  const copy = new URL(u.toString());
  copy.searchParams.delete(param);
  return copy;
}

/** תבנית עמוד — גרסת Luxury Dark (מבוסס spotbook.css) + i18n בכותרת */
function page(layout: {
  title: string;
  body: string;
  key?: string;
  headerRightHtml?: string;
  lang?: string;
  dir?: "rtl" | "ltr";
  brandText?: string;
  adminBadgeText?: string;
}) {
  const keyMasked = (layout.key ?? "").replace(/./g, "•");
  const lang = layout.lang || "he";
  const dir = layout.dir || "rtl";
  const brand = layout.brandText ?? "SpotBook · Admin";
  const badge = layout.adminBadgeText ?? "ADMIN";

  return `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="color-scheme" content="dark light">
  <title>${layout.title}</title>

  <!-- עיצוב כהה של SpotBook (תמיד נטען) -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Rubik:wght@300;400;500;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/public/css/spotbook.css?v=${encodeURIComponent(BUILD_TAG)}"/>

  <!-- סגנונות משלימים לאדמין -->
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

    /* Header right */
    .hdr-right{ display:flex; align-items:center; gap:8px; }
    .pill{ display:inline-block; background:rgba(125,211,252,.12); border:1px solid rgba(125,211,252,.35); border-radius:999px; padding:4px 10px; font-size:12px; }
    .lang-switch{ display:inline-flex; gap:6px; align-items:center; }
    .lang-switch a{ text-decoration:none; color:var(--ink); border:1px solid #2a3040; padding:4px 8px; border-radius:10px; font-size:12px; opacity:.9; }
    .lang-switch a.active{ background:rgba(125,211,252,.12); border-color:rgba(125,211,252,.4); }

    /* Generic blocks */
    .muted{ color:var(--ink-dim); }
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
        <span class="name">${brand}</span>
      </a>
      <div class="hdr-right">
        ${layout.headerRightHtml ?? `<span class="pill">${badge}</span>`}
      </div>
    </div>
  </header>

  <main class="wrap" style="margin-top:16px">
    <div class="debug">Build: ${BUILD_TAG}</div>
    ${layout.body}
    <div class="muted" style="margin-top:18px">${(layout.lang === "he" ? "מפתח:" : layout.lang === "ka" ? "გასაღები:" : "Key:")} ${keyMasked}</div>
  </main>
</body>
</html>`;
}

/* ---------- עזר לרינדור שורת מסעדה עם i18n ---------- */
function renderRestaurantRowI18n(
  r: Restaurant,
  key: string,
  L: {
    statusApproved: string; statusPending: string;
    rowCapacity: string; rowSlot: string; rowMinutes: string; rowService: string;
    actApprove: string; actDisable: string; actEnable: string; actRestPage: string; actRemove: string;
    t: (k: string, v?: Record<string, unknown>) => string;
  }
) {
  const status = r.approved ? L.statusApproved : L.statusPending;
  const caps = `${L.rowCapacity}: ${r.capacity ?? "-"} · ${L.rowSlot}: ${r.slotIntervalMinutes ?? "-"}${L.rowMinutes} · ${L.rowService}: ${r.serviceDurationMinutes ?? "-"}${L.rowMinutes}`;

  return `
  <tr>
    <td><strong>${r.name}</strong><br/><small class="muted">${r.city} · ${r.address}</small></td>
    <td>${status}<br/><small class="muted">${caps}</small></td>
    <td>
      <div class="row">
        ${
          r.approved
            ? `<form class="inline" method="post" action="/admin/restaurants/${r.id}/unapprove?key=${encodeURIComponent(key)}">
                 <button class="btn secondary" type="submit">${L.actDisable}</button>
               </form>`
            : `<form class="inline" method="post" action="/admin/restaurants/${r.id}/approve?key=${encodeURIComponent(key)}">
                 <button class="btn" type="submit">${L.actApprove}</button>
               </form>`
        }
        <a class="btn secondary" href="/restaurants/${r.id}" target="_blank" rel="noopener">${L.actRestPage}</a>
        <form class="inline" method="post" action="/admin/restaurants/${r.id}/delete?key=${encodeURIComponent(key)}"
              onsubmit="return confirm('${L.t("admin.confirm.delete_restaurant",{ name: r.name })}')">
          <button class="btn warn" type="submit">${L.actRemove}</button>
        </form>
      </div>
    </td>
  </tr>`;
}

function renderRestaurantRowWithOwnerI18n(
  r: Restaurant & { owner?: { id: string; firstName?: string; lastName?: string; email?: string; isActive?: boolean } | null },
  key: string,
  L: {
    statusApproved: string; statusPending: string;
    ownerActive: string; ownerInactive: string;
    rowCapacity: string; rowSlot: string; rowMinutes: string; rowService: string;
    actApprove: string; actDisable: string; actEnable: string; actRestPage: string; actRemove: string;
    t: (k: string, v?: Record<string, unknown>) => string;
  }
) {
  const ownerName  = r.owner ? `${r.owner.firstName ?? ""} ${r.owner.lastName ?? ""}`.trim() || "—" : "—";
  const ownerEmail = r.owner?.email || "";
  const ownerStatus = r.owner ? (r.owner.isActive === false ? L.ownerInactive : L.ownerActive) : "—";

  const status = r.approved ? L.statusApproved : L.statusPending;
  const caps = `${L.rowCapacity}: ${r.capacity ?? "-"} · ${L.rowSlot}: ${r.slotIntervalMinutes ?? "-"}${L.rowMinutes} · ${L.rowService}: ${r.serviceDurationMinutes ?? "-"}${L.rowMinutes}`;

  return `
  <tr>
    <td><strong>${r.name}</strong><br/><small class="muted">${r.city} · ${r.address}</small></td>
    <td title="${ownerEmail}">${ownerName}</td>
    <td>${ownerStatus}</td>
    <td>${status}<br/><small class="muted">${caps}</small></td>
    <td>
      <div class="row">
        ${
          r.approved
            ? `<form class="inline" method="post" action="/admin/restaurants/${r.id}/unapprove?key=${encodeURIComponent(key)}">
                 <button class="btn secondary" type="submit">${L.actDisable}</button>
               </form>`
            : `<form class="inline" method="post" action="/admin/restaurants/${r.id}/approve?key=${encodeURIComponent(key)}">
                 <button class="btn" type="submit">${L.actApprove}</button>
               </form>`
        }
        <a class="btn secondary" href="/restaurants/${r.id}" target="_blank" rel="noopener">${L.actRestPage}</a>
        <form class="inline" method="post" action="/admin/restaurants/${r.id}/delete?key=${encodeURIComponent(key)}"
              onsubmit="return confirm('${L.t("admin.confirm.delete_restaurant",{ name: r.name })}')">
          <button class="btn warn" type="submit">${L.actRemove}</button>
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

  // deno-lint-ignore no-explicit-any
  const t: (k: string, v?: Record<string, unknown>) => string =
    (ctx.state as any)?.t ?? ((k: string) => `(${k})`);
  // deno-lint-ignore no-explicit-any
  const dir: "rtl" | "ltr" = (ctx.state as any)?.dir ?? "rtl";
  // deno-lint-ignore no-explicit-any
  const lang: string = (ctx.state as any)?.lang ?? "he";

  // language switch links
  const u = urlWithoutParam(ctx.request.url, "lang");
  const base = urlWithoutParam(u, "key");
  const mk = (code: string) =>
    `${base.pathname}?key=${encodeURIComponent(getAdminKey(ctx) ?? "")}&lang=${encodeURIComponent(code)}`;
  const langHtml = `
    <div class="lang-switch">
      <a href="${mk("he")}" class="${lang === "he" ? "active" : ""}">HE</a>
      <a href="${mk("en")}" class="${lang === "en" ? "active" : ""}">EN</a>
      <a href="${mk("ka")}" class="${lang === "ka" ? "active" : ""}">KA</a>
    </div>
    <span class="pill">${t("admin.header.badge") ?? "ADMIN"}</span>
  `;

  const body = `
  <div class="card" style="max-width:520px">
    <h2 style="margin-top:0">${t("admin.login.title")}</h2>
    <p class="muted">${t("admin.login.desc")}</p>
    <form method="get" action="/admin">
      <label for="key">${t("admin.login.key_label")}</label><br/>
      <input id="key" name="key" type="password" placeholder="${t("admin.login.key_placeholder")}" required/>
      <button class="btn" type="submit" style="margin-inline-start:8px">${t("admin.login.submit")}</button>
    </form>
  </div>`;
  ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
  ctx.response.body = page({
    title: t("admin.app.title"),
    body,
    headerRightHtml: langHtml,
    lang,
    dir,
    brandText: t("admin.header.brand") ?? "SpotBook · Admin",
    adminBadgeText: t("admin.header.badge") ?? "ADMIN",
  });
});

/** דשבורד אדמין (מסעדות, ואם אפשר — גם בעלים) */
adminRouter.get("/admin", async (ctx) => {
  if (!assertAdmin(ctx)) return;
  setNoStore(ctx);
  const key = getAdminKey(ctx)!;

  // deno-lint-ignore no-explicit-any
  const t: (k: string, v?: Record<string, unknown>) => string =
    (ctx.state as any)?.t ?? ((k: string) => `(${k})`);
  // deno-lint-ignore no-explicit-any
  const dir: "rtl" | "ltr" = (ctx.state as any)?.dir ?? "rtl";
  // deno-lint-ignore no-explicit-any
  const lang: string = (ctx.state as any)?.lang ?? "he";

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

  // i18n strings
  const resetTitle            = t("admin.dashboard.title");
  const tabRestaurants        = t("admin.dashboard.tabs.restaurants");
  const tabUsers              = t("admin.dashboard.tabs.users");
  const tabTools              = t("admin.dashboard.tabs.tools");

  const btnResetRestaurants   = t("admin.reset.btn.restaurants");
  const btnResetReservations  = t("admin.reset.btn.reservations");
  const btnResetUsers         = t("admin.reset.btn.users");
  const btnResetAll           = t("admin.reset.btn.all");
  const moreTools             = t("admin.reset.more_tools");

  const pendingTitle  = t("admin.tables.pending_title",  { count: pending.length });
  const approvedTitle = t("admin.tables.approved_title", { count: approved.length });

  const thRestaurant  = t("admin.tables.th.restaurant");
  const thOwner       = t("admin.tables.th.owner");
  const thOwnerStatus = t("admin.tables.th.owner_status");
  const thStatus      = t("admin.tables.th.status");
  const thActions     = t("admin.tables.th.actions");

  const statusApproved = "✅ " + t("admin.status.approved");
  const statusPending  = "⏳ " + t("admin.status.pending");
  const ownerActive    = t("admin.owner.active");
  const ownerInactive  = t("admin.owner.inactive");
  const rowCapacity    = t("admin.row.capacity");
  const rowSlot        = t("admin.row.slot");
  const rowMinutes     = t("admin.row.minutes");
  const rowService     = t("admin.row.service");
  const actApprove     = t("admin.actions.approve");
  const actDisable     = t("admin.actions.disable");
  const actEnable      = t("admin.actions.enable");
  const actRestPage    = t("admin.actions.restaurant_page");
  const actRemove      = t("admin.actions.remove");

  // language switch links
  const u = urlWithoutParam(ctx.request.url, "lang");
  const base = urlWithoutParam(u, "key");
  const mk = (code: string) =>
    `${base.pathname}?key=${encodeURIComponent(key)}&lang=${encodeURIComponent(code)}`;
  const headerRightHtml = `
    <div class="lang-switch">
      <a href="${mk("he")}" class="${lang === "he" ? "active" : ""}">HE</a>
      <a href="${mk("en")}" class="${lang === "en" ? "active" : ""}">EN</a>
      <a href="${mk("ka")}" class="${lang === "ka" ? "active" : ""}">KA</a>
    </div>
    <span class="pill">${t("admin.header.badge") ?? "ADMIN"}</span>
  `;

  const tables = (withOwners: boolean) => `
    <div class="grid">
      <section class="card">
        <h2 style="margin-top:0">${pendingTitle}</h2>
        ${
          pending.length === 0
            ? `<p class="muted">${t("common.none")}</p>`
            : `<table>
                <thead><tr>
                  <th>${thRestaurant}</th>${withOwners ? `<th>${thOwner}</th><th>${thOwnerStatus}</th>` : ""}
                  <th>${thStatus}</th><th>${thActions}</th>
                </tr></thead>
                <tbody>${
                  pending.map((r) =>
                    withOwners
                      ? renderRestaurantRowWithOwnerI18n(r as any, key, {
                          statusApproved, statusPending, ownerActive, ownerInactive,
                          rowCapacity, rowSlot, rowMinutes, rowService,
                          actApprove, actDisable, actEnable, actRestPage, actRemove, t
                        })
                      : renderRestaurantRowI18n(r as any, key, {
                          statusApproved, statusPending,
                          rowCapacity, rowSlot, rowMinutes, rowService,
                          actApprove, actDisable, actEnable, actRestPage, actRemove, t
                        })
                  ).join("")
                }</tbody>
              </table>`
        }
      </section>

      <section class="card">
        <h2 style="margin-top:0">${approvedTitle}</h2>
        ${
          approved.length === 0
            ? `<p class="muted">${t("common.none")}</p>`
            : `<table>
                <thead><tr>
                  <th>${thRestaurant}</th>${withOwners ? `<th>${thOwner}</th><th>${thOwnerStatus}</th>` : ""}
                  <th>${thStatus}</th><th>${thActions}</th>
                </tr></thead>
                <tbody>${
                  approved.map((r) =>
                    withOwners
                      ? renderRestaurantRowWithOwnerI18n(r as any, key, {
                          statusApproved, statusPending, ownerActive, ownerInactive,
                          rowCapacity, rowSlot, rowMinutes, rowService,
                          actApprove, actDisable, actEnable, actRestPage, actRemove, t
                        })
                      : renderRestaurantRowI18n(r as any, key, {
                          statusApproved, statusPending,
                          rowCapacity, rowSlot, rowMinutes, rowService,
                          actApprove, actDisable, actEnable, actRestPage, actRemove, t
                        })
                  ).join("")
                }</tbody>
              </table>`
        }
      </section>
    </div>`;

  const body = `
  <section class="card" style="margin-bottom:20px">
    <div class="row" style="justify-content:space-between;align-items:center">
      <h2 style="margin:0;color:#7dd3fc">${resetTitle}</h2>
      <div class="tabs">
        <a class="tab active" href="/admin?key=${encodeURIComponent(key)}">${tabRestaurants}</a>
        <a class="tab" href="/admin/users?key=${encodeURIComponent(key)}">${tabUsers}</a>
        <a class="tab" href="/admin/tools?key=${encodeURIComponent(key)}">${tabTools}</a>
      </div>
    </div>
    <div class="row" style="margin-top:6px">
      <form method="post" action="/admin/reset?what=restaurants&confirm=1&key=${encodeURIComponent(key)}">
        <button type="submit" class="btn warn" onclick="return confirm('${t("admin.confirm.reset_restaurants")}')">${btnResetRestaurants}</button>
      </form>
      <form method="post" action="/admin/reset?what=reservations&confirm=1&key=${encodeURIComponent(key)}">
        <button type="submit" class="btn warn" onclick="return confirm('${t("admin.confirm.reset_reservations")}')">${btnResetReservations}</button>
      </form>
      <form method="post" action="/admin/reset?what=users&confirm=1&key=${encodeURIComponent(key)}">
        <button type="submit" class="btn warn" onclick="return confirm('${t("admin.confirm.reset_users")}')">${btnResetUsers}</button>
      </form>
      <form method="post" action="/admin/reset?what=all&confirm=1&key=${encodeURIComponent(key)}">
        <button type="submit" class="btn warn" onclick="return confirm('${t("admin.confirm.reset_all")}')">${btnResetAll}</button>
      </form>
      <a class="btn ghost" href="/admin/tools?key=${encodeURIComponent(key)}">${moreTools}</a>
    </div>
  </section>
  ${tables(typeof listRestaurantsWithOwners === "function")}
  `;

  ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
  ctx.response.body = page({
    title: t("admin.app.title"),
    body,
    key,
    headerRightHtml,
    lang,
    dir,
    brandText: t("admin.header.brand") ?? "SpotBook · Admin",
    adminBadgeText: t("admin.header.badge") ?? "ADMIN",
  });
});

/** עמוד כלים */
adminRouter.get("/admin/tools", (ctx) => {
  if (!assertAdmin(ctx)) return;
  setNoStore(ctx);
  const key = getAdminKey(ctx)!;

  // deno-lint-ignore no-explicit-any
  const t: (k: string, v?: Record<string, unknown>) => string =
    (ctx.state as any)?.t ?? ((k: string) => `(${k})`);
  // deno-lint-ignore no-explicit-any
  const dir: "rtl" | "ltr" = (ctx.state as any)?.dir ?? "rtl";
  // deno-lint-ignore no-explicit-any
  const lang: string = (ctx.state as any)?.lang ?? "he";

  // language switch
  const u = urlWithoutParam(ctx.request.url, "lang");
  const base = urlWithoutParam(u, "key");
  const mk = (code: string) =>
    `${base.pathname}?key=${encodeURIComponent(key)}&lang=${encodeURIComponent(code)}`;
  const headerRightHtml = `
    <div class="lang-switch">
      <a href="${mk("he")}" class="${lang === "he" ? "active" : ""}">HE</a>
      <a href="${mk("en")}" class="${lang === "en" ? "active" : ""}">EN</a>
      <a href="${mk("ka")}" class="${lang === "ka" ? "active" : ""}">KA</a>
    </div>
    <span class="pill">${t("admin.header.badge") ?? "ADMIN"}</span>
  `;

  const body = `
  <div class="card">
    <div class="row" style="justify-content:space-between;align-items:center">
      <h2 style="margin-top:0">${t("admin.tools.title")}</h2>
      <div class="tabs">
        <a class="tab" href="/admin?key=${encodeURIComponent(key)}">${t("admin.dashboard.tabs.restaurants")}</a>
        <a class="tab" href="/admin/users?key=${encodeURIComponent(key)}">${t("admin.dashboard.tabs.users")}</a>
        <a class="tab active" href="/admin/tools?key=${encodeURIComponent(key)}">${t("admin.dashboard.tabs.tools")}</a>
      </div>
    </div>
    <p class="muted">${t("admin.tools.desc")}</p>
    <ul>
      <li><a class="btn warn" href="/admin/reset?what=reservations&key=${encodeURIComponent(key)}">${t("admin.tools.reset_reservations")}</a></li>
      <li><a class="btn warn" href="/admin/reset?what=restaurants&key=${encodeURIComponent(key)}">${t("admin.tools.reset_restaurants")}</a></li>
      <li><a class="btn warn" href="/admin/reset?what=users&key=${encodeURIComponent(key)}">${t("admin.tools.reset_users")}</a></li>
      <li><a class="btn warn" href="/admin/reset?what=all&key=${encodeURIComponent(key)}">${t("admin.tools.reset_all")}</a></li>
    </ul>
  </div>`;
  ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
  ctx.response.body = page({
    title: t("admin.tools.title"),
    body,
    key,
    headerRightHtml,
    lang,
    dir,
    brandText: t("admin.header.brand") ?? "SpotBook · Admin",
    adminBadgeText: t("admin.header.badge") ?? "ADMIN",
  });
});

/* --- Reset: GET (אישור) + POST (ביצוע) --- */
async function handleReset(ctx: any) {
  if (!assertAdmin(ctx)) return;
  setNoStore(ctx);
  const key = getAdminKey(ctx)!;

  // deno-lint-ignore no-explicit-any
  const t: (k: string, v?: Record<string, unknown>) => string =
    (ctx.state as any)?.t ?? ((k: string) => `(${k})`);
  // deno-lint-ignore no-explicit-any
  const dir: "rtl" | "ltr" = (ctx.state as any)?.dir ?? "rtl";
  // deno-lint-ignore no-explicit-any
  const lang: string = (ctx.state as any)?.lang ?? "he";

  // language switch
  const u = urlWithoutParam(ctx.request.url, "lang");
  const base = urlWithoutParam(u, "key");
  const mk = (code: string) =>
    `${base.pathname}?what=${encodeURIComponent(ctx.request.url.searchParams.get("what") ?? "")}&key=${encodeURIComponent(key)}&lang=${encodeURIComponent(code)}`;
  const headerRightHtml = `
    <div class="lang-switch">
      <a href="${mk("he")}" class="${lang === "he" ? "active" : ""}">HE</a>
      <a href="${mk("en")}" class="${lang === "en" ? "active" : ""}">EN</a>
      <a href="${mk("ka")}" class="${lang === "ka" ? "active" : ""}">KA</a>
    </div>
    <span class="pill">${t("admin.header.badge") ?? "ADMIN"}</span>
  `;

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
        <h2 style="margin-top:0">${t("admin.confirm.title") ?? t("admin.reset.title")}</h2>
        <p>${t("admin.confirm.are_you_sure") ?? "האם לאשר פעולה עבור:"} <strong>${what}</strong>?</p>
        <div class="row">
          <a class="btn warn" href="/admin/reset?what=${encodeURIComponent(what)}&confirm=1&key=${encodeURIComponent(key)}">${t("admin.actions.confirm") ?? "אשר מחיקה"}</a>
          <a class="btn secondary" href="/admin/tools?key=${encodeURIComponent(key)}">${t("admin.actions.back_tools")}</a>
        </div>
      </div>`;
    ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
    ctx.response.body = page({
      title: t("admin.reset.title"),
      body,
      key,
      headerRightHtml,
      lang,
      dir,
      brandText: t("admin.header.brand") ?? "SpotBook · Admin",
      adminBadgeText: t("admin.header.badge") ?? "ADMIN",
    });
    return;
  }

  const result = await actions[what]();
  const body = `
    <div class="card" style="max-width:720px">
      <h2 style="margin-top:0">${t("admin.done.title")}</h2>
      <p>${t("admin.done.reset_done", { what })}</p>
      <pre class="code" style="white-space:pre-wrap">${JSON.stringify(result, null, 2)}</pre>
      <div class="row" style="margin-top:10px">
        <a class="btn" href="/admin/tools?key=${encodeURIComponent(key)}">${t("admin.done.back_tools")}</a>
        <a class="btn secondary" href="/admin?key=${encodeURIComponent(key)}">${t("admin.done.back_dashboard")}</a>
      </div>
    </div>`;
  ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
  ctx.response.body = page({
    title: t("admin.done.title"),
    body,
    key,
    headerRightHtml,
    lang,
    dir,
    brandText: t("admin.header.brand") ?? "SpotBook · Admin",
    adminBadgeText: t("admin.header.badge") ?? "ADMIN",
  });
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

  // deno-lint-ignore no-explicit-any
  const t: (k: string, v?: Record<string, unknown>) => string =
    (ctx.state as any)?.t ?? ((k: string) => `(${k})`);
  // deno-lint-ignore no-explicit-any
  const dir: "rtl" | "ltr" = (ctx.state as any)?.dir ?? "rtl";
  // deno-lint-ignore no-explicit-any
  const lang: string = (ctx.state as any)?.lang ?? "he";

  const headerRightHtml = `<span class="pill">${t("admin.header.badge") ?? "ADMIN"}</span>`;

  const body = `
    <div class="card" style="max-width:720px">
      <h2 style="margin-top:0">${t("admin.done.title")}</h2>
      <p>${t("admin.done.reset_done", { what: t("admin.actions.remove") })}</p>
      <pre class="code" style="white-space:pre-wrap">${JSON.stringify(result, null, 2)}</pre>
      <div class="row" style="margin-top:10px">
        <a class="btn" href="/admin?key=${encodeURIComponent(key)}">${t("admin.actions.back_dashboard")}</a>
      </div>
    </div>`;
  ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
  ctx.response.body = page({
    title: t("admin.done.title"),
    body,
    key,
    headerRightHtml,
    lang,
    dir,
    brandText: t("admin.header.brand") ?? "SpotBook · Admin",
    adminBadgeText: t("admin.header.badge") ?? "ADMIN",
  });
});

/* ========= Users Admin ========= */
adminRouter.get("/admin/users", async (ctx) => {
  if (!assertAdmin(ctx)) return;
  setNoStore(ctx);
  const key = getAdminKey(ctx)!;

  // deno-lint-ignore no-explicit-any
  const t: (k: string, v?: Record<string, unknown>) => string =
    (ctx.state as any)?.t ?? ((k: string) => `(${k})`);
  // deno-lint-ignore no-explicit-any
  const dir: "rtl" | "ltr" = (ctx.state as any)?.dir ?? "rtl";
  // deno-lint-ignore no-explicit-any
  const lang: string = (ctx.state as any)?.lang ?? "he";

  // language switch
  const u = urlWithoutParam(ctx.request.url, "lang");
  const base = urlWithoutParam(u, "key");
  const mk = (code: string) =>
    `${base.pathname}?key=${encodeURIComponent(key)}&lang=${encodeURIComponent(code)}`;
  const headerRightHtml = `
    <div class="lang-switch">
      <a href="${mk("he")}" class="${lang === "he" ? "active" : ""}">HE</a>
      <a href="${mk("en")}" class="${lang === "en" ? "active" : ""}">EN</a>
      <a href="${mk("ka")}" class="${lang === "ka" ? "active" : ""}">KA</a>
    </div>
    <span class="pill">${t("admin.header.badge") ?? "ADMIN"}</span>
  `;

  const { listUsersWithRestaurants } = await getDbExtra();
  if (typeof listUsersWithRestaurants !== "function") {
    const body = `
      <div class="card" style="max-width:720px">
        <h2 style="margin-top:0">${t("admin.users.title")}</h2>
        <p class="muted">${t("admin.users.not_implemented")}</p>
        <div class="row" style="margin-top:10px">
          <a class="btn" href="/admin?key=${encodeURIComponent(key)}">${t("admin.dashboard.tabs.restaurants")}</a>
          <a class="btn secondary" href="/admin/tools?key=${encodeURIComponent(key)}">${t("admin.dashboard.tabs.tools")}</a>
        </div>
      </div>`;
    ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
    ctx.response.body = page({
      title: t("admin.app.title"),
      body,
      key,
      headerRightHtml,
      lang,
      dir,
      brandText: t("admin.header.brand") ?? "SpotBook · Admin",
      adminBadgeText: t("admin.header.badge") ?? "ADMIN",
    });
    return;
  }

  const users = await listUsersWithRestaurants(); // [{...user, restaurants: []}]
  const active = users.filter((u: any) => u.isActive !== false);
  const inactive = users.filter((u: any) => u.isActive === false);

  const activeTitle   = t("admin.users.active",   { n: active.length });
  const inactiveTitle = t("admin.users.inactive", { n: inactive.length });

  const rows = (list: any[]) => list.map(u => `
    <tr>
      <td><strong>${u.firstName ?? ""} ${u.lastName ?? ""}</strong><br/><small class="muted" dir="ltr">${u.email}</small></td>
      <td>${u.role ?? "user"} <span class="badge">${u.provider ?? "local"}</span></td>
      <td>${u.isActive === false ? "❌ " + t("admin.owner.inactive") : "✅ " + t("admin.owner.active")}</td>
      <td>${
        u.restaurants?.length
          ? u.restaurants.map((r:any)=>`<div><a href="/restaurants/${r.id}" target="_blank" rel="noopener">${r.name}</a></div>`).join("")
          : `<span class="muted">${t("admin.users.none")}</span>`
      }</td>
      <td>
        ${
          u.isActive === false
            ? `<form class="inline" method="post" action="/admin/users/${u.id}/activate?key=${encodeURIComponent(key)}">
                 <button class="btn" type="submit">${t("admin.users.activate")}</button>
               </form>`
            : `<form class="inline" method="post" action="/admin/users/${u.id}/deactivate?key=${encodeURIComponent(key)}" onsubmit="return confirm('${t("admin.users.deactivate_confirm") ?? "Deactivate this user?"}')">
                 <button class="btn secondary" type="submit">${t("admin.users.deactivate")}</button>
               </form>`
        }
        <form class="inline" method="post" action="/admin/users/${u.id}/delete?key=${encodeURIComponent(key)}"
              onsubmit="return confirm('${t("admin.users.delete_confirm") ?? "Delete user? This will remove their restaurants and reservations."}')">
          <button class="btn warn" type="submit">${t("admin.users.delete")}</button>
        </form>
      </td>
    </tr>
  `).join("");

  const body = `
  <section class="card" style="margin-bottom:20px">
    <div class="row" style="justify-content:space-between;align-items:center">
      <h2 style="margin-top:0">${t("admin.users.title")}</h2>
      <div class="tabs">
        <a class="tab" href="/admin?key=${encodeURIComponent(key)}">${t("admin.dashboard.tabs.restaurants")}</a>
        <a class="tab active" href="/admin/users?key=${encodeURIComponent(key)}">${t("admin.dashboard.tabs.users")}</a>
        <a class="tab" href="/admin/tools?key=${encodeURIComponent(key)}">${t("admin.dashboard.tabs.tools")}</a>
      </div>
    </div>
  </section>

  <div class="grid">
    <section class="card">
      <h3 style="margin-top:0">${activeTitle}</h3>
      ${
        active.length === 0
          ? `<p class="muted">${t("common.none")}</p>`
          : `<table>
              <thead><tr>
                <th>${t("admin.users.th.user")}</th>
                <th>${t("admin.users.th.role")}</th>
                <th>${t("admin.users.th.status")}</th>
                <th>${t("admin.users.th.restaurants")}</th>
                <th>${t("admin.users.th.actions")}</th>
              </tr></thead>
              <tbody>${rows(active)}</tbody>
            </table>`
      }
    </section>

    <section class="card">
      <h3 style="margin-top:0">${inactiveTitle}</h3>
      ${
        inactive.length === 0
          ? `<p class="muted">${t("common.none")}</p>`
          : `<table>
              <thead><tr>
                <th>${t("admin.users.th.user")}</th>
                <th>${t("admin.users.th.role")}</th>
                <th>${t("admin.users.th.status")}</th>
                <th>${t("admin.users.th.restaurants")}</th>
                <th>${t("admin.users.th.actions")}</th>
              </tr></thead>
              <tbody>${rows(inactive)}</tbody>
            </table>`
      }
    </section>
  </div>`;
  ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
  ctx.response.body = page({
    title: t("admin.app.title"),
    body,
    key,
    headerRightHtml,
    lang,
    dir,
    brandText: t("admin.header.brand") ?? "SpotBook · Admin",
    adminBadgeText: t("admin.header.badge") ?? "ADMIN",
  });
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
