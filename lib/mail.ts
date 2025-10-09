// src/lib/mail.ts
// שליחת אימיילים דרך Resend עם אכיפה על MAIL_FROM תקין,
// תמיכת DRY-RUN נשלטת, ולוגים ברורים.
// כולל תבניות HTML מעוצבות (RTL) לאימות, איפוס, אישור הזמנה ועוד.
// **שיפורים**: כפתור ניהול הזמנה עם קישור ישיר (manageUrl),
// אנטי-קליפינג בג'ימייל (תוכן ייחודי גלוי), וטקסט/HTML ברורים.

/* ======================= ENV ======================= */
const ENV = {
  BASE_URL: (Deno.env.get("BASE_URL") || "").trim(),
  RESEND_API_KEY: (Deno.env.get("RESEND_API_KEY") || "").trim(),
  MAIL_FROM: (Deno.env.get("MAIL_FROM") || "").trim(), // חובה: דומיין מאומת
  DRY_RUN: (Deno.env.get("RESEND_DRY_RUN") || "").toLowerCase() === "1",
};

/* ======================= Utils ======================= */
function ensureFrom(): string {
  // חייבים MAIL_FROM עם @ ושאינו example.com
  if (!ENV.MAIL_FROM || !ENV.MAIL_FROM.includes("@")) {
    throw new Error(
      "MAIL_FROM is missing or invalid. Set MAIL_FROM to a verified address, e.g. 'SpotBook <no-reply@spotbook.rest>'."
    );
  }
  const lower = ENV.MAIL_FROM.toLowerCase();
  if (lower.includes("@example.com")) {
    throw new Error(
      "MAIL_FROM uses example.com which is not a verified domain. Set MAIL_FROM to your verified domain."
    );
  }
  return ENV.MAIL_FROM;
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
  fromOverride?: string; // לשימוש נדיר, בד"כ לא צריך
};

function htmlToText(html: string): string {
  // המרה גסה אך סבירה לטקסט
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
  console.warn(`[mail][DRY] ${label}: to=${to} subj="${p.subject}" from="${p.fromOverride || ENV.MAIL_FROM || "(unset)"}"`);
  console.warn(`[mail][DRY] text:\n${p.text || htmlToText(p.html)}\n`);
}

/* ======================= Public send wrapper ======================= */
async function sendMailAny(p: MailParams) {
  // אוכפים from תקין כבר עכשיו — אם חסר קונפיג, נכשיל במקום "לנחש"
  try { ensureFrom(); } catch (e) {
    console.error("[mail] config error:", String(e));
    return { ok: false, reason: String(e) };
  }

  // DRY_RUN מפורש או חסר מפתח API
  if (ENV.DRY_RUN || !ENV.RESEND_API_KEY) {
    logDry(ENV.DRY_RUN ? "RESEND_DRY_RUN=1" : "RESEND_API_KEY missing", p);
    return { ok: true, dryRun: true };
  }

  try {
    const data = await sendViaResend(p);
    console.log("[mail] sent via Resend:", { to: p.to, subject: p.subject, id: (data as any)?.id });
    return { ok: true };
  } catch (e) {
    const msg = String((e as any)?.message || e);
    console.error("[mail] Resend error:", msg);
    // בכוונה לא נופלים ל-DRY כאן — זו תקלה שראוי לתקן (403/401/422 וכו')
    return { ok: false, reason: msg };
  }
}

/* --------- Backward-compatible helper (string 'to') ---------- */
async function sendMail(to: string | string[], subject: string, html: string, text?: string) {
  return await sendMailAny({
    to,
    subject,
    html,
    text,
    headers: {
      "Reply-To": "no-reply",
      "List-Unsubscribe": "<mailto:no-reply>",
    },
  });
}

/* =================== תבניות מעוצבות =================== */

// צבעים/סגנונות בסיס (inline כדי שיעבוד ברוב הקליינטים)
const palette = {
  bg: "#f4f7fb",
  card: "#06b6d4", // טורקיז
  text: "#0f172a",
  sub: "#475569",  // כהה יותר למניעת "טמון"/קליפינג
  btn: "#06b6d4",
  btnText: "#ffffff",
  white: "#ffffff",
  border: "#e2e8f0",
};

const baseWrapStart = `
  <div dir="rtl" style="background:${palette.bg};padding:32px 0;">
    <table align="center" role="presentation" width="100%" style="max-width:640px;margin:auto;background:${palette.white};border:1px solid ${palette.border};border-radius:14px;box-shadow:0 2px 8px rgba(0,0,0,.04);font-family:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${palette.text};line-height:1.6">
      <tr><td style="padding:28px 28px 8px;">
        <h1 style="margin:0 0 4px;font-size:28px;font-weight:800;letter-spacing:.2px;">`;
const baseWrapMid = `</h1>
        <p style="margin:0 0 16px;color:${palette.sub};font-size:16px;">`;
const baseWrapEndHead = `</p>
      </td></tr>
      <tr><td style="padding:0 28px 24px;">
`;
const baseWrapClose = `
        <p style="margin:24px 0 0;color:${palette.sub};font-size:12px;">האימייל נשלח אוטומטית. אין להשיב להודעה זו.</p>
      </td></tr>
    </table>
  </div>
`;

// מחזיר יום קצר (א׳, ב׳, …, ש׳) ותאריך D/M
function hebDayShort(d: Date) {
  const map = ["א׳","ב׳","ג׳","ד׳","ה׳","ו׳","ש׳"];
  return map[d.getDay()] || "";
}
function formatDM(dateStr: string) {
  const [y,m,d] = (dateStr || "").split("-").map(Number);
  if (!y || !m || !d) return dateStr || "";
  return `${d}/${m}`;
}

/* =================== אימות מייל אחרי הרשמה =================== */
export async function sendVerifyEmail(to: string, token: string) {
  const link = buildUrl(`/auth/verify?token=${encodeURIComponent(token)}`);
  const html = `
${baseWrapStart}ברוכים הבאים ל-GeoTable${baseWrapMid}נשאר רק לאמת את כתובת הדוא״ל שלך.${baseWrapEndHead}
  <div style="text-align:center;margin:8px 0 20px;">
    <a href="${link}" style="display:inline-block;background:${palette.btn};color:${palette.btnText};padding:12px 18px;border-radius:999px;text-decoration:none;font-weight:600;">אימות חשבון</a>
  </div>
  <p style="margin:0;color:${palette.sub};font-size:14px;word-break:break-all">או הדבק/י ידנית: <a href="${link}">${link}</a></p>
${baseWrapClose}
  `;
  return await sendMail(to, "אימות כתובת דוא\"ל – GeoTable", html);
}

/* =================== קישור לשחזור סיסמה =================== */
export async function sendResetEmail(to: string, token: string) {
  const link = buildUrl(`/auth/reset?token=${encodeURIComponent(token)}`);
  const html = `
${baseWrapStart}איפוס סיסמה${baseWrapMid}בבקשה לחצי/לחץ על הכפתור כדי להגדיר סיסמה חדשה.${baseWrapEndHead}
  <div style="text-align:center;margin:8px 0 20px;">
    <a href="${link}" style="display:inline-block;background:${palette.btn};color:${palette.btnText};padding:12px 18px;border-radius:999px;text-decoration:none;font-weight:600;">איפוס סיסמה</a>
  </div>
  <p style="margin:0;color:${palette.sub};font-size:14px;word-break:break-all">קישור ישיר: <a href="${link}">${link}</a></p>
${baseWrapClose}
  `;
  return await sendMail(to, "שחזור סיסמה – GeoTable", html);
}

/* =================== אישור הזמנה ללקוח =================== */
export async function sendReservationEmail(opts: {
  to: string;
  restaurantName: string;
  date: string;   // YYYY-MM-DD
  time: string;   // HH:mm
  people: number;
  customerName?: string;
  manageUrl?: string;     // ← כפתור ניהול ישיר
  reservationId?: string; // ← להצגה גלויה למניעת קליפינג בג'ימייל
}) {
  const { to, restaurantName, date, time, people, customerName, manageUrl, reservationId } = opts;
  const d = new Date(`${date}T12:00:00`); // להימנע מ-TZ edge
  const dayShort = isNaN(d.getTime()) ? "" : hebDayShort(d);
  const dm = formatDM(date);

  // מזהה קצר לאנטי-קליפינג (גלוי ללקוח)
  const shortId =
    (reservationId && reservationId.slice(-6)) ||
    (manageUrl?.split("/").pop()?.replace(/[^a-zA-Z0-9]/g, "").slice(-6)) ||
    "";

  // בלוק פרטים כמו בתמונה: כרטיס טורקיז עם 3 עמודות
  const detailsCard = `
    <div style="background:${palette.card};color:#fff;border-radius:16px;padding:18px 16px;max-width:460px;margin:10px auto 8px;">
      <table role="presentation" width="100%" style="border-collapse:collapse;color:#fff;">
        <tr>
          <td style="width:33%;text-align:center;">
            <div style="opacity:.95;font-size:14px;">יום / ת׳</div>
            <div style="font-size:20px;font-weight:800;letter-spacing:.3px;">${dayShort} ${dm}</div>
          </td>
          <td style="width:33%;text-align:center;">
            <div style="opacity:.95;font-size:14px;">בשעה</div>
            <div style="font-size:20px;font-weight:800;letter-spacing:.3px;">${time}</div>
          </td>
          <td style="width:33%;text-align:center;">
            <div style="opacity:.95;font-size:14px;">אורחים</div>
            <div style="font-size:20px;font-weight:800;letter-spacing:.3px;">${people}</div>
          </td>
        </tr>
      </table>
      ${shortId ? `<div style="margin-top:8px;text-align:center;font-size:12px;opacity:.9;">קוד הזמנה: <strong style="letter-spacing:.4px;">${shortId}</strong></div>` : ""}
    </div>
  `;

  // טקסטים גלויים (למנוע קליפינג: אין display:none; אין צבע לבן על לבן; אין ציטוטים ארוכים)
  const html = `
${baseWrapStart}${restaurantName}${baseWrapMid}פרטי ההזמנה שלך. ניתן לאשר/לבטל/לשנות מועד דרך הקישור למטה.${baseWrapEndHead}
  ${detailsCard}

  <div style="padding:6px 4px 0;">
    ${customerName ? `<p style="margin:8px 0 0;">שלום ${customerName},</p>` : ""}
    <p style="margin:8px 0 0;">🎉 הזמנתך נקלטה. נשמח לאשר הגעה כמה דקות לפני.</p>
    <p style="margin:6px 0 0;">🚗 להגעתכם נוח יותר לחנות בחניון הקרוב לפי הכתובת. חניה מוזלת ללקוחות המסעדה החל משעה 18:00 בסופי שבוע.</p>
    <p style="margin:6px 0 0;">⏱️ השולחן ישמר 15 דקות.</p>
    <p style="margin:6px 0 0;">מחכים לראותכם ❤️</p>
  </div>

  <div style="text-align:center;margin:16px 0 0;">
    ${
      manageUrl
        ? `<a href="${manageUrl}" style="display:inline-block;background:${palette.btn};color:${palette.btnText};padding:12px 18px;border-radius:999px;text-decoration:none;font-weight:700;">ניהול ההזמנה (אישור/ביטול/שינוי)</a>`
        : `<a href="${buildUrl("/")}" style="display:inline-block;background:${palette.btn};color:${palette.btnText};padding:12px 18px;border-radius:999px;text-decoration:none;font-weight:700;">דף המסעדה</a>`
    }
  </div>

  ${
    manageUrl
      ? `<p style="margin:14px 0 0;color:${palette.sub};font-size:14px;word-break:break-all">קישור ישיר: <a href="${manageUrl}">${manageUrl}</a></p>`
      : ""
  }
${baseWrapClose}
  `;

  // נוסיף טקסט ברור כדי שלא "יוחבא" בקליינטים מסוימים
  const text = [
    `${restaurantName} – אישור הזמנה`,
    customerName ? `שלום ${customerName},` : "",
    `תאריך: ${date} | שעה: ${time} | סועדים: ${people}`,
    shortId ? `קוד הזמנה: ${shortId}` : "",
    "🎉 הזמנתך נקלטה. השולחן ישמר 15 דקות. חניה מוזלת בסופי שבוע מ-18:00.",
    manageUrl ? `ניהול ההזמנה (אישור/ביטול/שינוי): ${manageUrl}` : `לפרטים: ${buildUrl("/")}`,
  ].filter(Boolean).join("\n");

  return await sendMailAny({
    to,
    subject: `אישור הזמנה – ${restaurantName}`,
    html,
    text,
    headers: {
      "Reply-To": "no-reply",
      "List-Unsubscribe": "<mailto:no-reply>",
    },
  });
}

/* =================== התראה לבעל המסעדה =================== */
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
  const html = `
${baseWrapStart}התקבלה הזמנה חדשה${baseWrapMid}${restaurantName}${baseWrapEndHead}
  <div style="background:${palette.card};color:#fff;border-radius:14px;padding:14px 16px;">
    <p style="margin:0;"><strong>תאריך:</strong> ${date} · <strong>שעה:</strong> ${time} · <strong>סועדים:</strong> ${people}</p>
  </div>
  <div style="margin-top:12px;">
    <p style="margin:0;"><strong>שם הלקוח:</strong> ${customerName}</p>
    <p style="margin:0;"><strong>נייד:</strong> ${customerPhone}</p>
    <p style="margin:0;"><strong>אימייל:</strong> ${customerEmail}</p>
  </div>
${baseWrapClose}
  `;
  const text =
    `התקבלה הזמנה חדשה – ${restaurantName}\n` +
    `תאריך: ${date} | שעה: ${time} | סועדים: ${people}\n` +
    `לקוח: ${customerName} | נייד: ${customerPhone} | אימייל: ${customerEmail}`;
  return await sendMailAny({ to, subject: `הזמנה חדשה – ${restaurantName}`, html, text });
}

/* =================== תזכורת (למשל יום לפני) =================== */
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

  const html = `
${baseWrapStart}תזכורת להזמנה${baseWrapMid}${restaurantName}${baseWrapEndHead}
  <div style="background:${palette.card};color:#fff;border-radius:16px;padding:16px;">
    <p style="margin:0;"><strong>תאריך:</strong> ${date} · <strong>שעה:</strong> ${time} · <strong>סועדים:</strong> ${people}</p>
  </div>
  <div style="margin-top:12px;">
    ${customerName ? `<p style="margin:0;">שלום ${customerName},</p>` : ""}
    <p style="margin:6px 0 0;">נא אשר/י הגעה בלחיצה:</p>
    <div style="text-align:center;margin:10px 0 0;">
      <a href="${link}" style="display:inline-block;background:${palette.btn};color:${palette.btnText};padding:12px 18px;border-radius:999px;text-decoration:none;font-weight:600;">אישור הגעה</a>
    </div>
  </div>
${baseWrapClose}
  `;
  const text =
    `תזכורת להזמנה – ${restaurantName}\n` +
    `תאריך: ${date} | שעה: ${time} | סועדים: ${people}\n` +
    `אישור הגעה: ${link}`;
  return await sendMailAny({ to, subject: "תזכורת להזמנה – נא אשר/י הגעה", html, text });
}
