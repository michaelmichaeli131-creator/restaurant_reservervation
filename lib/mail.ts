// src/lib/mail.ts
// שליחת מיילים עם Resend + fallback ל-log כאשר חסר מפתח/דומיין
// שימושים: אימות מייל, התראות לבעלי מסעדה, שחזור סיסמה.

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const RESEND_FROM = Deno.env.get("RESEND_FROM") ?? ""; // למשל: "GeoTable <no-reply@yourdomain.com>"
const BASE_URL = Deno.env.get("BASE_URL") ?? "";       // לדוגמה: "https://your-app.deno.dev"

async function sendResendEmail(to: string, subject: string, html: string) {
  if (!RESEND_API_KEY || !RESEND_FROM) {
    console.warn("[mail:dry-run] missing RESEND_API_KEY/RESEND_FROM");
    console.info("[mail:dry-run] to=", to, "subject=", subject);
    console.info("[mail:dry-run] html=", html);
    return { ok: true, id: "dry-run" };
  }
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: RESEND_FROM, to, subject, html }),
  });
  if (!resp.ok) {
    console.error("[mail] send failed:", resp.status, await resp.text());
  }
  return { ok: resp.ok };
}

function wrapLayout(title: string, bodyHtml: string) {
  return `<!doctype html>
<html dir="rtl" lang="he">
  <head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width,initial-scale=1"/>
    <title>${title}</title>
  </head>
  <body style="margin:0;background:#f6f7fb;font-family:Arial,Helvetica,sans-serif;color:#111;direction:rtl">
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="padding:24px 0">
      <tr>
        <td align="center">
          <table width="640" cellpadding="0" cellspacing="0" role="presentation" style="background:#fff;border:1px solid #eee;border-radius:12px;padding:24px">
            <tr><td>
              <h2 style="margin:0 0 12px 0">GeoTable</h2>
              <div>${bodyHtml}</div>
              <p style="color:#777;font-size:12px;margin-top:24px">אם לא ביקשת את הפעולה – אפשר להתעלם מהמייל.</p>
            </td></tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export async function sendVerifyEmail(to: string, token: string) {
  const link = `${BASE_URL || ""}/verify?token=${encodeURIComponent(token)}`;
  const html = wrapLayout("אימות כתובת דוא״ל", `
    <p>להשלמת ההרשמה, נא לאמת את כתובת הדוא״ל.</p>
    <p><a href="${link}">לחצו כאן לאימות</a></p>
  `);
  return sendResendEmail(to, "אימות כתובת דוא״ל", html);
}

export async function sendPasswordResetEmail(to: string, token: string) {
  const link = `${BASE_URL || ""}/reset?token=${encodeURIComponent(token)}`;
  const html = wrapLayout("איפוס סיסמה", `
    <p>קיבלנו בקשה לאפס את הסיסמה.</p>
    <p><a href="${link}">לחצו כאן לאיפוס הסיסמה</a></p>
  `);
  return sendResendEmail(to, "איפוס סיסמה", html);
}
