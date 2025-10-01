// src/lib/mail.ts
// שליחת אימיילים: אימות מייל ושחזור סיסמה.
// עובד בשני מצבים:
// 1) RESEND_API_KEY קיים → שליחה אמיתית דרך Resend API
// 2) בלי מפתח → DRY RUN (לוג בלבד, לא נופל בפרודקשן)

const BASE_URL = Deno.env.get("BASE_URL") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const MAIL_FROM = Deno.env.get("MAIL_FROM") ?? "GeoTable <no-reply@example.com>";

function buildUrl(path: string) {
  // אם יש BASE_URL (למשל https://myapp.com) נשתמש בו; אחרת נחזיר path יחסי
  const base = BASE_URL.replace(/\/+$/, "");
  return base ? `${base}${path.startsWith("/") ? "" : "/"}${path}` : path;
}

async function sendViaResend(to: string, subject: string, html: string, text?: string) {
  const url = "https://api.resend.com/emails";
  const body = {
    from: MAIL_FROM,
    to,
    subject,
    html,
    text: text || html.replace(/<[^>]+>/g, "").replace(/\s+\n/g, "\n"),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`Resend failed (${res.status}): ${msg}`);
  }
  return await res.json().catch(() => ({}));
}

async function sendMail(to: string, subject: string, html: string, text?: string) {
  if (RESEND_API_KEY) {
    try {
      return await sendViaResend(to, subject, html, text);
    } catch (e) {
      console.warn("[mail] Resend error → falling back to DRY RUN:", e);
      // נפול־בק ל־DRY RUN כדי לא להפיל את הזרימה
    }
  }
  // DRY RUN: לא שולחים בפועל, רק לוג
  console.log(`[mail:DRY] to=${to} subj="${subject}"\nHTML:\n${html}\n`);
  return { ok: true, dryRun: true };
}

/** אימות מייל אחרי הרשמה */
export async function sendVerifyEmail(to: string, token: string) {
  const link = buildUrl(`/auth/verify?token=${encodeURIComponent(token)}`);
  const subject = "אימות כתובת דוא\"ל – GeoTable";
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
      <h2>ברוך/ה הבא/ה ל-GeoTable</h2>
      <p>לאימות כתובת הדוא"ל שלך, לחצו על הקישור:</p>
      <p><a href="${link}" style="display:inline-block;background:#111;color:#fff;padding:10px 14px;border-radius:8px;text-decoration:none">אימות חשבון</a></p>
      <p>או העתיקו: <br/><code>${link}</code></p>
    </div>
  `;
  return await sendMail(to, subject, html);
}

/** קישור לשחזור סיסמה */
export async function sendResetEmail(to: string, token: string) {
  const link = buildUrl(`/auth/reset?token=${encodeURIComponent(token)}`);
  const subject = "שחזור סיסמה – GeoTable";
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
      <h2>שחזור סיסמה</h2>
      <p>התבקש שחזור סיסמה עבור החשבון שלך. ניתן להגדיר סיסמה חדשה בקישור הבא:</p>
      <p><a href="${link}" style="display:inline-block;background:#111;color:#fff;padding:10px 14px;border-radius:8px;text-decoration:none">איפוס סיסמה</a></p>
      <p>אם לא ביקשת/ביקשתּ לשחזר סיסמה — ניתן להתעלם מהודעה זו.</p>
      <p>קישור ישיר: <br/><code>${link}</code></p>
    </div>
  `;
  return await sendMail(to, subject, html);
}
