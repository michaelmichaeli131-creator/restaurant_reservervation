// src/lib/view.ts
// Eta renderer "קשיח" שמאתר את ספריית התבניות אוטומטית ומחזיר fallback בטוח במקרה תקלה.

import { Eta } from "npm:eta@3.5.0";
import type { Context } from "jsr:@oak/oak";

// --------- איתור ספריית התבניות באופן חסין-פריסה ---------
function candidatePaths(): string[] {
  // 1) מה ששמת בשורש הפרויקט
  const p1 = "/templates";
  // 2) מה שנפוץ בפרויקטים שקומפלו ל-/src
  const p2 = "/src/templates";
  // 3) יחסית למיקום הקובץ הזה (src/lib/view.ts → ../../templates)
  const p3 = new URL("../../templates", import.meta.url).pathname;
  // 4) יחסית אחת למעלה (לפריסות שונות)
  const p4 = new URL("../templates", import.meta.url).pathname;
  // הסר כפילויות
  return Array.from(new Set([p1, p2, p3, p4]));
}

function dirJoin(a: string, b: string) {
  return (a.replace(/\/+$/, "") + "/" + b.replace(/^\/+/, "")).replace(/\/+/g, "/");
}

/** בודק אם קיים קובץ _layout.eta או index.eta בספרייה */
function dirLooksLikeViews(dir: string): boolean {
  try {
    // שימוש בסינכרוני כדי להימנע מ-top-level await; Deno.deploy תומך בקריאה הזו לקבצי src.
    const layout = dirJoin(dir, "_layout.eta");
    const index = dirJoin(dir, "index.eta");
    // אם אחד מהם קיים — נשתמש ב-dir
    // statSync יזרוק אם לא קיים
    // deno-lint-ignore no-explicit-any
    (Deno as any).statSync?.(layout);
    return true;
  } catch {
    try {
      // deno-lint-ignore no-explicit-any
      (Deno as any).statSync?.(dirJoin(dir, "index.eta"));
      return true;
    } catch {
      return false;
    }
  }
}

const CANDIDATES = candidatePaths();
const PICKED_VIEWS_DIR = (() => {
  for (const p of CANDIDATES) {
    if (dirLooksLikeViews(p)) return p;
  }
  // אם לא מצאנו — נבחר את הראשון (עדיין נציג ב-fallback את הנתיבים שניסינו)
  return CANDIDATES[0];
})();

// --------- Eta instance ---------
const eta = new Eta({
  views: PICKED_VIEWS_DIR,
  cache: true,
  async: true,
  useWith: true,
});

// --------- Helpers ---------
function wantsJSON(ctx: Context) {
  const acc = ctx.request.headers.get("accept") ?? "";
  return acc.includes("application/json");
}

function escapeHtml(s: string) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

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
    <p class="muted">chosen views: <code>${escapeHtml(PICKED_VIEWS_DIR)}</code></p>
    <p class="muted">candidates: <code>${escapeHtml(CANDIDATES.join(", "))}</code></p>
    <pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre>
  </div>
</body>
</html>`;
}

// --------- Public API ---------
/**
 * render(ctx, templateName, data)
 * - מציג JSON אם Accept: application/json
 * - אחרת מנסה לרנדר קובץ .eta בשם הנתון מתוך ספריית התבניות שנבחרה.
 * - במקרה כשל – fallback HTML.
 */
export async function render(
  ctx: Context,
  template: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  try {
    const user = (ctx.state as any)?.user ?? null;
    const payload = { ...data, user };

    if (wantsJSON(ctx)) {
      ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
      ctx.response.body = JSON.stringify(payload, null, 2);
      return;
    }

    // Eta v3: renderAsync עם שם תבנית עובד כשמוגדרת views+cache.
    const html = await eta.renderAsync(template, payload);
    if (typeof html === "string") {
      ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
      ctx.response.body = html;
      return;
    }

    console.warn(`[view] template "${template}" rendered empty. views="${PICKED_VIEWS_DIR}"`);
    ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
    ctx.response.body = fallbackHtml(String(data?.title ?? template), data);
  } catch (err) {
    const reqId = (ctx.state as any)?.reqId ?? "-";
    console.warn(`[view ${reqId}] render failed for "${template}" (views="${PICKED_VIEWS_DIR}") → fallback:`, err);
    ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
    ctx.response.body = fallbackHtml(String(data?.title ?? template), data);
  }
}
