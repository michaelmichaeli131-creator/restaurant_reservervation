// src/lib/mail.ts
// שליחת אימיילים דרך Resend עם אכיפה על MAIL_FROM תקין מדומיין spotbook.rest,
// תמיכת DRY-RUN נשלטת, ולוגים ברורים.

// ====== ENV & CONSTS ======
const ENV = {
  BASE_URL: (Deno.env.get("BASE_URL") || "").trim(),
  RESEND_API_KEY: (Deno.env.get("RESEND_API_KEY") || "").trim(),
  MAIL_FROM: (Deno.env.get("MAIL_FROM") || "").trim(),
  DRY_RUN: (Deno.env.get("RESEND_DRY_RUN") || "").toLowerCase() === "1",
};

const VERIFIED_DOMAIN = "spotbook.rest";

// ====== Utils ======
function extractEmailAddress(from: string): string {
  // "Name <user@domain>"  -> "user@domain"
  // "user@domain"         -> "user@domain"
  const m = from.match(/<\s*([^>]+)\s*>/);
  const addr = (m ? m[1] : from).trim();
  return addr;
}

function ensureFrom(): string {
  // חייבים MAIL_FROM עם @ ושייך לדומיין המאומת spotbook.rest
  const raw = ENV.MAIL_FROM;
  if (!raw) {
    throw new Error(
      `MAIL_FROM is missing. Set MAIL_FROM to a verified address, e.g. 'SpotBook <no-reply@${VERIFIED_DOMAIN}>'`
    );
  }
  if (!raw.includes("@")) {
    throw new Error(
      `MAIL_FROM is invalid. Use a proper address, e.g. 'SpotBook <no-reply@${VERIFIED_DOMAIN}>'`
    );
  }

  const addr = extractEmailAddress(raw).toLowerCase();
  const atIdx = addr.lastIndexOf("@");
  if (atIdx === -1 || atIdx === addr.length - 1) {
    throw new Error("MAIL_FROM email address is malformed.");
  }
  const domain = addr.slice(atIdx + 1);

  if (domain === "example.com") {
    throw new Error("MAIL_FROM uses example.com which is not verified.");
  }
  // אוכפים spotbook.rest (כולל תתי־דומיינים כמו mail.spotbook.rest)
  if (!(domain === VERIFIED_DOMAIN || domain.endsWith(`.${VERIFIED_DOMAIN}`))) {
    throw new Error(
      `MAIL_FROM domain must be ${VERIFIED_DOMAIN} (or a subdomain). Got: ${domain}`
    );
  }
  return raw;
}

function buildUrl(path: string) {
  const base = ENV.BASE_URL.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  if (!base) return p; // בפיתוח – יחסי
  return `${base}${p}`;
}

type MailParams = {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  headers?: Record<string, string>;
  fromOverride?: string;
};

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/h\d>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function sendViaResend(p: MailParams) {
  const apiKey = ENV.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY missing");

  const from = p.fromOverride || ensureFrom();
  const toArr = Array.isArray(p.to) ? p.to : [p.to];
  const body = {
    from,
    to: toArr,
    subject: p.subject,
    html: p.html,
    text: p.text || htmlToText(p.html),
    headers: p.headers,
  };

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`Resend failed (${res.status}): ${msg || res.statusText}`);
  }
  return await res.json().catch(() => ({}));
}

function logDry(label: string, p: MailParams) {
  const to = Array.isArray(p.to) ? p.to.join(", ") : p.to;
  console.warn(
    `[mail][DRY] ${label}: to=${to} subj="${p.subject}" from="${p.fromOverride || ENV.MAIL_FROM || "(unset)"}"`
  );
  console.warn(`[mail][DRY] text:\n${p.text || htmlToText(p.html)}\n`);
}

// ====== Public send wrapper ======
async function sendMailAny(p: MailParams) {
  // מאמתים קונפיג מראש — כדי לתת שגיאה ברורה אם יש בעיה ב־MAIL_FROM
  try {
    ensureFrom();
  } catch (e) {
    console.error("[mail] config error:", String(e));
    return { ok: false, reason: String(e) };
  }

  if (ENV.DRY_RUN || !ENV.RESEND_API_KEY) {
    logDry(ENV.DRY_RUN ? "RESEND_DRY_RUN=1" : "RESEND_API_KEY missing", p);
    return { ok: true, dryRun: true };
  }

  try {
    const data = await sendViaResend(p);
    console.log("[mail] sent via Resend:", {
      to: p.to,
      subject: p.subject,
      id: (data as any)?.id,
    });
    return { ok: true };
  } catch (e) {
    const msg = String((e as any)?.message || e);
    console.error("[mail] Resend error:", msg);
    // בכוונה לא נופלים ל־DRY כדי שלא להסתיר תקלות אמיתיות (403/401/422 וכו')
    return { ok: false, reason: msg };
  }
}

// ====== Backward-compatible helper ======
async function sendMail(to: string | string[], subject: string, html: string, text?: string) {
  return await sendMailAny({
    to,
    subject,
    html,
    text,
    headers: {
      "Reply-To": "no-reply@spotbook.rest",
      // אם יש לכם עמוד ביטול/ניהול העדפות:
      // "List-Unsubscribe": "<https://spotbook.rest/unsubscribe>",
    },
  });
}

// ====== Public templates (חתימות זהות לקוד הקודם) ======

/** אימות מייל אחרי הרשמה */
export async function sendVerifyEmail(to: string, token: string) {
  const link = buildUrl(`/auth/verify?token=${encodeURIComponent(token)}`);
  const subject = "אימות כתובת דוא\"ל – SpotBook";
  const html = `
    <div dir="rtl" style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6">
      <h2>ברוך/ה הבא/ה ל-SpotBook</h2>
      <p>לאימות כתובת הדוא"ל שלך:</p>
      <p><a href="${link}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 14px;border-radius:8px;text-decoration:none">אימות חשבון</a></p>
      <p>או הדבק/י: <br/><a href="${link}">${link}</a></p>
    </div>
  `;
  return await sendMail(to, subject, html);
}

/** קישור לשחזור סיסמה */
export async function sendResetEmail(to: string, token: string) {
  const link = buildUrl(`/auth/reset?token=${encodeURIComponent(token)}`);
  const subject = "שחזור סיסמה – SpotBook";
  const html = `
    <div dir="rtl" style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6">
      <h2>איפוס סיסמה</h2>
      <p>ניתן להגדיר סיסמה חדשה בקישור הבא:</p>
      <p><a href="${link}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 14px;border-radius:8px;text-decoration:none">איפוס סיסמה</a></p>
      <p>קישור ישיר: <br/><a href="${link}">${link}</a></p>
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
  const subject = `אישור הזמנה – ${restaurantName}`;
  const html = `
    <div dir="rtl" style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6">
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
  to: string | string[];
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
    <div dir="rtl" style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6">
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

/** תזכורת (למשל יום לפני) */
export async function sendReminderEmail(opts: {
  to: string | string[];
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
    <div dir="rtl" style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6">
      ${customerName ? `<p>שלום ${customerName},</p>` : ""}
      <p>תזכורת להזמנתך ב<strong>${restaurantName}</strong>.</p>
      <p>תאריך: <strong>${date}</strong> · שעה: <strong>${time}</strong> · <strong>${people}</strong> סועדים</p>
      <p>נא אשר/י הגעה: <a href="${link}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 14px;border-radius:8px;text-decoration:none">אישור הגעה</a></p>
    </div>
  `;
  return await sendMail(to, subject, html);
}
