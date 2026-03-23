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
} from "../database.ts";

const ADMIN_SECRET = Deno.env.get("ADMIN_SECRET") ?? "";
const BUILD_TAG = new Date().toISOString().slice(0, 19).replace("T", " ");

type RestaurantWithOwner = Restaurant & {
  owner?: {
    id: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    isActive?: boolean;
  } | null;
};

type UserWithRestaurants = {
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  role?: string;
  provider?: string;
  isActive?: boolean;
  restaurants?: { id: string; name: string }[];
};

type DBExtra = {
  listUsersWithRestaurants?: (q?: string) => Promise<UserWithRestaurants[]>;
  listRestaurantsWithOwners?: (q?: string) => Promise<RestaurantWithOwner[]>;
  setUserActive?: (userId: string, isActive: boolean) => Promise<boolean>;
  deleteUserCascade?: (userId: string) => Promise<boolean | number>;
};

let dbExtraCache: DBExtra | null = null;

async function getDbExtra(): Promise<DBExtra> {
  if (dbExtraCache) return dbExtraCache;
  try {
    const mod = await import("../database.ts");
    dbExtraCache = {
      listUsersWithRestaurants: mod.listUsersWithRestaurants,
      listRestaurantsWithOwners: mod.listRestaurantsWithOwners,
      setUserActive: mod.setUserActive,
      deleteUserCascade: (mod as any).deleteUserCascade,
    };
  } catch {
    dbExtraCache = {};
  }
  return dbExtraCache;
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

function setNoStore(ctx: any) {
  ctx.response.headers.set(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, max-age=0",
  );
  ctx.response.headers.set("Pragma", "no-cache");
  ctx.response.headers.set("Expires", "0");
}

function tr(
  ctx: any,
  key: string,
  fallback: string,
  vars?: Record<string, unknown>,
): string {
  const t = (ctx.state as any)?.t as ((k: string, v?: any) => string) | undefined;
  try {
    const res = t ? t(key, vars) : undefined;
    const base = typeof res === "string" && res.length ? res : fallback;
    return base.replace(/\{(\w+)\}/g, (_, k) => String(vars?.[k] ?? `{${k}}`));
  } catch {
    return fallback.replace(/\{(\w+)\}/g, (_, k) => String(vars?.[k] ?? `{${k}}`));
  }
}

function langDir(ctx: any): { lang: string; dir: "rtl" | "ltr" } {
  const lang = (ctx.state as any)?.lang ?? "he";
  const dir = (ctx.state as any)?.dir ?? (lang === "he" ? "rtl" : "ltr");
  return { lang, dir };
}

function currentUrl(ctx: any): string {
  const u = ctx.request.url;
  return u.pathname + u.search;
}

function langLink(ctx: any, code: "he" | "en" | "ka") {
  return `/lang/${code}?redirect=${encodeURIComponent(currentUrl(ctx))}`;
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function compact(value: unknown, fallback = "—") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function initials(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return (words.slice(0, 2).map((w) => w[0]).join("") || "SB").toUpperCase();
}

function num(value: unknown, fallback = "0"): string {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? String(n) : fallback;
}

function photoUrls(r: Restaurant): string[] {
  const arr = Array.isArray((r as any).photos) ? (r as any).photos : [];
  return arr
    .map((p: any) => (typeof p === "string" ? p : p?.dataUrl))
    .filter(Boolean);
}

function currentCoverUrl(r: Restaurant): string {
  const photos = photoUrls(r);
  return String((r as any).coverUrl || photos[0] || "");
}

function restaurantSearchText(r: RestaurantWithOwner): string {
  return [
    r.name,
    r.city,
    r.address,
    r.owner?.firstName,
    r.owner?.lastName,
    r.owner?.email,
  ].filter(Boolean).join(" ");
}

function userSearchText(u: UserWithRestaurants): string {
  const restaurantNames = Array.isArray(u.restaurants)
    ? u.restaurants.map((r) => r.name).join(" ")
    : "";
  return [
    u.firstName,
    u.lastName,
    u.email,
    u.role,
    u.provider,
    restaurantNames,
  ].filter(Boolean).join(" ");
}

function statCard(label: string, value: string, tone = "default", note = ""): string {
  return `
    <article class="stat-card tone-${tone}">
      <div class="stat-label">${esc(label)}</div>
      <div class="stat-value">${esc(value)}</div>
      ${note ? `<div class="stat-note">${esc(note)}</div>` : ""}
    </article>`;
}

function tabs(ctx: any, key: string, active: "restaurants" | "users" | "tools"): string {
  const t = (k: string, fb: string, v?: Record<string, unknown>) => tr(ctx, k, fb, v);
  return `
    <nav class="tabs" aria-label="Admin sections">
      <a class="tab ${active === "restaurants" ? "active" : ""}" href="/admin?key=${encodeURIComponent(key)}">${esc(t("admin.tabs.restaurants", "Restaurants"))}</a>
      <a class="tab ${active === "users" ? "active" : ""}" href="/admin/users?key=${encodeURIComponent(key)}">${esc(t("admin.tabs.users", "Users"))}</a>
      <a class="tab ${active === "tools" ? "active" : ""}" href="/admin/tools?key=${encodeURIComponent(key)}">${esc(t("admin.tabs.tools", "Tools"))}</a>
    </nav>`;
}

function renderCoverPicker(ctx: any, r: Restaurant, key: string): string {
  const t = (k: string, fb: string, v?: Record<string, unknown>) => tr(ctx, k, fb, v);
  const photos = photoUrls(r);
  if (!photos.length) {
    return `<small class="muted">${esc(t("admin.cover.no_photos", "No photos uploaded"))}</small>`;
  }
  const currentCover = currentCoverUrl(r);
  return `<div class="cover-picker">
    ${photos.map((url, i) => `
      <form class="inline" method="post" action="/admin/restaurants/${encodeURIComponent(String(r.id))}/set-cover?key=${encodeURIComponent(key)}">
        <input type="hidden" name="coverUrl" value="${esc(url)}"/>
        <button type="submit" class="cover-thumb${url === currentCover ? " is-active" : ""}" title="${esc(t("admin.cover.set_tip", "Set as cover image"))}">
          <img src="${esc(url)}" alt="Photo ${i + 1}" loading="lazy"/>
          ${url === currentCover ? '<span class="cover-check">✓</span>' : ""}
        </button>
      </form>`).join("")}
  </div>`;
}

function restaurantMetaChips(ctx: any, r: RestaurantWithOwner): string {
  const t = (k: string, fb: string, v?: Record<string, unknown>) => tr(ctx, k, fb, v);
  const chips = [
    `${t("admin.row.capacity", "Capacity")}: ${compact(r.capacity, "-")}`,
    `${t("admin.row.slot", "Slot")}: ${compact(r.slotIntervalMinutes, "-")}${t("admin.row.minutes", "min")}`,
    `${t("admin.row.service", "Service")}: ${compact(r.serviceDurationMinutes, "-")}${t("admin.row.minutes", "min")}`,
  ];
  if (r.owner) {
    const ownerName = `${r.owner.firstName ?? ""} ${r.owner.lastName ?? ""}`.trim() || r.owner.email || "—";
    const ownerStatus = r.owner.isActive === false
      ? t("admin.owner.inactive", "Inactive")
      : t("admin.owner.active", "Active");
    chips.push(`${t("admin.tables.th.owner", "Owner")}: ${ownerName}`);
    chips.push(`${t("admin.tables.th.owner_status", "Owner status")}: ${ownerStatus}`);
  }
  return chips.map((chip) => `<span class="meta-pill">${esc(chip)}</span>`).join("");
}

function renderRestaurantActions(ctx: any, r: RestaurantWithOwner, key: string): string {
  const t = (k: string, fb: string, v?: Record<string, unknown>) => tr(ctx, k, fb, v);
  const deleteConfirm = `${t("admin.confirm.delete_restaurant", "Permanently delete")} \"${r.name}\" ${t("admin.confirm.and_reservations", "and all its reservations?")}`;
  return `
    <div class="action-row">
      ${r.approved
        ? `<form class="inline" method="post" action="/admin/restaurants/${encodeURIComponent(String(r.id))}/unapprove?key=${encodeURIComponent(key)}"><button class="btn secondary" type="submit">${esc(t("admin.actions.unapprove", "Unapprove"))}</button></form>`
        : `<form class="inline" method="post" action="/admin/restaurants/${encodeURIComponent(String(r.id))}/approve?key=${encodeURIComponent(key)}"><button class="btn" type="submit">${esc(t("admin.actions.approve", "Approve"))}</button></form>`}
      ${(r as any).featured
        ? `<form class="inline" method="post" action="/admin/restaurants/${encodeURIComponent(String(r.id))}/unfeature?key=${encodeURIComponent(key)}"><button class="btn secondary" type="submit" title="${esc(t("admin.actions.unfeature_tip", "Remove from featured"))}">⭐ ${esc(t("admin.actions.unfeature", "Unfeature"))}</button></form>`
        : `<form class="inline" method="post" action="/admin/restaurants/${encodeURIComponent(String(r.id))}/feature?key=${encodeURIComponent(key)}"><button class="btn secondary" type="submit" title="${esc(t("admin.actions.feature_tip", "Promote to featured on homepage"))}">☆ ${esc(t("admin.actions.feature", "Feature"))}</button></form>`}
      <a class="btn ghost" href="/restaurants/${encodeURIComponent(String(r.id))}" target="_blank" rel="noopener">${esc(t("admin.actions.open_restaurant", "Open"))}</a>
      <form class="inline" method="post" action="/admin/restaurants/${encodeURIComponent(String(r.id))}/delete?key=${encodeURIComponent(key)}" onsubmit="return confirm('${esc(deleteConfirm)}')">
        <button class="btn warn" type="submit">${esc(t("admin.actions.remove_from_site", "Remove"))}</button>
      </form>
    </div>`;
}

function renderRestaurantCard(ctx: any, r: RestaurantWithOwner, key: string): string {
  const t = (k: string, fb: string, v?: Record<string, unknown>) => tr(ctx, k, fb, v);
  const cover = currentCoverUrl(r);
  const pending = !r.approved;
  const statusTokens = [pending ? "pending" : "approved", (r as any).featured ? "featured" : "standard", r.owner ? "owned" : "unowned"].join(" ");
  const ownerName = r.owner
    ? (`${r.owner.firstName ?? ""} ${r.owner.lastName ?? ""}`.trim() || r.owner.email || "—")
    : "—";
  const ownerEmail = r.owner?.email || "";

  return `
    <article
      class="entity-card restaurant-card"
      data-search-item
      data-status="${esc(statusTokens)}"
      data-search-text="${esc(restaurantSearchText(r))}"
    >
      <div class="entity-media ${cover ? "has-photo" : "has-fallback"}">
        ${cover
          ? `<img src="${esc(cover)}" alt="${esc(r.name)}" loading="lazy"/>`
          : `<span>${esc(initials(r.name || "Restaurant"))}</span>`}
      </div>
      <div class="entity-body">
        <div class="entity-head">
          <div class="entity-title-wrap">
            <div class="eyebrow">${esc(pending ? t("admin.status.pending", "Pending") : t("admin.status.approved", "Approved"))}</div>
            <h3>${esc(compact(r.name, "Restaurant"))}</h3>
            <p class="entity-subtitle">${esc([compact(r.city, "—"), compact(r.address, "—")].join(" · "))}</p>
          </div>
          <div class="badge-row">
            <span class="status-badge ${pending ? "pending" : "approved"}">${pending ? "⏳" : "✅"} ${esc(pending ? t("admin.status.pending", "Pending") : t("admin.status.approved", "Approved"))}</span>
            ${(r as any).featured ? `<span class="status-badge featured">⭐ ${esc(t("admin.status.featured", "Featured"))}</span>` : ""}
            ${r.owner ? `<span class="status-badge neutral" title="${esc(ownerEmail)}">${esc(ownerName)}</span>` : ""}
          </div>
        </div>

        <div class="meta-row">${restaurantMetaChips(ctx, r)}</div>

        ${r.owner
          ? `<div class="inline-note"><strong>${esc(t("admin.tables.th.owner", "Owner"))}:</strong> ${esc(ownerName)}${ownerEmail ? ` · <span dir="ltr">${esc(ownerEmail)}</span>` : ""}</div>`
          : `<div class="inline-note">${esc(t("common.none", "None"))}</div>`}

        ${(r as any).featured
          ? `<div class="cover-block"><div class="cover-title">${esc(t("admin.cover.label", "Cover image"))}</div>${renderCoverPicker(ctx, r, key)}</div>`
          : ""}

        ${renderRestaurantActions(ctx, r, key)}
      </div>
    </article>`;
}

function renderUserCard(ctx: any, u: UserWithRestaurants, key: string): string {
  const t = (k: string, fb: string, v?: Record<string, unknown>) => tr(ctx, k, fb, v);
  const isInactive = u.isActive === false;
  const restaurants = Array.isArray(u.restaurants) ? u.restaurants : [];
  const displayName = `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || u.email || "User";
  return `
    <article
      class="entity-card user-card"
      data-search-item
      data-status="${esc(isInactive ? "inactive" : "active")} ${esc(String(u.role ?? "user").toLowerCase())}"
      data-search-text="${esc(userSearchText(u))}"
    >
      <div class="entity-media has-fallback"><span>${esc(initials(displayName))}</span></div>
      <div class="entity-body">
        <div class="entity-head">
          <div class="entity-title-wrap">
            <div class="eyebrow">${esc(u.role ?? "user")}</div>
            <h3>${esc(displayName)}</h3>
            <p class="entity-subtitle" dir="ltr">${esc(u.email || "")}</p>
          </div>
          <div class="badge-row">
            <span class="status-badge ${isInactive ? "danger" : "approved"}">${isInactive ? "⛔" : "✅"} ${esc(isInactive ? t("admin.owner.inactive", "Inactive") : t("admin.owner.active", "Active"))}</span>
            <span class="status-badge neutral">${esc(u.provider ?? "local")}</span>
          </div>
        </div>

        <div class="meta-row">
          <span class="meta-pill">${esc(t("admin.users.th.role", "Role"))}: ${esc(u.role ?? "user")}</span>
          <span class="meta-pill">${esc(t("admin.users.th.restaurants", "Restaurants"))}: ${esc(String(restaurants.length))}</span>
        </div>

        <div class="restaurant-pill-list">
          ${restaurants.length
            ? restaurants.map((r) => `<a class="restaurant-pill" href="/restaurants/${encodeURIComponent(String(r.id))}" target="_blank" rel="noopener">${esc(r.name)}</a>`).join("")
            : `<span class="muted">${esc(t("common.none", "None"))}</span>`}
        </div>

        <div class="action-row">
          ${isInactive
            ? `<form class="inline" method="post" action="/admin/users/${encodeURIComponent(String(u.id))}/activate?key=${encodeURIComponent(key)}"><button class="btn" type="submit">${esc(t("admin.users.activate", "Activate"))}</button></form>`
            : `<form class="inline" method="post" action="/admin/users/${encodeURIComponent(String(u.id))}/deactivate?key=${encodeURIComponent(key)}" onsubmit="return confirm('${esc(`${t("admin.users.confirm_deactivate", "Deactivate user")} ${u.email ?? ""}?`)}')"><button class="btn secondary" type="submit">${esc(t("admin.users.deactivate", "Deactivate"))}</button></form>`}
          <form class="inline" method="post" action="/admin/users/${encodeURIComponent(String(u.id))}/delete?key=${encodeURIComponent(key)}" onsubmit="return confirm('${esc(t("admin.users.confirm_delete", "Deleting a user will also delete all their restaurants and reservations. Continue?"))}')">
            <button class="btn warn" type="submit">${esc(t("admin.users.delete", "Delete"))}</button>
          </form>
        </div>
      </div>
    </article>`;
}

function page(
  ctx: any,
  layout: { title: string; body: string; key?: string },
) {
  const keyMasked = (layout.key ?? "").replace(/./g, "•");
  const { lang, dir } = langDir(ctx);
  const t = (k: string, fb: string, v?: Record<string, unknown>) => tr(ctx, k, fb, v);

  return `<!doctype html>
<html lang="${lang}" dir="${dir}" data-lang="${lang}">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="color-scheme" content="dark light">
  <title>${esc(layout.title)}</title>
  <link rel="stylesheet" href="/public/css/spotbook.css?v=${encodeURIComponent(BUILD_TAG)}"/>
  <style>
    :root{
      --wrap-max:1380px;
      --ink-dim:#98a2b3;
      --line-soft:rgba(255,255,255,.08);
      --line-strong:rgba(125,211,252,.18);
      --panel-strong:rgba(8,12,17,.88);
      --panel-soft:rgba(17,24,39,.72);
      --accent:#7dd3fc;
      --accent-2:#38bdf8;
      --good:#22c55e;
      --warn:#ef4444;
      --gold:#fbbf24;
      --radius-xl:24px;
      --radius-lg:18px;
      --radius-md:14px;
      --shadow-xl:0 20px 50px rgba(0,0,0,.34);
      --shadow-md:0 10px 30px rgba(0,0,0,.22);
    }
    html,body{ min-height:100%; }
    body.sb-body.admin{
      margin:0;
      font-family:'Rubik',system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
      color:var(--ink);
      background:
        radial-gradient(circle at top left, rgba(56,189,248,.16), transparent 34%),
        radial-gradient(circle at top right, rgba(251,191,36,.10), transparent 25%),
        linear-gradient(180deg, #071019 0%, #0b1320 42%, #0c1117 100%);
      -webkit-text-size-adjust:100%;
      text-size-adjust:100%;
    }
    *{ box-sizing:border-box; }
    img{ display:block; max-width:100%; }
    a{ color:inherit; }
    [hidden]{ display:none !important; }
    .wrap{ max-width:var(--wrap-max); margin:0 auto; padding:0 20px; }
    .appbar{
      position:sticky; top:0; z-index:60;
      background:linear-gradient(180deg, rgba(5,10,16,.94), rgba(5,10,16,.74));
      border-bottom:1px solid var(--line-soft);
      backdrop-filter:blur(14px) saturate(140%);
    }
    .appbar-row{
      display:flex; align-items:center; justify-content:space-between; gap:14px;
      min-height:72px; padding:12px 0; flex-wrap:wrap;
    }
    .brand{
      display:flex; align-items:center; gap:12px; text-decoration:none; min-width:0;
    }
    .brand-logo-sm{
      width:42px; height:42px; object-fit:contain; padding:6px;
      border-radius:14px; background:linear-gradient(180deg, rgba(125,211,252,.16), rgba(125,211,252,.04));
      border:1px solid rgba(125,211,252,.18);
      box-shadow:inset 0 1px 0 rgba(255,255,255,.08);
    }
    .brand-copy{ min-width:0; }
    .brand-title{ font-size:clamp(16px,2.2vw,20px); font-weight:800; letter-spacing:.02em; }
    .brand-subtitle{ color:var(--ink-dim); font-size:12px; margin-top:2px; }
    .hdr-right{ display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
    .pill{
      display:inline-flex; align-items:center; gap:8px; min-height:38px; padding:0 14px;
      border-radius:999px; font-size:12px; font-weight:800; letter-spacing:.12em;
      background:rgba(125,211,252,.12); border:1px solid rgba(125,211,252,.26);
      color:#dff6ff; text-transform:uppercase;
    }
    .pill::before{
      content:""; width:8px; height:8px; border-radius:999px; background:var(--accent);
      box-shadow:0 0 14px rgba(125,211,252,.8);
    }
    .lang-switch-admin{ position:relative; }
    .lang-btn-admin{
      display:inline-flex; align-items:center; justify-content:center;
      width:40px; height:40px; border-radius:999px;
      border:1px solid rgba(255,255,255,.12);
      background:linear-gradient(180deg, rgba(255,255,255,.08), rgba(255,255,255,.03));
      cursor:pointer; transition:transform .18s ease, background .18s ease, border-color .18s ease;
      box-shadow:inset 0 2px 10px rgba(0,0,0,.18);
    }
    .lang-btn-admin:hover{ transform:translateY(-1px); border-color:rgba(125,211,252,.4); background:rgba(255,255,255,.1); }
    .lang-btn-admin::before{ content:"🌐"; font-size:18px; line-height:1; }
    .lang-menu-admin{
      position:absolute; inset-inline-end:0; top:calc(100% + 8px);
      min-width:148px; padding:6px;
      border-radius:16px; border:1px solid rgba(255,255,255,.1);
      background:rgba(7,16,25,.94); box-shadow:0 18px 36px rgba(0,0,0,.34);
      backdrop-filter:blur(14px);
      opacity:0; transform:translateY(-6px) scale(.98); pointer-events:none;
      transition:opacity .16s ease, transform .16s ease;
    }
    .lang-menu-admin.open{ opacity:1; transform:translateY(0) scale(1); pointer-events:auto; }
    .lang-item-admin{
      display:block; padding:10px 12px; border-radius:12px; text-decoration:none; font-weight:700;
      color:#e2e8f0; text-align:center; font-size:13px;
    }
    .lang-item-admin:hover, .lang-item-admin.active{ background:rgba(255,255,255,.08); }
    .main-area{ padding:22px 0 34px; }
    .debug{
      display:inline-flex; align-items:center; gap:8px; padding:8px 12px; border-radius:999px;
      font-size:12px; color:#f1e8bf; margin-bottom:16px;
      background:rgba(251,191,36,.12); border:1px solid rgba(251,191,36,.3);
    }
    .debug::before{ content:"Build"; color:#fbbf24; font-weight:800; }
    .hero{
      position:relative; overflow:hidden; margin-bottom:18px;
      border-radius:var(--radius-xl); border:1px solid var(--line-strong);
      background:
        linear-gradient(135deg, rgba(8,18,29,.92), rgba(13,23,35,.96)),
        radial-gradient(circle at top right, rgba(125,211,252,.18), transparent 30%);
      box-shadow:var(--shadow-xl);
      padding:22px;
    }
    .hero::after{
      content:""; position:absolute; inset:auto -40px -40px auto; width:220px; height:220px; pointer-events:none;
      background:radial-gradient(circle, rgba(125,211,252,.18), transparent 70%);
      filter:blur(6px);
    }
    .hero-top{
      display:flex; align-items:flex-start; justify-content:space-between; gap:18px; flex-wrap:wrap;
    }
    .hero-copy{ max-width:780px; }
    .hero-title{ margin:0; font-size:clamp(24px,4vw,36px); line-height:1.05; }
    .hero-subtitle{ margin:10px 0 0; max-width:780px; color:var(--ink-dim); font-size:14px; }
    .section-kicker{
      display:inline-flex; align-items:center; gap:8px; margin-bottom:12px; padding:7px 12px;
      border-radius:999px; color:#d8f3ff; font-size:12px; font-weight:800; letter-spacing:.12em; text-transform:uppercase;
      background:rgba(125,211,252,.1); border:1px solid rgba(125,211,252,.22);
    }
    .section-kicker::before{ content:""; width:7px; height:7px; border-radius:999px; background:var(--accent); box-shadow:0 0 14px rgba(125,211,252,.8); }
    .stats-grid{
      display:grid; gap:14px; margin-top:18px;
      grid-template-columns:repeat(4,minmax(0,1fr));
    }
    .stat-card{
      padding:16px 16px 15px; border-radius:18px;
      background:linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.03));
      border:1px solid rgba(255,255,255,.08);
      box-shadow:inset 0 1px 0 rgba(255,255,255,.05);
      min-height:112px;
    }
    .stat-card.tone-good{ border-color:rgba(34,197,94,.22); background:linear-gradient(180deg, rgba(34,197,94,.10), rgba(255,255,255,.02)); }
    .stat-card.tone-warn{ border-color:rgba(239,68,68,.24); background:linear-gradient(180deg, rgba(239,68,68,.10), rgba(255,255,255,.02)); }
    .stat-card.tone-gold{ border-color:rgba(251,191,36,.24); background:linear-gradient(180deg, rgba(251,191,36,.10), rgba(255,255,255,.02)); }
    .stat-card.tone-cyan{ border-color:rgba(56,189,248,.24); background:linear-gradient(180deg, rgba(56,189,248,.10), rgba(255,255,255,.02)); }
    .stat-label{ color:var(--ink-dim); font-size:12px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; }
    .stat-value{ margin-top:10px; font-size:clamp(26px,4vw,36px); font-weight:900; line-height:1; }
    .stat-note{ margin-top:10px; color:#d6e3ef; font-size:13px; }
    .tabs{ display:flex; gap:8px; flex-wrap:wrap; }
    .tab{
      display:inline-flex; align-items:center; justify-content:center; min-height:42px; padding:0 14px;
      border-radius:999px; text-decoration:none; font-weight:700; font-size:14px;
      border:1px solid rgba(255,255,255,.1); color:var(--ink);
      background:rgba(255,255,255,.02);
      transition:transform .18s ease, border-color .18s ease, background .18s ease;
    }
    .tab:hover{ transform:translateY(-1px); border-color:rgba(125,211,252,.34); }
    .tab.active{ background:rgba(125,211,252,.14); border-color:rgba(125,211,252,.36); color:#e2f8ff; }
    .panel{
      margin-bottom:18px; padding:18px; border-radius:22px;
      border:1px solid rgba(255,255,255,.08);
      background:linear-gradient(180deg, rgba(15,21,30,.88), rgba(10,14,20,.94));
      box-shadow:var(--shadow-md);
    }
    .panel.tight{ padding:14px; }
    .toolbar{
      display:flex; gap:14px; justify-content:space-between; align-items:center; flex-wrap:wrap;
    }
    .toolbar-title{ margin:0; font-size:18px; }
    .toolbar-subtitle{ margin:6px 0 0; color:var(--ink-dim); font-size:13px; }
    .search-wrap{ flex:1 1 320px; max-width:560px; position:relative; }
    .search-wrap::before{
      content:"⌕"; position:absolute; top:50%; ${dir === "rtl" ? "right:14px;" : "left:14px;"}
      transform:translateY(-50%); color:var(--ink-dim); font-size:16px;
    }
    .search-input{
      width:100%; min-height:48px; border-radius:16px;
      border:1px solid rgba(255,255,255,.1);
      background:rgba(255,255,255,.04); color:var(--ink); outline:none;
      padding:${dir === "rtl" ? "0 42px 0 16px" : "0 16px 0 42px"}; font-size:14px;
      transition:border-color .18s ease, box-shadow .18s ease, background .18s ease;
    }
    .search-input:focus{ border-color:rgba(125,211,252,.42); box-shadow:0 0 0 3px rgba(125,211,252,.14); background:rgba(255,255,255,.06); }
    .chip-row{ display:flex; gap:8px; flex-wrap:wrap; }
    .filter-chip{
      display:inline-flex; align-items:center; justify-content:center; min-height:38px; padding:0 12px;
      border-radius:999px; border:1px solid rgba(255,255,255,.1); cursor:pointer;
      background:rgba(255,255,255,.03); color:var(--ink); font-weight:700; font-size:13px;
      transition:transform .18s ease, border-color .18s ease, background .18s ease;
    }
    .filter-chip:hover{ transform:translateY(-1px); }
    .filter-chip.active{ background:rgba(125,211,252,.14); border-color:rgba(125,211,252,.36); color:#e6f9ff; }
    .grid-two{ display:grid; gap:18px; grid-template-columns:repeat(2,minmax(0,1fr)); }
    .danger-grid{ display:grid; gap:14px; grid-template-columns:repeat(4,minmax(0,1fr)); }
    .danger-card{
      display:flex; flex-direction:column; gap:12px; min-height:190px;
      padding:18px; border-radius:20px; border:1px solid rgba(239,68,68,.18);
      background:linear-gradient(180deg, rgba(239,68,68,.08), rgba(255,255,255,.02));
    }
    .danger-card h3{ margin:0; font-size:18px; }
    .danger-card p{ margin:0; color:var(--ink-dim); font-size:13px; line-height:1.5; }
    .danger-eyebrow{ font-size:11px; font-weight:800; letter-spacing:.12em; text-transform:uppercase; color:#ffb4b4; }
    .hint-list{ margin:0; padding-inline-start:18px; color:var(--ink-dim); display:grid; gap:10px; }
    .section-head{
      display:flex; align-items:flex-start; justify-content:space-between; gap:14px; flex-wrap:wrap; margin-bottom:14px;
    }
    .section-head h2{ margin:0; font-size:22px; }
    .section-head p{ margin:6px 0 0; color:var(--ink-dim); font-size:13px; }
    .count-badge{
      display:inline-flex; align-items:center; justify-content:center; min-height:40px; padding:0 12px;
      border-radius:999px; font-weight:800; font-size:13px;
      background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.08);
    }
    .entity-grid{ display:grid; gap:16px; grid-template-columns:repeat(2,minmax(0,1fr)); }
    .entity-card{
      display:grid; grid-template-columns:132px minmax(0,1fr); gap:16px; align-items:start;
      padding:16px; border-radius:22px;
      border:1px solid rgba(255,255,255,.08);
      background:linear-gradient(180deg, rgba(255,255,255,.04), rgba(255,255,255,.02));
      box-shadow:inset 0 1px 0 rgba(255,255,255,.04);
    }
    .entity-media{
      min-height:132px; border-radius:18px; overflow:hidden;
      border:1px solid rgba(255,255,255,.08);
      background:linear-gradient(180deg, rgba(125,211,252,.10), rgba(255,255,255,.02));
      display:flex; align-items:center; justify-content:center; position:relative;
    }
    .entity-media img{ width:100%; height:100%; object-fit:cover; aspect-ratio:1/1; }
    .entity-media.has-fallback span{
      display:flex; align-items:center; justify-content:center; width:68px; height:68px; border-radius:999px;
      background:rgba(125,211,252,.16); color:#e8fbff; font-weight:900; font-size:24px;
      border:1px solid rgba(125,211,252,.22);
    }
    .entity-body{ min-width:0; }
    .entity-head{
      display:flex; justify-content:space-between; gap:12px; align-items:flex-start; flex-wrap:wrap;
    }
    .entity-title-wrap{ min-width:0; }
    .eyebrow{ font-size:11px; font-weight:800; letter-spacing:.12em; text-transform:uppercase; color:var(--accent); }
    .entity-card h3{ margin:6px 0 0; font-size:20px; line-height:1.15; }
    .entity-subtitle{ margin:8px 0 0; color:var(--ink-dim); font-size:13px; line-height:1.5; }
    .badge-row{ display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end; }
    .status-badge{
      display:inline-flex; align-items:center; gap:6px; min-height:32px; padding:0 10px;
      border-radius:999px; font-weight:700; font-size:12px;
      border:1px solid rgba(255,255,255,.08); background:rgba(255,255,255,.04);
      white-space:nowrap;
    }
    .status-badge.approved{ background:rgba(34,197,94,.12); border-color:rgba(34,197,94,.24); color:#dcfce7; }
    .status-badge.pending{ background:rgba(251,191,36,.12); border-color:rgba(251,191,36,.24); color:#fef3c7; }
    .status-badge.featured{ background:rgba(251,191,36,.16); border-color:rgba(251,191,36,.28); color:#fde68a; }
    .status-badge.danger{ background:rgba(239,68,68,.12); border-color:rgba(239,68,68,.24); color:#fee2e2; }
    .status-badge.neutral{ color:#dbe6f0; }
    .meta-row{ display:flex; gap:8px; flex-wrap:wrap; margin-top:14px; }
    .meta-pill{
      display:inline-flex; align-items:center; min-height:34px; padding:0 10px;
      border-radius:999px; background:rgba(255,255,255,.04);
      border:1px solid rgba(255,255,255,.06); color:#d4e0ea; font-size:12px;
    }
    .inline-note{
      margin-top:12px; padding:11px 12px; border-radius:14px;
      background:rgba(255,255,255,.03); border:1px solid rgba(255,255,255,.06);
      color:#d7e1ea; font-size:13px; line-height:1.5;
    }
    .cover-block{
      margin-top:14px; padding:14px; border-radius:16px;
      background:rgba(255,255,255,.03); border:1px solid rgba(255,255,255,.06);
    }
    .cover-title{ font-size:12px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; color:var(--ink-dim); margin-bottom:10px; }
    .cover-picker{ display:flex; gap:8px; flex-wrap:wrap; }
    .cover-thumb{
      position:relative; width:64px; height:64px; border-radius:14px; overflow:hidden; padding:0;
      border:2px solid transparent; background:none; cursor:pointer;
      transition:transform .18s ease, border-color .18s ease, box-shadow .18s ease;
    }
    .cover-thumb img{ width:100%; height:100%; object-fit:cover; }
    .cover-thumb:hover{ transform:translateY(-2px); border-color:rgba(125,211,252,.4); }
    .cover-thumb.is-active{ border-color:var(--accent); box-shadow:0 0 0 4px rgba(125,211,252,.12); }
    .cover-check{
      position:absolute; inset:auto 8px 8px auto; width:22px; height:22px; border-radius:999px;
      display:flex; align-items:center; justify-content:center; background:rgba(7,16,25,.88); color:#dff8ff; font-weight:900;
      border:1px solid rgba(125,211,252,.4);
    }
    .restaurant-pill-list{ display:flex; gap:8px; flex-wrap:wrap; margin-top:14px; }
    .restaurant-pill{
      display:inline-flex; align-items:center; min-height:34px; padding:0 12px; border-radius:999px;
      text-decoration:none; color:#e7f6ff; font-size:12px; font-weight:700;
      background:rgba(125,211,252,.10); border:1px solid rgba(125,211,252,.18);
    }
    .action-row{ display:flex; gap:10px; flex-wrap:wrap; margin-top:16px; }
    .btn{
      display:inline-flex; align-items:center; justify-content:center; min-height:42px; padding:0 14px;
      border-radius:14px; text-decoration:none; cursor:pointer; font-weight:800; font-size:13px;
      border:1px solid transparent; transition:transform .18s ease, filter .18s ease, border-color .18s ease;
      background:linear-gradient(180deg, #a5e8ff, #7dd3fc); color:#03131d;
      box-shadow:0 10px 20px rgba(56,189,248,.12);
    }
    .btn:hover{ transform:translateY(-1px); filter:brightness(.99); }
    .btn.secondary{ background:rgba(255,255,255,.02); color:var(--ink); border-color:rgba(255,255,255,.12); box-shadow:none; }
    .btn.ghost{ background:transparent; color:var(--ink); border-color:rgba(255,255,255,.10); box-shadow:none; }
    .btn.warn{ background:linear-gradient(180deg, #ffb4b4, #ef4444); color:#290c0c; box-shadow:0 10px 20px rgba(239,68,68,.12); }
    .muted{ color:var(--ink-dim); }
    .code{
      font-family:ui-monospace,Consolas,monospace; display:block; overflow:auto;
      background:#071019; border:1px solid rgba(255,255,255,.08); border-radius:16px;
      padding:14px; color:#d7e9f7; white-space:pre-wrap;
    }
    .inline{ display:inline; }
    .empty-state{
      padding:24px; border-radius:20px; text-align:center;
      border:1px dashed rgba(255,255,255,.12); color:var(--ink-dim);
      background:rgba(255,255,255,.02);
    }
    .footer-meta{ margin-top:18px; color:var(--ink-dim); font-size:12px; }
    html[data-lang="ka"] .tab,
    html[data-lang="ka"] .btn,
    html[data-lang="ka"] .filter-chip,
    html[data-lang="ka"] .meta-pill{ font-size:12px; }
    @media (max-width:1200px){
      .stats-grid{ grid-template-columns:repeat(2,minmax(0,1fr)); }
      .danger-grid{ grid-template-columns:repeat(2,minmax(0,1fr)); }
      .entity-grid{ grid-template-columns:1fr; }
    }
    @media (max-width:760px){
      .wrap{ padding:0 14px; }
      .main-area{ padding:16px 0 24px; }
      .hero, .panel{ padding:16px; border-radius:18px; }
      .appbar-row{ min-height:unset; }
      .stats-grid{ grid-template-columns:1fr; }
      .danger-grid, .grid-two{ grid-template-columns:1fr; }
      .entity-card{ grid-template-columns:1fr; }
      .entity-media{ min-height:170px; }
      .badge-row{ justify-content:flex-start; }
      .tabs{ width:100%; }
      .tab{ flex:1 1 120px; }
      .action-row > *{ flex:1 1 140px; }
      .action-row .btn, .action-row button{ width:100%; }
    }
  </style>
</head>
<body class="sb-body admin">
  <header class="appbar">
    <div class="wrap appbar-row">
      <a class="brand" href="/" aria-label="SpotBook">
        <img class="brand-logo-sm" src="/public/img/logo-spotbook.png" alt="SpotBook"/>
        <div class="brand-copy">
          <div class="brand-title">SpotBook · ${esc(t("nav.admin", "Admin"))}</div>
          <div class="brand-subtitle">${esc(t("admin.app.title", "Operations Console"))}</div>
        </div>
      </a>
      <div class="hdr-right">
        <span class="pill">${esc(t("admin.header.badge", "ADMIN"))}</span>
        <div class="lang-switch-admin">
          <button class="lang-btn-admin" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="langMenuAdmin" title="${esc(t("nav.language", "Language"))}"></button>
          <div class="lang-menu-admin" id="langMenuAdmin" role="menu">
            <a class="lang-item-admin ${lang === "en" ? "active" : ""}" href="${langLink(ctx, "en")}" role="menuitem">EN</a>
            <a class="lang-item-admin ${lang === "ka" ? "active" : ""}" href="${langLink(ctx, "ka")}" role="menuitem">GE</a>
            <a class="lang-item-admin ${lang === "he" ? "active" : ""}" href="${langLink(ctx, "he")}" role="menuitem">HE</a>
          </div>
        </div>
      </div>
    </div>
  </header>

  <main class="wrap main-area">
    <div class="debug">${esc(BUILD_TAG)}</div>
    ${layout.body}
    <div class="footer-meta">${esc(t("admin.key_masked", "Key masked"))}: ${esc(keyMasked)}</div>
  </main>

  <script>
    (function(){
      const wrap = document.querySelector('.lang-switch-admin');
      if (!wrap) return;
      const btn = wrap.querySelector('.lang-btn-admin');
      const menu = document.getElementById('langMenuAdmin');
      if (!btn || !menu) return;
      const openMenu = () => { menu.classList.add('open'); btn.setAttribute('aria-expanded','true'); };
      const closeMenu = () => { menu.classList.remove('open'); btn.setAttribute('aria-expanded','false'); };
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.classList.contains('open') ? closeMenu() : openMenu();
      });
      document.addEventListener('click', (e) => {
        if (!menu.contains(e.target) && e.target !== btn) closeMenu();
      });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
    })();

    (function(){
      document.querySelectorAll('[data-search-root]').forEach((root) => {
        const input = root.querySelector('[data-search-input]');
        const chips = Array.from(root.querySelectorAll('[data-filter-chip]'));
        const sections = Array.from(root.querySelectorAll('[data-filter-section]'));
        let filter = 'all';

        const apply = () => {
          const q = (input?.value || '').trim().toLowerCase();
          let totalVisible = 0;
          sections.forEach((section) => {
            const items = Array.from(section.querySelectorAll('[data-search-item]'));
            let visible = 0;
            items.forEach((item) => {
              const hay = ((item.getAttribute('data-search-text') || item.textContent || '') + '').toLowerCase();
              const status = (item.getAttribute('data-status') || '').split(/\s+/).filter(Boolean);
              const qOk = !q || hay.includes(q);
              const fOk = filter === 'all' || status.includes(filter);
              const show = qOk && fOk;
              item.hidden = !show;
              if (show) visible++;
            });
            totalVisible += visible;
            const empty = section.querySelector('[data-empty-placeholder]');
            if (empty) empty.hidden = visible > 0;
            section.hidden = visible === 0;
            const badge = section.querySelector('.count-badge');
            if (badge) badge.textContent = String(visible);
          });

          let rootEmpty = root.querySelector('[data-root-empty]');
          if (!rootEmpty) {
            rootEmpty = document.createElement('div');
            rootEmpty.className = 'empty-state';
            rootEmpty.setAttribute('data-root-empty', '');
            rootEmpty.hidden = true;
            rootEmpty.textContent = root.getAttribute('data-empty-message') || 'No matching results.';
            root.appendChild(rootEmpty);
          }
          rootEmpty.hidden = totalVisible > 0;
        };

        input?.addEventListener('input', apply);
        chips.forEach((chip) => {
          chip.addEventListener('click', () => {
            chips.forEach((c) => c.classList.remove('active'));
            chip.classList.add('active');
            filter = chip.getAttribute('data-filter-status') || 'all';
            apply();
          });
        });
        apply();
      });
    })();
  </script>
</body>
</html>`;
}

const adminRouter = new Router();

adminRouter.get("/admin/login", (ctx) => {
  setNoStore(ctx);
  const t = (k: string, fb: string, v?: Record<string, unknown>) => tr(ctx, k, fb, v);
  const body = `
    <section class="hero" style="max-width:760px;margin-inline:auto;">
      <div class="section-kicker">${esc(t("admin.header.badge", "ADMIN"))}</div>
      <div class="hero-top">
        <div class="hero-copy">
          <h1 class="hero-title">${esc(t("admin.login.title", "Admin Login"))}</h1>
          <p class="hero-subtitle">${esc(t("admin.login.desc", "Enter the ADMIN_SECRET defined in your environment variables."))}</p>
        </div>
      </div>
      <div class="panel" style="margin:18px 0 0;">
        <form method="get" action="/admin">
          <div class="toolbar" style="align-items:end;">
            <div class="search-wrap" style="max-width:none; flex:1 1 100%;">
              <input id="key" name="key" type="password" class="search-input" placeholder="${esc(t("admin.login.key_placeholder", "Paste the key here"))}" required autocomplete="current-password"/>
            </div>
            <button class="btn" type="submit">${esc(t("admin.login.submit", "Sign in"))}</button>
          </div>
        </form>
        <ul class="hint-list" style="margin-top:16px;">
          <li>${esc(t("admin.login.key_label", "Admin key"))}</li>
          <li>${esc(t("admin.confirm.title", "Sensitive actions require confirmation"))}</li>
          <li>${esc(t("admin.ui.login_help", "Use the console for approvals, users, and maintenance operations."))}</li>
        </ul>
      </div>
    </section>`;
  ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
  ctx.response.body = page(ctx, { title: t("admin.head.dashboard", "Dashboard · Admin"), body });
});

adminRouter.get("/admin", async (ctx) => {
  if (!assertAdmin(ctx)) return;
  setNoStore(ctx);
  const key = getAdminKey(ctx)!;
  const t = (k: string, fb: string, v?: Record<string, unknown>) => tr(ctx, k, fb, v);

  const { listRestaurantsWithOwners } = await getDbExtra();
  const rows: RestaurantWithOwner[] = typeof listRestaurantsWithOwners === "function"
    ? await listRestaurantsWithOwners("")
    : (await listRestaurants("", false) as RestaurantWithOwner[]);

  const pending = rows.filter((r) => !r.approved);
  const approved = rows.filter((r) => r.approved);
  const featured = rows.filter((r) => Boolean((r as any).featured));
  const ownersMissing = rows.filter((r) => !r.owner).length;

  const body = `
    <section class="hero">
      <div class="section-kicker">${esc(t("admin.header.badge", "ADMIN"))}</div>
      <div class="hero-top">
        <div class="hero-copy">
          <h1 class="hero-title">${esc(t("admin.head.dashboard", "Dashboard · Admin"))}</h1>
          <p class="hero-subtitle">${esc(t("admin.ui.dashboard_intro", "Central place for restaurant approvals, homepage featuring, and maintenance tasks."))}</p>
        </div>
        ${tabs(ctx, key, "restaurants")}
      </div>
      <div class="stats-grid">
        ${statCard(t("admin.tabs.restaurants", "Restaurants"), num(rows.length), "cyan", t("admin.tables.th.restaurant", "Total restaurants"))}
        ${statCard(t("admin.tables.pending_title", "Pending"), num(pending.length), "warn", t("admin.status.pending", "Need approval"))}
        ${statCard(t("admin.tables.approved_title", "Approved"), num(approved.length), "good", t("admin.status.approved", "Live on site"))}
        ${statCard(t("admin.status.featured", "Featured"), num(featured.length), "gold", ownersMissing ? `${ownersMissing} ${t("admin.tables.th.owner", "owner")} ${t("admin.ui.unlinked", "unlinked")}` : t("admin.actions.feature_tip", "Homepage picks"))}
      </div>
    </section>

    <section class="panel">
      <div class="danger-grid">
        <article class="danger-card">
          <div class="danger-eyebrow">${esc(t("admin.ui.quick_maintenance", "Quick maintenance"))}</div>
          <h3>${esc(t("admin.reset.btn.restaurants", "Reset restaurants"))}</h3>
          <p>${esc(t("admin.reset.confirm.restaurants", "Reset all restaurants? This action cannot be undone!"))}</p>
          <form method="post" action="/admin/reset?what=restaurants&confirm=1&key=${encodeURIComponent(key)}"><button type="submit" class="btn warn" onclick="return confirm('${esc(t("admin.reset.confirm.restaurants", "Reset all restaurants? This action cannot be undone!"))}')">${esc(t("admin.reset.btn.restaurants", "Reset restaurants"))}</button></form>
        </article>
        <article class="danger-card">
          <div class="danger-eyebrow">${esc(t("admin.ui.quick_maintenance", "Quick maintenance"))}</div>
          <h3>${esc(t("admin.reset.btn.reservations", "Reset reservations"))}</h3>
          <p>${esc(t("admin.reset.confirm.reservations", "Reset all reservations?"))}</p>
          <form method="post" action="/admin/reset?what=reservations&confirm=1&key=${encodeURIComponent(key)}"><button type="submit" class="btn warn" onclick="return confirm('${esc(t("admin.reset.confirm.reservations", "Reset all reservations?"))}')">${esc(t("admin.reset.btn.reservations", "Reset reservations"))}</button></form>
        </article>
        <article class="danger-card">
          <div class="danger-eyebrow">${esc(t("admin.ui.quick_maintenance", "Quick maintenance"))}</div>
          <h3>${esc(t("admin.reset.btn.users", "Reset users"))}</h3>
          <p>${esc(t("admin.reset.confirm.users", "Reset all users? Note: this will also delete restaurant owners."))}</p>
          <form method="post" action="/admin/reset?what=users&confirm=1&key=${encodeURIComponent(key)}"><button type="submit" class="btn warn" onclick="return confirm('${esc(t("admin.reset.confirm.users", "Reset all users? Note: this will also delete restaurant owners."))}')">${esc(t("admin.reset.btn.users", "Reset users"))}</button></form>
        </article>
        <article class="danger-card">
          <div class="danger-eyebrow">${esc(t("admin.tabs.tools", "Tools"))}</div>
          <h3>${esc(t("admin.reset.btn.all", "Reset all"))}</h3>
          <p>${esc(t("admin.reset.confirm.all", "Reset everything: users + restaurants + reservations. Continue?"))}</p>
          <div class="action-row" style="margin-top:auto;">
            <form method="post" action="/admin/reset?what=all&confirm=1&key=${encodeURIComponent(key)}"><button type="submit" class="btn warn" onclick="return confirm('${esc(t("admin.reset.confirm.all", "Reset everything: users + restaurants + reservations. Continue?"))}')">${esc(t("admin.reset.btn.all", "Reset all"))}</button></form>
            <a class="btn ghost" href="/admin/tools?key=${encodeURIComponent(key)}">${esc(t("admin.reset.more_tools", "More tools…"))}</a>
          </div>
        </article>
      </div>
    </section>

    <section class="panel" data-search-root data-empty-message="${esc(t("admin.ui.no_matches", "No matching results."))}">
      <div class="toolbar">
        <div>
          <h2 class="toolbar-title">${esc(t("admin.tabs.restaurants", "Restaurants"))}</h2>
          <p class="toolbar-subtitle">${esc(t("admin.ui.restaurant_toolbar_help", "Review restaurants quickly, search by owner, city, or address, and perform actions without leaving the page."))}</p>
        </div>
        <div class="search-wrap">
          <input class="search-input" type="text" data-search-input placeholder="${esc(t("admin.tables.th.restaurant", "Search restaurants, owners, city…"))}"/>
        </div>
      </div>
      <div class="chip-row" style="margin-top:14px;">
        <button class="filter-chip active" type="button" data-filter-chip data-filter-status="all">${esc(t("admin.ui.filter_all", "All"))}</button>
        <button class="filter-chip" type="button" data-filter-chip data-filter-status="pending">${esc(t("admin.status.pending", "Pending"))}</button>
        <button class="filter-chip" type="button" data-filter-chip data-filter-status="approved">${esc(t("admin.status.approved", "Approved"))}</button>
        <button class="filter-chip" type="button" data-filter-chip data-filter-status="featured">${esc(t("admin.status.featured", "Featured"))}</button>
      </div>

      <section class="panel tight" style="margin-top:16px;" data-filter-section>
        <div class="section-head">
          <div>
            <h2>${esc(t("admin.tables.pending_title", "Pending ({count})", { count: pending.length }))}</h2>
            <p>${esc(t("admin.ui.pending_help", "Restaurants waiting for approval are shown here."))}</p>
          </div>
          <div class="count-badge">${esc(String(pending.length))}</div>
        </div>
        <div class="entity-grid">
          ${pending.map((r) => renderRestaurantCard(ctx, r, key)).join("")}
        </div>
        <div class="empty-state" data-empty-placeholder ${pending.length ? "hidden" : ""}>${esc(t("admin.tables.pending_empty", "No pending restaurants at the moment."))}</div>
      </section>

      <section class="panel tight" style="margin-top:16px;" data-filter-section>
        <div class="section-head">
          <div>
            <h2>${esc(t("admin.tables.approved_title", "Approved ({count})", { count: approved.length }))}</h2>
            <p>${esc(t("admin.ui.approved_help", "Approved restaurants stay live and can be featured on the homepage."))}</p>
          </div>
          <div class="count-badge">${esc(String(approved.length))}</div>
        </div>
        <div class="entity-grid">
          ${approved.map((r) => renderRestaurantCard(ctx, r, key)).join("")}
        </div>
        <div class="empty-state" data-empty-placeholder ${approved.length ? "hidden" : ""}>${esc(t("admin.tables.approved_empty", "No restaurants have been approved yet."))}</div>
      </section>
    </section>`;

  ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
  ctx.response.body = page(ctx, { title: t("admin.head.dashboard", "Dashboard · Admin"), body, key });
});

adminRouter.get("/admin/tools", (ctx) => {
  if (!assertAdmin(ctx)) return;
  setNoStore(ctx);
  const key = getAdminKey(ctx)!;
  const t = (k: string, fb: string, v?: Record<string, unknown>) => tr(ctx, k, fb, v);
  const body = `
    <section class="hero">
      <div class="section-kicker">${esc(t("admin.tabs.tools", "Tools"))}</div>
      <div class="hero-top">
        <div class="hero-copy">
          <h1 class="hero-title">${esc(t("admin.tools.title", "Admin Tools"))}</h1>
          <p class="hero-subtitle">${esc(t("admin.ui.tools_intro", "Use these tools carefully. Every destructive action should be confirmed and double-checked."))}</p>
        </div>
        ${tabs(ctx, key, "tools")}
      </div>
      <div class="stats-grid">
        ${statCard(t("admin.tools.reset_restaurants", "Reset restaurants"), "1", "warn", t("admin.confirm.title", "High impact"))}
        ${statCard(t("admin.tools.reset_reservations", "Reset reservations"), "1", "warn", t("admin.confirm.title", "High impact"))}
        ${statCard(t("admin.tools.reset_users", "Reset users"), "1", "warn", t("admin.confirm.title", "High impact"))}
        ${statCard(t("admin.tools.reset_all", "Reset everything"), "1", "gold", t("admin.confirm.title", "Highest impact"))}
      </div>
    </section>

    <div class="grid-two">
      <section class="panel">
        <div class="section-head">
          <div>
            <h2>${esc(t("admin.tools.title", "Danger zone"))}</h2>
            <p>${esc(t("admin.ui.tools_help", "Open a confirmation page before executing any reset."))}</p>
          </div>
        </div>
        <div class="danger-grid" style="grid-template-columns:repeat(2,minmax(0,1fr));">
          <article class="danger-card">
            <div class="danger-eyebrow">Restaurants</div>
            <h3>${esc(t("admin.tools.reset_restaurants", "Reset restaurants"))}</h3>
            <p>${esc(t("admin.reset.confirm.restaurants", "Reset all restaurants? This action cannot be undone!"))}</p>
            <a class="btn warn" href="/admin/reset?what=restaurants&key=${encodeURIComponent(key)}">${esc(t("admin.tools.reset_restaurants", "Reset restaurants"))}</a>
          </article>
          <article class="danger-card">
            <div class="danger-eyebrow">Reservations</div>
            <h3>${esc(t("admin.tools.reset_reservations", "Reset reservations"))}</h3>
            <p>${esc(t("admin.reset.confirm.reservations", "Reset all reservations?"))}</p>
            <a class="btn warn" href="/admin/reset?what=reservations&key=${encodeURIComponent(key)}">${esc(t("admin.tools.reset_reservations", "Reset reservations"))}</a>
          </article>
          <article class="danger-card">
            <div class="danger-eyebrow">Users</div>
            <h3>${esc(t("admin.tools.reset_users", "Reset users"))}</h3>
            <p>${esc(t("admin.reset.confirm.users", "Reset all users? Note: this will also delete restaurant owners."))}</p>
            <a class="btn warn" href="/admin/reset?what=users&key=${encodeURIComponent(key)}">${esc(t("admin.tools.reset_users", "Reset users"))}</a>
          </article>
          <article class="danger-card">
            <div class="danger-eyebrow">System</div>
            <h3>${esc(t("admin.tools.reset_all", "Reset everything"))}</h3>
            <p>${esc(t("admin.reset.confirm.all", "Reset everything: users + restaurants + reservations. Continue?"))}</p>
            <a class="btn warn" href="/admin/reset?what=all&key=${encodeURIComponent(key)}">${esc(t("admin.tools.reset_all", "Reset everything"))}</a>
          </article>
        </div>
      </section>

      <section class="panel">
        <div class="section-head">
          <div>
            <h2>${esc(t("admin.confirm.title", "Before you continue"))}</h2>
            <p>${esc(t("admin.ui.reset_warning", "Resets are immediate and affect production-like data in this environment."))}</p>
          </div>
        </div>
        <ul class="hint-list">
          <li>${esc(t("admin.status.pending", "Pending"))} ${esc(t("admin.ui.restaurant_label", "restaurants"))} — ${esc(t("admin.actions.approve", "approve"))} only after checking the public page and owner details.</li>
          <li>${esc(t("admin.status.featured", "Featured"))} items should have a good cover image selected.</li>
          <li>${esc(t("admin.tools.reset_users", "User reset"))} impacts restaurant ownership and reservations.</li>
          <li>${esc(t("admin.tools.reset_all", "Reset everything"))} should be used only for intentional environment cleanup.</li>
        </ul>
        <div class="action-row" style="margin-top:20px;">
          <a class="btn secondary" href="/admin?key=${encodeURIComponent(key)}">${esc(t("admin.tabs.restaurants", "Restaurants"))}</a>
          <a class="btn secondary" href="/admin/users?key=${encodeURIComponent(key)}">${esc(t("admin.tabs.users", "Users"))}</a>
        </div>
      </section>
    </div>`;
  ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
  ctx.response.body = page(ctx, { title: t("admin.head.dashboard", "Dashboard · Admin"), body, key });
});

async function handleReset(ctx: any) {
  if (!assertAdmin(ctx)) return;
  setNoStore(ctx);
  const key = getAdminKey(ctx)!;
  const url = ctx.request.url;
  const t = (k: string, fb: string, v?: Record<string, unknown>) => tr(ctx, k, fb, v);
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
      <section class="hero" style="max-width:820px;margin-inline:auto;">
        <div class="section-kicker">${esc(t("admin.confirm.title", "Confirm action"))}</div>
        <div class="hero-top">
          <div class="hero-copy">
            <h1 class="hero-title">${esc(t("admin.confirm.head", "Confirm action · Admin"))}</h1>
            <p class="hero-subtitle">${esc(t("admin.confirm.reset_prefix", "Reset"))}: <strong>${esc(what)}</strong></p>
          </div>
        </div>
        <div class="panel" style="margin:18px 0 0;">
          <p class="toolbar-subtitle">${esc(t("admin.confirm.confirm_delete", "Confirm"))} — ${esc(t("admin.ui.confirm_help", "This action cannot be undone once executed."))}</p>
          <div class="action-row">
            <a class="btn warn" href="/admin/reset?what=${encodeURIComponent(what)}&confirm=1&key=${encodeURIComponent(key)}">${esc(t("admin.confirm.confirm_delete", "Confirm"))}</a>
            <a class="btn secondary" href="/admin/tools?key=${encodeURIComponent(key)}">${esc(t("common.cancel", "Cancel"))}</a>
          </div>
        </div>
      </section>`;
    ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
    ctx.response.body = page(ctx, { title: t("admin.confirm.head", "Confirm action · Admin"), body, key });
    return;
  }

  const result = await actions[what]();
  const body = `
    <section class="hero" style="max-width:860px;margin-inline:auto;">
      <div class="section-kicker">${esc(t("admin.done.title", "Done"))}</div>
      <div class="hero-top">
        <div class="hero-copy">
          <h1 class="hero-title">${esc(t("admin.done.head", "Done · Reset"))}</h1>
          <p class="hero-subtitle">${esc(t("admin.done.did_reset", "Reset performed"))}: <strong>${esc(what)}</strong></p>
        </div>
      </div>
      <div class="panel" style="margin:18px 0 0;">
        <pre class="code">${esc(JSON.stringify(result, null, 2))}</pre>
        <div class="action-row">
          <a class="btn" href="/admin/tools?key=${encodeURIComponent(key)}">${esc(t("admin.done.back_tools", "Back to tools"))}</a>
          <a class="btn secondary" href="/admin?key=${encodeURIComponent(key)}">${esc(t("admin.done.back_dashboard", "Back to dashboard"))}</a>
        </div>
      </div>
    </section>`;
  ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
  ctx.response.body = page(ctx, { title: t("admin.done.head", "Done · Reset"), body, key });
}

adminRouter.get("/admin/reset", handleReset);
adminRouter.post("/admin/reset", handleReset);

adminRouter.post("/admin/restaurants/:id/approve", async (ctx) => {
  if (!assertAdmin(ctx)) return;
  setNoStore(ctx);
  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  if (!r) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Restaurant not found";
    return;
  }
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

adminRouter.post("/admin/restaurants/:id/feature", async (ctx) => {
  if (!assertAdmin(ctx)) return;
  setNoStore(ctx);
  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  if (!r) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Restaurant not found";
    return;
  }
  await updateRestaurant(id, { featured: true } as any);
  const key = getAdminKey(ctx)!;
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", `/admin?key=${encodeURIComponent(key)}`);
});

adminRouter.post("/admin/restaurants/:id/unfeature", async (ctx) => {
  if (!assertAdmin(ctx)) return;
  setNoStore(ctx);
  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  if (!r) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Restaurant not found";
    return;
  }
  await updateRestaurant(id, { featured: false } as any);
  const key = getAdminKey(ctx)!;
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", `/admin?key=${encodeURIComponent(key)}`);
});

adminRouter.post("/admin/restaurants/:id/set-cover", async (ctx) => {
  if (!assertAdmin(ctx)) return;
  setNoStore(ctx);
  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  if (!r) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Restaurant not found";
    return;
  }
  const body = ctx.request.body;
  const form = await body.formData();
  const coverUrl = form.get("coverUrl");
  if (typeof coverUrl === "string" && coverUrl.trim()) {
    await updateRestaurant(id, { coverUrl: coverUrl.trim() } as any);
  }
  const key = getAdminKey(ctx)!;
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", `/admin?key=${encodeURIComponent(key)}`);
});

adminRouter.post("/admin/restaurants/:id/delete", async (ctx) => {
  if (!assertAdmin(ctx)) return;
  setNoStore(ctx);
  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  if (!r) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Restaurant not found";
    return;
  }
  const result = await deleteRestaurantCascade(id);
  const key = getAdminKey(ctx)!;
  const t = (k: string, fb: string, v?: Record<string, unknown>) => tr(ctx, k, fb, v);
  const body = `
    <section class="hero" style="max-width:860px;margin-inline:auto;">
      <div class="section-kicker">${esc(t("admin.delete.title", "Removed from site"))}</div>
      <div class="hero-top">
        <div class="hero-copy">
          <h1 class="hero-title">${esc(t("admin.delete.head", "Removed from site · Admin"))}</h1>
          <p class="hero-subtitle">${esc(t("admin.delete.msg", "Restaurant"))} <strong>${esc(r.name)}</strong> ${esc(t("admin.delete.msg_tail", "was removed from the system, including its reservations."))}</p>
        </div>
      </div>
      <div class="panel" style="margin:18px 0 0;">
        <pre class="code">${esc(JSON.stringify(result, null, 2))}</pre>
        <div class="action-row"><a class="btn" href="/admin?key=${encodeURIComponent(key)}">${esc(t("admin.delete.back_dashboard", "Back to dashboard"))}</a></div>
      </div>
    </section>`;
  ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
  ctx.response.body = page(ctx, { title: t("admin.delete.head", "Removed from site · Admin"), body, key });
});

adminRouter.get("/admin/users", async (ctx) => {
  if (!assertAdmin(ctx)) return;
  setNoStore(ctx);
  const key = getAdminKey(ctx)!;
  const t = (k: string, fb: string, v?: Record<string, unknown>) => tr(ctx, k, fb, v);
  const { listUsersWithRestaurants } = await getDbExtra();

  if (typeof listUsersWithRestaurants !== "function") {
    const body = `
      <section class="hero" style="max-width:820px;margin-inline:auto;">
        <div class="section-kicker">${esc(t("admin.tabs.users", "Users"))}</div>
        <div class="hero-top">
          <div class="hero-copy">
            <h1 class="hero-title">${esc(t("admin.users.title", "User Management"))}</h1>
            <p class="hero-subtitle">${esc(t("admin.users.disabled", "This feature requires"))} <code>listUsersWithRestaurants</code> ${esc(t("admin.users.in", "in"))} <code>database.ts</code>.</p>
          </div>
          ${tabs(ctx, key, "users")}
        </div>
        <div class="panel" style="margin:18px 0 0;">
          <p class="toolbar-subtitle">${esc(t("admin.users.add_and_reload", "Add the export and reload the page."))}</p>
          <div class="action-row">
            <a class="btn" href="/admin?key=${encodeURIComponent(key)}">${esc(t("admin.tabs.restaurants", "Restaurants"))}</a>
            <a class="btn secondary" href="/admin/tools?key=${encodeURIComponent(key)}">${esc(t("admin.tabs.tools", "Tools"))}</a>
          </div>
        </div>
      </section>`;
    ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
    ctx.response.body = page(ctx, { title: t("admin.head.dashboard", "Dashboard · Admin"), body, key });
    return;
  }

  const users = await listUsersWithRestaurants();
  const active = users.filter((u) => u.isActive !== false);
  const inactive = users.filter((u) => u.isActive === false);
  const owners = users.filter((u) => String(u.role ?? "").toLowerCase() === "owner");
  const admins = users.filter((u) => String(u.role ?? "").toLowerCase() === "admin");

  const body = `
    <section class="hero">
      <div class="section-kicker">${esc(t("admin.tabs.users", "Users"))}</div>
      <div class="hero-top">
        <div class="hero-copy">
          <h1 class="hero-title">${esc(t("admin.users.title", "User Management"))}</h1>
          <p class="hero-subtitle">${esc(t("admin.ui.users_intro", "Search by name, email, role, or restaurant and manage accounts with fewer clicks."))}</p>
        </div>
        ${tabs(ctx, key, "users")}
      </div>
      <div class="stats-grid">
        ${statCard(t("admin.tabs.users", "Users"), num(users.length), "cyan", t("admin.users.th.user", "All accounts"))}
        ${statCard(t("admin.users.active", "Active users ({count})", { count: active.length }), num(active.length), "good", t("admin.owner.active", "Active"))}
        ${statCard(t("admin.users.inactive", "Disabled users ({count})", { count: inactive.length }), num(inactive.length), "warn", t("admin.owner.inactive", "Inactive"))}
        ${statCard(t("admin.users.th.role", "Roles"), `${owners.length}/${admins.length}`, "gold", `${t("admin.ui.owner_accounts", "Owner accounts")}: ${owners.length} · Admin: ${admins.length}`)}
      </div>
    </section>

    <section class="panel" data-search-root data-empty-message="${esc(t("admin.ui.no_matches", "No matching results."))}">
      <div class="toolbar">
        <div>
          <h2 class="toolbar-title">${esc(t("admin.users.title", "User Management"))}</h2>
          <p class="toolbar-subtitle">${esc(t("admin.ui.user_toolbar_help", "Filter by active status or search by user and restaurant name."))}</p>
        </div>
        <div class="search-wrap">
          <input class="search-input" type="text" data-search-input placeholder="${esc(t("admin.users.th.user", "Search users, emails, restaurants…"))}"/>
        </div>
      </div>
      <div class="chip-row" style="margin-top:14px;">
        <button class="filter-chip active" type="button" data-filter-chip data-filter-status="all">${esc(t("admin.ui.filter_all", "All"))}</button>
        <button class="filter-chip" type="button" data-filter-chip data-filter-status="active">${esc(t("admin.owner.active", "Active"))}</button>
        <button class="filter-chip" type="button" data-filter-chip data-filter-status="inactive">${esc(t("admin.owner.inactive", "Inactive"))}</button>
      </div>

      <section class="panel tight" style="margin-top:16px;" data-filter-section>
        <div class="section-head">
          <div>
            <h2>${esc(t("admin.users.active", "Active users ({count})", { count: active.length }))}</h2>
            <p>${esc(t("admin.users.no_active", "Active users are shown here."))}</p>
          </div>
          <div class="count-badge">${esc(String(active.length))}</div>
        </div>
        <div class="entity-grid">
          ${active.map((u) => renderUserCard(ctx, u, key)).join("")}
        </div>
        <div class="empty-state" data-empty-placeholder ${active.length ? "hidden" : ""}>${esc(t("admin.users.no_active", "No active users."))}</div>
      </section>

      <section class="panel tight" style="margin-top:16px;" data-filter-section>
        <div class="section-head">
          <div>
            <h2>${esc(t("admin.users.inactive", "Disabled users ({count})", { count: inactive.length }))}</h2>
            <p>${esc(t("admin.users.no_inactive", "Disabled users are shown here."))}</p>
          </div>
          <div class="count-badge">${esc(String(inactive.length))}</div>
        </div>
        <div class="entity-grid">
          ${inactive.map((u) => renderUserCard(ctx, u, key)).join("")}
        </div>
        <div class="empty-state" data-empty-placeholder ${inactive.length ? "hidden" : ""}>${esc(t("admin.users.no_inactive", "No disabled users."))}</div>
      </section>
    </section>`;

  ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
  ctx.response.body = page(ctx, { title: t("admin.head.dashboard", "Dashboard · Admin"), body, key });
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
  await setUserActive(ctx.params.id!, false);
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
  await setUserActive(ctx.params.id!, true);
  const key = getAdminKey(ctx)!;
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", `/admin/users?key=${encodeURIComponent(key)}`);
});

adminRouter.post("/admin/users/:id/delete", async (ctx) => {
  if (!assertAdmin(ctx)) return;
  setNoStore(ctx);
  const { deleteUserCascade } = await getDbExtra();
  if (typeof deleteUserCascade !== "function") {
    ctx.response.status = Status.NotImplemented;
    ctx.response.body = "deleteUserCascade is not implemented in database.ts";
    return;
  }
  await deleteUserCascade(ctx.params.id!);
  const key = getAdminKey(ctx)!;
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", `/admin/users?key=${encodeURIComponent(key)}`);
});

export { adminRouter };
export default adminRouter;
