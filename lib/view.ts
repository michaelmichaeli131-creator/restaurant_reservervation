// src/lib/view.ts
// Eta renderer חכם: מאתר ספריית תבניות באופן חסין-פריסה, תומך ב-ENV override,
// ומספק fallback מפורט (HTML/JSON) במקרה כשל.

import { Eta } from "npm:eta@3.5.0";
import type { Context } from "jsr:@oak/oak";

// --------- איתור ספריית התבניות ---------
// מאפשר override דרך ENV (TEMPLATES_DIR או VIEWS_DIR)
const ENV_DIR =
  Deno.env.get("TEMPLATES_DIR") ??
  Deno.env.get("VIEWS_DIR") ??
  "";

function candidatePaths(): string[] {
  // 1) ENV override
  const p0 = ENV_DIR || "";
  // 2) שורש הפרויקט
  const p1 = "/templates";
  // 3) פרויקטים שמבוצעים לתיקיית /src
  const p2 = "/src/templates";
  // 4) יחסית לקובץ הזה
  const p3 = new URL("../../templates", import.meta.url).pathname;
  // 5) עוד יחסית (למקרי בנדל שונים)
  const p4 = new URL("../templates", import.meta.url).pathname;

  // הסר כפילויות וריקים
  return Array.from(new Set([p0, p1, p2, p3, p4].filter(Boolean)));
}

function dirJoin(a: string, b: string) {
  return (a.replace(/\/+$/, "") + "/" + b.replace(/^\/+/, "")).replace(/\/+/g, "/");
}

// בדיקת "נראות" תיקיית תבניות ללא listDir:
// נבדוק קבצים נפוצים — מספיק שאחד קיים.
const PROBES = [
  "_layout.eta",
  "index.eta",
  "restaurant.eta",
  "auth/login.eta",
  "auth/register.eta",
];

function dirLooksLikeViews(dir: string): boolean {
  // ב־Deno Deploy לעיתים statSync לא זמין לכל נתיב; לכן ננסה בעדינות (optional chaining).
  // deno-lint-ignore no-explicit-any
  const statSync = (Deno as any).statSync?.bind(Deno);
  if (!statSync) return false;

  for (const rel of PROBES) {
    try {
      const full = dirJoin(dir, rel);
      statSync(full); // יזרוק אם לא קיים
      return true;
    } catch {
      // המשך לבדוק קובץ הבא
    }
  }
  return false;
}

const CANDIDATES = candidatePaths();

const PICKED_VIEWS_DIR = (() => {
  for (const p of CANDIDATES) {
    if (dirLooksLikeViews(p)) return p;
  }
  // אם לא נמצא דבר — נעדיף קודם ENV (אם קיים), אחרת "/templates"
  return ENV_DIR || "/templates";
})();

// --------- Eta instance ---------
const eta = new Eta({
  views: PICKED_VIEWS_DIR,
  cache: true,   // אפשר לשנות ל-false בזמן דיבוג
  async: true,
  useWith: true, // מאפשר שימוש ב-it ישירות בתבניות
});

// --------- Helpers ---------
function wantsJSON(ctx: Context) {
  const acc = ctx.request.headers.get("accept")?.toLowerCase() ?? "";
  // אם הלקוח ביקש JSON במפורש, או שזה XHR/fetch שמצפה JSON
  return acc.includes("application/json") || acc.includes("json");
}

function escapeHtml(s: unknown) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fallbackHtml(title: string, info: Record<string, unknown>) {
  const safeTitle = title || "GeoTable";
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHtml(safeTitle)}</title>
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
  <h1 style="margin-top:0">${escapeHtml(safeTitle)}</h1>
  <div class="card">
    <p class="muted">תבנית לא נמצאה או נכשלה ברינדור. מוצג fallback.</p>
    <p class="muted">chosen views: <code>${escapeHtml(PICKED_VIEWS_DIR)}</code></p>
    <p class="muted">candidates: <code>${escapeHtml(CANDIDATES.join(", "))}</code></p>
    <pre>${escapeHtml(JSON.stringify(info, null, 2))}</pre>
  </div>
</body>
</html>`;
}

// --------- Public API ---------
/**
 * render(ctx, template, data)
 * - אם Accept: application/json → מחזיר JSON (כולל user ב-payload)
 * - אחרת: מרנדר תבנית Eta מתוך PICKED_VIEWS_DIR
 * - במקרה כשל: מחזיר fallback (JSON או HTML לפי Accept)
 */
export async function render(
  ctx: Context,
  template: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  const user = (ctx.state as any)?.user ?? null;
  const payload = { ...data, user };

  // JSON במפורש
  if (wantsJSON(ctx)) {
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify(payload, null, 2);
    return;
  }

  try {
    // Eta v3: renderAsync(name, data) עם views שהוגדר.
    const html = await eta.renderAsync(template, payload);
    if (typeof html === "string") {
      ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
      ctx.response.body = html;
      return;
    }
    // נרנדר fallback אם יצא undefined/falsey
    console.warn(`[view] empty render for "${template}". views="${PICKED_VIEWS_DIR}"`);
    ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
    ctx.response.body = fallbackHtml(String(data?.title ?? template), {
      template,
      views: PICKED_VIEWS_DIR,
      candidates: CANDIDATES,
      data,
    });
  } catch (err) {
    const reqId = (ctx.state as any)?.reqId ?? "-";
    console.warn(`[view ${reqId}] render failed for "${template}" (views="${PICKED_VIEWS_DIR}") → fallback:`, err);
    const info = {
      message: "תבנית לא נמצאה או נכשלה ברינדור. מוצג fallback.",
      error: String((err as Error)?.message ?? err),
      template,
      views: PICKED_VIEWS_DIR,
      candidates: CANDIDATES,
      data,
    };
    // אם הלקוח הוא fetch רגיל בלי Accept: JSON — נחזיר HTML כדי שיהיה קריא בדפדפן.
    ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
    ctx.response.body = fallbackHtml(String(data?.title ?? template), info);
  }
}
