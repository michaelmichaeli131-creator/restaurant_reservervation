// src/lib/mail.ts
// שליחת מיילים עם Resend + fallback ל-log כאשר חסר מפתח/דומיין
// שימושים: אימות מייל, התראות לבעלי מסעדה, ועוד.

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const RESEND_FROM = Deno.env.get("RESEND_FROM") ?? ""; // למשל: "GeoTable <no-reply@yourdomain.com>"
const BASE_URL = Deno.env.get("BASE_URL") ?? "";       // לדוגמה: "https://your-app.deno.dev"

// --- Low-level sender ---
async function sendResendEmail(to: string, subject: string, html: string) {
  if (!RESEND_API_KEY || !RESEND_FROM) {
    // מצב DRY-RUN: אין API key או from — נדפיס ללוג במקום לשלוח
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
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [to],
      subject,
      html,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error("[mail:error] HTTP", resp.status, text);
    throw new Error("resend_failed");
  }
  const json = await resp.json();
  return { ok: true, id: json?.id ?? "unknown" };
}

// --- Templates ---
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
            <tr>
              <td>
                <h1 style="margin:0 0 12px 0;font-size:20px">GeoTable</h1>
                ${bodyHtml}
                <p style="color:#777;font-size:12px;margin-top:24px">הודעה זו נשלחה אוטומטית. אם לא ביקשת — ניתן להתעלם.</p>
              </td>
            </tr>
          </table>
          <div style="color:#999;font-size:12px;margin-top:12px">© ${new Date().getFullYear()} GeoTable</div>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function verifyEmailHtml(link: string) {
  const btn = `<a href="${link}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;border-radius:8px;padding:10px 16px">אשר/י את המייל</a>`;
  return wrapLayout(
    "אימות כתובת מייל",
    `<p>כמעט סיימנו! יש ללחוץ על הכפתור כדי לאמת את כתובת המייל.</p>
     <p>${btn}</p>
     <p style="color:#555">אם הכפתור לא עובד, אפשר לפתוח את הקישור הבא: <br/><span style="font-size:12px;word-break:break-all">${link}</span></p>`
  );
}

// --- Public API ---
/** שלח מייל אימות הרשמה */
export async function sendVerifyEmail(to: string, token: string) {
  const base = BASE_URL || "";
  const url = base ? `${base}/verify?token=${encodeURIComponent(token)}` : `/verify?token=${encodeURIComponent(token)}`;
  const html = verifyEmailHtml(url);
  return await sendResendEmail(to, "אימות כתובת מייל · GeoTable", html);
}

/** דוגמה: שלח התראה לבעל מסעדה על הזמנה חדשה */
export async function sendOwnerNewReservationEmail(to: string, data: {
  restaurantName: string;
  date: string; time: string; people: number;
}) {
  const html = wrapLayout(
    "הזמנה חדשה",
    `<p>התקבלה הזמנה חדשה למסעדה <strong>${data.restaurantName}</strong>.</p>
     <ul>
       <li>תאריך: ${data.date}</li>
       <li>שעה: ${data.time}</li>
       <li>מס' סועדים: ${data.people}</li>
     </ul>`
  );
  return await sendResendEmail(to, "הזמנה חדשה · GeoTable", html);
}
