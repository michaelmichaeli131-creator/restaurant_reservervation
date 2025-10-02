// src/lib/mail.ts
// שליחת אימיילים: אימות מייל, שחזור סיסמה, אישור הזמנה ותזכורת/התראה לבעל מסעדה.
// מצב עבודה:
// 1) RESEND_API_KEY קיים → שליחה דרך Resend
// 2) אחרת → DRY RUN (רק לוג, לא נופל)

const BASE_URL = Deno.env.get("BASE_URL") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const MAIL_FROM = Deno.env.get("MAIL_FROM") ?? "GeoTable <no-reply@example.com>";

function buildUrl(path: string) {
  const base = BASE_URL.replace(/\/+$/, "");
  if (!base) return path.startsWith("/") ? path : `/${path}`;
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
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
      console.warn("[mail] Resend error → DRY RUN:", e);
      // נמשיך ל-DRY RUN
    }
  }
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
      <p>לאימות כתובת הדוא"ל שלך:</p>
      <p><a href="${link}" style="display:inline-block;background:#111;color:#fff;padding:10px 14px;border-radius:8px;text-decoration:none">אימות חשבון</a></p>
      <p>או הדביקו: <br/><code>${link}</code></p>
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
      <p>ניתן להגדיר סיסמה חדשה בקישור הבא:</p>
      <p><a href="${link}" style="display:inline-block;background:#111;color:#fff;padding:10px 14px;border-radius:8px;text-decoration:none">איפוס סיסמה</a></p>
      <p>קישור ישיר: <br/><code>${link}</code></p>
    </div>
  `;
  return await sendMail(to, subject, html);
}

/** אישור הזמנה ללקוח */
export async function sendReservationEmail(opts: {
  to: string;
  restaurantName: string;
  date: string;   // YYYY-MM-DD
  time: string;   // HH:mm
  people: number;
  customerName?: string;
}) {
  const { to, restaurantName, date, time, people, customerName } = opts;
  const subject = "אישור הזמנה – GeoTable";
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
      ${customerName ? `<p>שלום ${customerName},</p>` : ""}
      <p>הזמנתך ל<strong>${restaurantName}</strong> נקלטה.</p>
      <p><strong>תאריך:</strong> ${date} · <strong>שעה:</strong> ${time} · <strong>סועדים:</strong> ${people}</p>
      <p>נשמח לראותך!</p>
    </div>
  `;
  return await sendMail(to, subject, html);
}

/** התראה לבעל המסעדה על הזמנה חדשה */
export async function notifyOwnerEmail(opts: {
  to: string; // אימייל בעל המסעדה
  restaurantName: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  date: string;
  time: string;
  people: number;
}) {
  const { to, restaurantName, customerName, customerPhone, customerEmail, date, time, people } = opts;
  const subject = `הזמנה חדשה – ${restaurantName}`;
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
      <h3>התקבלה הזמנה חדשה</h3>
      <p><strong>מסעדה:</strong> ${restaurantName}</p>
      <p><strong>תאריך:</strong> ${date} · <strong>שעה:</strong> ${time} · <strong>סועדים:</strong> ${people}</p>
      <p><strong>שם הלקוח:</strong> ${customerName}<br/>
         <strong>נייד:</strong> ${customerPhone}<br/>
         <strong>אימייל:</strong> ${customerEmail}</p>
    </div>
  `;
  return await sendMail(to, subject, html);
}

/** תזכורת יום לפני (אם תממשו קרון/ווב-טסק) */
export async function sendReminderEmail(opts: {
  to: string;
  confirmUrl: string;
  restaurantName: string;
  date: string;
  time: string;
  people: number;
  customerName?: string;
}) {
  const { to, confirmUrl, restaurantName, date, time, people, customerName } = opts;
  const link = confirmUrl.startsWith("http") ? confirmUrl : buildUrl(confirmUrl);
  const subject = "תזכורת להזמנה – נא אשר/י הגעה";
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
      ${customerName ? `<p>שלום ${customerName},</p>` : ""}
      <p>תזכורת להזמנתך ב<strong>${restaurantName}</strong> מחר.</p>
      <p>תאריך: <strong>${date}</strong> · שעה: <strong>${time}</strong> · <strong>${people}</strong> סועדים</p>
      <p>נא אשר/י הגעה: <a href="${link}" style="display:inline-block;background:#111;color:#fff;padding:10px 14px;border-radius:8px;text-decoration:none">אישור הגעה</a></p>
    </div>
  `;
  return await sendMail(to, subject, html);
}
