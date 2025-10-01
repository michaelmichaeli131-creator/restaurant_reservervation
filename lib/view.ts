// src/lib/view.ts
// Safe Eta renderer: אם תבנית חסרה/שגויה - נחזיר fallback HTML/JSON במקום לזרוק חריגה.

import { Eta } from "npm:eta@3.5.0";
import type { Context } from "jsr:@oak/oak";

// ==== תיקון נתיב התבניות ====
// אצלך התבניות יושבות ב-/templates (שורש הפרויקט), לכן נגדיר לשם במפורש.
// בנוסף נשמור רשימת נתיבי fallback נפוצים כדי לעבוד גם בסביבות אחרות.
const PRIMARY_VIEWS_DIR = "/templates";
const FALLBACK_DIRS = [
  "/src/templates",
  // יחסית למיקום הקובץ (ייתרון במבני פרויקט שונים)
  new URL("../../templates/", import.meta.url).pathname,
  new URL("../templates/", import.meta.url).pathname,
];

// נבחר את הספרייה הראשונה; אין לנו הבטחת FS ב-Deploy, לכן לא נעשה stat, רק נשתמש בראשונה.
// אם היא לא תעבוד, תופיע ב-fallback למטה ותדע מה הוגדר בפועל.
const VIEWS_DIR = PRIMARY_VIEWS_DIR;

// יצירת מופע Eta עם קונפיגורציה
const eta = new Eta({
  views: VIEWS_DIR,
  cache: true,
  async: true,
  useWith: true, // מאפשר שימוש ב-"it" בתבניות
});

// זיהוי אם הלקוח מעדיף JSON
function wantsJSON(ctx: Context) {
  const acc = ctx.request.headers.get("accept") ?? "";
  return acc.includes("application/json");
}

// HTML fallback מינימלי כשאין תבנית
function fallbackHtml(title: string, data: Record<string, unknown>) {
  const safeTitle = title || "GeoTable";
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${safeTitle}</title>
  <link rel="stylesheet" href="/static/styles.css"/>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:900px;margin:32px auto;padding:0 16px}
    .card{border:1px solid #eee;border-radius:12px;padding:16px}
    pre{background:#f6f6f8;border:1px solid #eee;border-radius:8px;padding:12px;overflow:auto}
    .muted{color:#777}
    code{background:#f6f6f8;border:1px solid #eee;padding:2px 6px;border-radius:6px}
  </style>
</head>
<body>
  <h1 style="margin-top:0">${safeTitle}</h1>
  <div class="card">
    <p class="muted">תבנית לא נמצאה או נכשלה ברינדור. מוצג fallback.</p>
    <p class="muted">views: <code>${escapeHtml(VIEWS_DIR)}</code></p>
    <p class="muted">fallbacks tried: <code>${escapeHtml(FALLBACK_DIRS.join(", "))}</code></p>
    <pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre>
  </div>
</body>
</html>`;
}

function escapeHtml(s: string) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * render(ctx, template, data)
 * - מנסה לרנדר את Eta template דרך המופע.
 * - אם חסר/נכשל => fallback HTML (או JSON אם הלקוח ביקש).
 */
export async function render(
  ctx: Context,
  template: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  try {
    // הזרקת משתמש (אם נטען ע"י ה-session middleware) כדי שה-layout יציג "מחובר"
    const user = (ctx.state as any)?.user ?? null;
    const payload = { ...data, user };

    if (wantsJSON(ctx)) {
      ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
      ctx.response.body = JSON.stringify(payload, null, 2);
      return;
    }

    // ניסיון רינדור התבנית
    const html = await eta.renderAsync(template, payload);
    if (typeof html === "string") {
      ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
      ctx.response.body = html;
      return;
    }

    // מקרה קצה: renderAsync החזירה undefined
    console.warn(`[view] template "${template}" rendered empty, using fallback (views="${VIEWS_DIR}")`);
    ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
    ctx.response.body = fallbackHtml(String(data?.title ?? template), data);
  } catch (err: any) {
    const reqId = (ctx.state as any)?.reqId ?? "-";
    console.warn(
      `[view ${reqId}] render failed for template="${template}" (views="${VIEWS_DIR}") → fallback. Error:`,
      err?.name ?? err,
    );
    ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
    ctx.response.body = fallbackHtml(String(data?.title ?? template), data);
  }
}
