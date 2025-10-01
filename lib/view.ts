// src/lib/view.ts
// Safe Eta renderer: אם תבנית חסרה/שגויה - נחזיר fallback HTML/JSON במקום לזרוק חריגה.

import { Eta } from "npm:eta@3.5.0";
import type { Context } from "jsr:@oak/oak";

// תצורה בסיסית – תיקיית התבניות
const VIEWS_DIR = "/src/templates";

// יצירת מופע Eta עם קונפיגורציה
const eta = new Eta({
  views: VIEWS_DIR,
  cache: true,
  async: true,
  useWith: true, // נוח להזרקת נתונים
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
  </style>
</head>
<body>
  <h1 style="margin-top:0">${safeTitle}</h1>
  <div class="card">
    <p class="muted">תבנית לא נמצאה או נכשלה ברינדור. מוצג fallback.</p>
    <pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre>
  </div>
</body>
</html>`;
}

function escapeHtml(s: string) {
  return s
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
  // אם הלקוח ביקש JSON מפורשות – נכבד זאת
  if (wantsJSON(ctx)) {
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify(data, null, 2);
    return;
  }

  try {
    const html = await eta.renderAsync(template, data);
    if (typeof html === "string") {
      ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
      ctx.response.body = html;
      return;
    }
    // מקרה קצה: renderAsync החזירה undefined (למשל include בלבד)
    console.warn(`[view] template "${template}" rendered empty, using fallback`);
    ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
    ctx.response.body = fallbackHtml(String(data?.title ?? template), data);
  } catch (err: any) {
    const reqId = (ctx.state as any)?.reqId ?? "-";
    // לוג קריא כולל מידע על הנתיב/תבנית/תיקייה
    console.warn(
      `[view ${reqId}] render failed for template="${template}" (views="${VIEWS_DIR}") → fallback. Error:`,
      err?.name ?? err,
    );
    // במקרה EtaFileResolution Error עדיף לא לזרוק הלאה כדי לא להפיל את הבקשה
    ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
    ctx.response.body = fallbackHtml(String(data?.title ?? template), data);
  }
}
