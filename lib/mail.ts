// src/lib/mail.ts
// שליחת אימיילים דרך Resend עם אכיפה על MAIL_FROM תקין,
// תמיכת DRY-RUN נשלטת, ולוגים ברורים.
// כולל תבניות HTML מעוצבות (RTL) לאימות, איפוס, אישור הזמנה ועוד.
// **שיפורים**: כפתור ניהול הזמנה עם קישור ישיר (manageUrl),
// אנטי-קליפינג בג'ימייל (תוכן ייחודי גלוי), וטקסט/HTML ברורים.
// **הוספה**: תמיכה ב־note (הערות) להצגה גם ללקוח וגם לבעל המסעדה.
// **עדכון מיתוג**: עיצוב Luxury Dark + לוגו SpotBook בהדר.

//////////////////////////// ENV ////////////////////////////
const ENV = {
  BASE_URL: (Deno.env.get("BASE_URL") || "").trim(),
  RESEND_API_KEY: (Deno.env.get("RESEND_API_KEY") || "").trim(),
  MAIL_FROM: (Deno.env.get("MAIL_FROM") || "").trim(), // חובה: דומיין מאומת
  DRY_RUN: (Deno.env.get("RESEND_DRY_RUN") || "").toLowerCase() === "1",
};

//////////////////////////// Utils //////////////////////////
function ensureFrom(): string {
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
      Authorization: `Bearer ${apiKey}`,
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
    `[mail][DRY] ${label}: to=${to} subj="${p.subject}" from="${
      p.fromOverride || ENV.MAIL_FROM || "(unset)"
    }"`
  );
  console.warn(`[mail][DRY] text:\n${p.text || htmlToText(p.html)}\n`);
}

///////////////////// Public send wrapper ///////////////////
export async function sendMailAny(p: MailParams) {
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
    return { ok: false, reason: msg };
  }
}

export async function sendMail(
  to: string | string[],
  subject: string,
  html: string,
  text?: string
) {
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

///////////////// תבניות מעוצבות (Luxury Dark) /////////////////

// צבעים/סגנונות בסיס (inline כדי שיעבוד ברוב הקליינטים)
const palette = {
  bg: "#0b1120",
  surface: "#0f172a",
  card: "#111827",
  text: "#e5e7eb",
  sub: "#9aa3b2",
  btn: "#3b82f6",
  btnText: "#ffffff",
  white: "#0f172a",
  border: "#1f2937",
  link: "#93c5fd",
};

// לוגו (מוגש מה- public): /img/logo-spotbook.png
const logoUrl = buildUrl("/img/logo-spotbook.png");

// עטיפה בסיסית — טבלה מרכזית 640px, RTL, כהה + לוגו בהדר
const baseWrapStart = `
  <div dir="rtl" style="background:${palette.bg};padding:28px 0;">
    <table align="center" role="presentation" width="100%" style="
      max-width:640px;margin:auto;background:${palette.card};
      border:1px solid ${palette.border};border-radius:16px;
      box-shadow:0 2px 24px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.03);
      font-family:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
      color:${palette.text}; line-height:1.6;">
      <tr>
        <td style="padding:18px 20px;border-bottom:1px solid ${palette.border};background:${palette.surface}">
          <table role="presentation" width="100%" style="border-collapse:collapse;">
            <tr>
              <td style="vertical-align:middle;">
                <h1 style="margin:0;font-size:26px;font-weight:800;letter-spacing:.2px;">`;
const baseWrapMid = `</h1>
                <p style="margin:6px 0 0;color:${palette.sub};font-size:15px;">`;
const baseWrapEndHead = `</p>
              </td>
              <td style="width:64px;vertical-align:middle;text-align:left;">
                <img src="${logoUrl}" alt="SpotBook" style="display:block;width:48px;height:auto;border:0;outline:none;text-decoration:none"/>
              </td>
            </tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:18px 24px 22px;">
`;
const baseWrapClose = `
          <p style="margin:24px 0 0;color:${palette.sub};font-size:12px;">
            האִימייל נשלח אוטומטית. אין להשיב להודעה זו.
          </p>
        </td>
      </tr>
    </table>
    <!-- preheader (מוסתר) למקדמי פתיחה -->
    <div style="display:none !important;visibility:hidden;opacity:0;overflow:hidden;height:0;width:0;line-height:0;">
      הודעת GeoTable – פעולה מהירה בלחיצה על הכפתור למטה
    </div>
  </div>
`;

// יום קצר ותאריך D/M
function hebDayShort(d: Date) {
  const map = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];
  return map[d.getDay()] || "";
}
function formatDM(dateStr: string) {
  const [y, m, d] = (dateStr || "").split("-").map(Number);
  if (!y || !m || !d) return dateStr || "";
  return `${d}/${m}`;
}

//////////// Sanitizers for note (הערות) ////////////
function sanitizeNoteRaw(raw?: string | null): string {
  const s = String(raw ?? "").replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "");
  return s.replace(/[^\x09\x0A\x0D\x20-\x7E\u0590-\u05FF\u0600-\u06FF]/g, "").trim();
}
function clampNoteLen(s: string, max = 500): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
function noteAsHtml(note?: string | null): string {
  const clean = clampNoteLen(sanitizeNoteRaw(note));
  if (!clean) return "";
  const esc = clean.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const withBr = esc.replace(/\n/g, "<br/>");
  return `
    <div style="margin-top:14px;border:1px solid ${palette.border};border-radius:12px;background:${palette.surface};padding:12px 14px;">
      <div style="font-weight:800;margin-bottom:6px;color:${palette.text}">הערות/בקשות הלקוח:</div>
      <div style="white-space:pre-wrap;line-height:1.5;color:${palette.sub}">${withBr}</div>
    </div>
  `;
}
function noteAsText(note?: string | null): string {
  const clean = clampNoteLen(sanitizeNoteRaw(note));
  return clean ? `\nהערות הלקוח:\n${clean}\n` : "";
}

//////////////// אימות מייל אחרי הרשמה ////////////////
export async function sendVerifyEmail(to: string, token: string) {
  const link = buildUrl(`/auth/verify?token=${encodeURIComponent(token)}`);
  const html = `
${baseWrapStart}ברוכים הבאים ל-GeoTable${baseWrapMid}נשאר רק לאמת את כתובת הדוא״ל שלך.${baseWrapEndHead}
  <div style="text-align:center;margin:16px 0 18px;">
    <a href="${link}" style="
      display:inline-block;background:${palette.btn};color:${palette.btnText};
      padding:12px 18px;border-radius:999px;text-decoration:none;font-weight:800;">
      אימות חשבון
    </a>
  </div>
  <p style="margin:0;color:${palette.sub};font-size:14px;word-break:break-all">
    או הדבק/י ידנית: <a href="${link}" style="color:${palette.link}">${link}</a>
  </p>
${baseWrapClose}
  `;
  return await sendMail(to, 'אימות כתובת דוא"ל – GeoTable', html);
}

//////////////// קישור לשחזור סיסמה ////////////////
export async function sendResetEmail(to: string, token: string) {
  const link = buildUrl(`/auth/reset?token=${encodeURIComponent(token)}`);
  const html = `
${baseWrapStart}איפוס סיסמה${baseWrapMid}לחצי/לחץ על הכפתור כדי להגדיר סיסמה חדשה.${baseWrapEndHead}
  <div style="text-align:center;margin:16px 0 18px;">
    <a href="${link}" style="
      display:inline-block;background:${palette.btn};color:${palette.btnText};
      padding:12px 18px;border-radius:999px;text-decoration:none;font-weight:800;">
      איפוס סיסמה
    </a>
  </div>
  <p style="margin:0;color:${palette.sub};font-size:14px;word-break:break-all">
    קישור ישיר: <a href="${link}" style="color:${palette.link}">${link}</a>
  </p>
${baseWrapClose}
  `;
  return await sendMail(to, "שחזור סיסמה – GeoTable", html);
}

//////////////// אישור הזמנה ללקוח ////////////////
export async function sendReservationEmail(opts: {
  to: string;
  restaurantName: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
  people: number;
  customerName?: string;
  manageUrl?: string; // כפתור ניהול ישיר
  reservationId?: string; // לקליינט – אנטי קליפינג
  note?: string | null; // הערות הלקוח
}) {
  const {
    to, restaurantName, date, time, people,
    customerName, manageUrl, reservationId, note,
  } = opts;
  const d = new Date(`${date}T12:00:00`);
  const dayShort = isNaN(d.getTime()) ? "" : hebDayShort(d);
  const dm = formatDM(date);

  const shortId =
    (reservationId && reservationId.slice(-6)) ||
    (manageUrl?.split("/").pop()?.replace(/[^a-zA-Z0-9]/g, "").slice(-6)) ||
    "";

  const detailsCard = `
    <div style="
      background:${palette.surface};color:${palette.text};
      border-radius:16px;padding:16px 14px;max-width:520px;margin:10px auto 6px;
      border:1px solid ${palette.border};">
      <table role="presentation" width="100%" style="border-collapse:collapse;color:${palette.text}">
        <tr>
          <td style="width:33%;text-align:center;">
            <div style="opacity:.8;font-size:13px;color:${palette.sub}">יום / ת׳</div>
            <div style="font-size:20px;font-weight:800;letter-spacing:.3px;">${dayShort} ${dm}</div>
          </td>
          <td style="width:33%;text-align:center;">
            <div style="opacity:.8;font-size:13px;color:${palette.sub}">בשעה</div>
            <div style="font-size:20px;font-weight:800;letter-spacing:.3px;">${time}</div>
          </td>
          <td style="width:33%;text-align:center;">
            <div style="opacity:.8;font-size:13px;color:${palette.sub}">אורחים</div>
            <div style="font-size:20px;font-weight:800;letter-spacing:.3px;">${people}</div>
          </td>
        </tr>
      </table>
      ${
        shortId
          ? `<div style="margin-top:8px;text-align:center;font-size:12px;color:${palette.sub}">
               קוד הזמנה: <strong style="letter-spacing:.4px;color:${palette.text}">${shortId}</strong>
             </div>`
          : ""
      }
    </div>
  `;

  const notesHtml = noteAsHtml(note);

  const html = `
${baseWrapStart}${restaurantName}${baseWrapMid}פרטי ההזמנה שלך. ניתן לאשר/לבטל/לשנות מועד דרך הקישור למטה.${baseWrapEndHead}
  ${detailsCard}

  <div style="padding:6px 4px 0;">
    ${customerName ? `<p style="margin:8px 0 0;">שלום ${customerName},</p>` : ""}
    <p style="margin:8px 0 0;">🎉 הזמנתך נקלטה. נשמח לאשר הגעה כמה דקות לפני.</p>
    <p style="margin:6px 0 0;">🚗 חניה מוזלת ללקוחות המסעדה בסופי שבוע החל מ-18:00.</p>
    <p style="margin:6px 0 0;">⏱️ השולחן ישמר 15 דקות.</p>
    <p style="margin:6px 0 0;">מחכים לראותכם ❤️</p>
  </div>

  ${notesHtml}

  <div style="text-align:center;margin:16px 0 0;">
    ${
      manageUrl
        ? `<a href="${manageUrl}" style="
              display:inline-block;background:${palette.btn};color:${palette.btnText};
              padding:12px 18px;border-radius:999px;text-decoration:none;font-weight:800;">
              ניהול ההזמנה (אישור/ביטול/שינוי)
           </a>`
        : `<a href="${buildUrl("/")}" style="
              display:inline-block;background:${palette.btn};color:${palette.btnText};
              padding:12px 18px;border-radius:999px;text-decoration:none;font-weight:800;">
              דף המסעדה
           </a>`
    }
  </div>

  ${
    manageUrl
      ? `<p style="margin:14px 0 0;color:${palette.sub};font-size:14px;word-break:break-all">
           קישור ישיר: <a href="${manageUrl}" style="color:${palette.link}">${manageUrl}</a>
         </p>`
      : ""
  }
${baseWrapClose}
  `;

  const text = [
    `${restaurantName} – אישור הזמנה`,
    customerName ? `שלום ${customerName},` : "",
    `תאריך: ${date} | שעה: ${time} | סועדים: ${people}`,
    shortId ? `קוד הזמנה: ${shortId}` : "",
    "🎉 הזמנתך נקלטה. השולחן ישמר 15 דקות. חניה מוזלת בסופי שבוע מ-18:00.",
    noteAsText(note).trim(),
    manageUrl
      ? `ניהול ההזמנה (אישור/ביטול/שינוי): ${manageUrl}`
      : `לפרטים: ${buildUrl("/")}`,
  ]
    .filter(Boolean)
    .join("\n");

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

//////////////// התראה לבעל המסעדה ////////////////
export async function notifyOwnerEmail(opts: {
  to: string | string[];
  restaurantName: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  date: string;
  time: string;
  people: number;
  note?: string | null;
}) {
  const {
    to, restaurantName, customerName, customerPhone, customerEmail,
    date, time, people, note,
  } = opts;

  const notesHtml = noteAsHtml(note);

  const html = `
${baseWrapStart}התקבלה הזמנה חדשה${baseWrapMid}${restaurantName}${baseWrapEndHead}
  <div style="
    background:${palette.surface};border:1px solid ${palette.border};
    color:${palette.text};border-radius:14px;padding:12px 14px;">
    <p style="margin:0;">
      <strong>תאריך:</strong> ${date} · <strong>שעה:</strong> ${time} · <strong>סועדים:</strong> ${people}
    </p>
  </div>
  <div style="margin-top:12px;">
    <p style="margin:0;"><strong>שם הלקוח:</strong> ${customerName}</p>
    <p style="margin:0;"><strong>נייד:</strong> ${customerPhone || "-"}</p>
    <p style="margin:0;"><strong>אימייל:</strong> ${customerEmail || "-"}</p>
  </div>
  ${notesHtml}
${baseWrapClose}
  `;

  const text =
    `התקבלה הזמנה חדשה – ${restaurantName}\n` +
    `תאריך: ${date} | שעה: ${time} | סועדים: ${people}\n` +
    `לקוח: ${customerName} | נייד: ${customerPhone || "-"} | אימייל: ${customerEmail || "-"}\n` +
    (noteAsText(note) || "");

  return await sendMailAny({
    to,
    subject: `הזמנה חדשה – ${restaurantName}`,
    html,
    text,
  });
}

//////////////// תזכורת (למשל יום לפני) ////////////////
export async function sendReminderEmail(opts: {
  to: string | string[];
  confirmUrl: string;
  restaurantName: string;
  date: string;
  time: string;
  people: number;
  customerName?: string;
}) {
  const { to, confirmUrl, restaurantName, date, time, people, customerName } =
    opts;
  const link = confirmUrl.startsWith("http") ? confirmUrl : buildUrl(confirmUrl);

  const html = `
${baseWrapStart}תזכורת להזמנה${baseWrapMid}${restaurantName}${baseWrapEndHead}
  <div style="
    background:${palette.surface};border:1px solid ${palette.border};
    color:${palette.text};border-radius:16px;padding:14px;">
    <p style="margin:0;">
      <strong>תאריך:</strong> ${date} · <strong>שעה:</strong> ${time} · <strong>סועדים:</strong> ${people}
    </p>
  </div>
  <div style="margin-top:12px;">
    ${customerName ? `<p style="margin:0;">שלום ${customerName},</p>` : ""}
    <p style="margin:6px 0 0;">נא אשר/י הגעה בלחיצה:</p>
    <div style="text-align:center;margin:12px 0 0;">
      <a href="${link}" style="
        display:inline-block;background:${palette.btn};color:${palette.btnText};
        padding:12px 18px;border-radius:999px;text-decoration:none;font-weight:800;">
        אישור הגעה
      </a>
    </div>
  </div>
${baseWrapClose}
  `;
  const text =
    `תזכורת להזמנה – ${restaurantName}\n` +
    `תאריך: ${date} | שעה: ${time} | סועדים: ${people}\n` +
    `אישור הגעה: ${link}`;
  return await sendMailAny({
    to,
    subject: "תזכורת להזמנה – נא אשר/י הגעה",
    html,
    text,
  });
}
