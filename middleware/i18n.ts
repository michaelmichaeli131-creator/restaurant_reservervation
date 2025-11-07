// /src/lib/mail.ts
// מודול שליחת מיילים עם תמיכה בשפות (he/en/ka) לפי פרמטר lang.
// נשען על RESEND (או ספק אחר) כפי שהיה בפרויקט; אם אין, מספק dry-run.

type Lang = "he" | "en" | "ka";

function normLang(l?: string | null): Lang {
  const v = String(l || "").toLowerCase();
  return v === "en" || v === "ka" ? v : "he";
}

function dirByLang(l: Lang): "rtl" | "ltr" {
  return l === "he" ? "rtl" : "ltr";
}

/** תרגומי מיילים */
const MAIL_I18N = {
  hello: { he: "שלום", en: "Hello", ka: "გამარჯობა" },
  detailsLead: {
    he: "פרטי ההזמנה שלך. ניתן לאשר/לבטל/לשנות מועד דרך הקישור למטה.",
    en: "Your reservation details. You can confirm, cancel, or reschedule via the link below.",
    ka: "ჯავშნის დეტალები. შეგიძლიათ დადასტურება/გაუქმება/დროის შეცვლა ქვემოთ მოცემული ბმით.",
  },
  date: { he: "תאריך", en: "Date", ka: "თარიღი" },
  time: { he: "שעה", en: "Time", ka: "დრო" },
  guests: { he: "אורחים", en: "Guests", ka: "სტუმრები" },
  dayLabel: { he: "יום / ת׳", en: "Day / D/M", ka: "დღე / D/M" },
  manageCta: { he: "ניהול הזמנה", en: "Manage reservation", ka: "მართე ჯავშანი" },
  note: { he: "הערה", en: "Note", ka: "შენიშვნა" },

  // נושאים
  confirmedSubject: {
    he: (r: string) => `הזמנה אושרה – ${r}`,
    en: (r: string) => `Reservation confirmed — ${r}`,
    ka: (r: string) => `ჯავშანი დადასტურებულია — ${r}`,
  },
  reminderSubject: {
    he: "תזכורת להזמנה – נא אשר/י הגעה",
    en: "Reservation reminder — please confirm",
    ka: "მოხსენება — გთხოვთ დადასტურება",
  },
} as const;

function weekdayShortByLang(l: Lang, d: Date): string {
  try {
    const locale = l === "he" ? "he-IL" : (l === "ka" ? "ka-GE" : "en-US");
    return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(d);
  } catch {
    const map = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    return map[d.getDay()] || "";
  }
}

/** עיצוב בסיסי (Palette) */
const palette = {
  bg: "#0b0d12",
  card: "#131722",
  text: "#e6eaef",
  sub: "#9aa4b2",
  border: "#23293a",
  btn: "#2d6cdf",
  btnText: "#ffffff",
  accent: "#3b82f6",
};

/** ספק הדוא״ל — RESEND (כמו שהיה), עם אפשרות Dry-Run בלוגים */
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const RESEND_FROM = (Deno.env.get("RESEND_FROM") ?? "SpotBook <noreply@spotbook.rest>").trim();
const NODE_ENV = Deno.env.get("NODE_ENV") ?? "production";
const DRY_RUN = (Deno.env.get("RESEND_DRY_RUN") === "1") || NODE_ENV !== "production";

async function sendMailAny(opts: { to: string; subject: string; html: string; text?: string }) {
  if (DRY_RUN || !RESEND_API_KEY) {
    console.warn("[mail:dry-run]", {
      to: opts.to, subject: opts.subject,
      previewText: (opts.text ?? "").slice(0, 200)
    });
    return { ok: true, dryRun: true };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text ?? htmlToText(opts.html),
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`[resend] ${res.status} ${res.statusText} :: ${errText}`);
  }
  return await res.json();
}

/** עזרי תצוגת תאריך */
function formatDM(isoDate: string): string {
  // YYYY-MM-DD → D/M
  const [y, m, d] = (isoDate || "").split("-").map(Number);
  if (!y || !m || !d) return isoDate;
  return `${d}/${m}`;
}

/** מעטפת HTML בסיסית */
function baseWrap(htmlInner: string, dir: "rtl" | "ltr") {
  return `
  <div style="background:${palette.bg};padding:24px;direction:${dir}">
    <div style="
      max-width:560px;margin:0 auto;background:${palette.card};
      color:${palette.text};border:1px solid ${palette.border};
      border-radius:16px;overflow:hidden">
      <div style="padding:20px 20px 4px;font-weight:800;font-size:18px;
        letter-spacing:.3px;color:${palette.text}">
        SpotBook
      </div>
      <div style="padding:4px 20px 16px;color:${palette.sub};font-size:12px">
        reservation@spotbook.rest
      </div>
      <div style="height:1px;background:${palette.border};"></div>
      <div style="padding:20px;">
        ${htmlInner}
      </div>
    </div>
    <div style="max-width:560px;margin:18px auto 0;text-align:center;color:${palette.sub};font-size:12px">
      © ${new Date().getFullYear()} SpotBook — All rights reserved
    </div>
  </div>`;
}

/** HTML של כרטיס פרטי הזמנה */
function renderReservationCard(opts: {
  lang: Lang;
  restaurantName: string;
  date: string;   // YYYY-MM-DD
  time: string;   // HH:mm
  people: number;
  customerName?: string;
  manageUrl?: string;
  note?: string | null;
}) {
  const L = opts.lang;
  const dir = dirByLang(L);
  const d = new Date(opts.date + "T00:00:00");
  const dayShort = weekdayShortByLang(L, d);
  const dm = formatDM(opts.date);

  const lead = MAIL_I18N.detailsLead[L];
  const hello = opts.customerName ? `${MAIL_I18N.hello[L]} ${opts.customerName},` : "";

  const body = `
    ${hello ? `<p style="margin:0 0 6px 0;">${hello}</p>` : ""}
    <p style="margin:0 0 16px 0;color:${palette.sub}">${lead}</p>

    <div style="border:1px solid ${palette.border};border-radius:14px;overflow:hidden;">
      <div style="display:flex;gap:0;">
        <div style="flex:1;padding:14px 16px;border-inline-end:1px solid ${palette.border}">
          <div style="opacity:.8;font-size:13px;color:${palette.sub}">${MAIL_I18N.dayLabel[L]}</div>
          <div style="font-weight:800;font-size:16px">${dayShort} · ${dm}</div>
        </div>
        <div style="flex:1;padding:14px 16px;border-inline-end:1px solid ${palette.border}">
          <div style="opacity:.8;font-size:13px;color:${palette.sub}">${MAIL_I18N.time[L]}</div>
          <div style="font-weight:800;font-size:16px">${opts.time}</div>
        </div>
        <div style="flex:1;padding:14px 16px;">
          <div style="opacity:.8;font-size:13px;color:${palette.sub}">${MAIL_I18N.guests[L]}</div>
          <div style="font-weight:800;font-size:16px">${opts.people}</div>
        </div>
      </div>
      <div style="height:1px;background:${palette.border}"></div>
      <div style="padding:12px 16px;font-weight:700">${escapeHtml(opts.restaurantName)}</div>
      ${
        opts.note
          ? `<div style="padding:0 16px 16px;opacity:.9;">
               <div style="opacity:.8;font-size:13px;color:${palette.sub};margin-bottom:4px">
                 ${MAIL_I18N.note[L]}
               </div>
               <div style="white-space:pre-wrap">${escapeHtml(String(opts.note ?? ""))}</div>
             </div>`
          : ""
      }
    </div>

    ${
      opts.manageUrl
        ? `<div style="text-align:center;margin:16px 0 0;">
             <a href="${opts.manageUrl}" style="
               display:inline-block;background:${palette.btn};color:${palette.btnText};
               padding:12px 18px;border-radius:999px;text-decoration:none;font-weight:800;">
               ${MAIL_I18N.manageCta[L]}
             </a>
           </div>`
        : ""
    }
  `;
  return baseWrap(body, dir);
}

function escapeHtml(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll(`"`, "&quot;");
}

/** המרה בסיסית ל־plain text */
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

/* =======================================================================
   עזר קטן: ודא ש־?lang=... מוזרק ל־manageUrl אם ניתן
   ======================================================================= */
function withLang(url?: string, lang?: Lang): string | undefined {
  if (!url) return url;
  if (!lang) return url;
  try {
    const u = new URL(url, "http://local");
    u.searchParams.set("lang", lang);
    // אם היה URL מוחלט – נשמור אותו; אם יחסי, נחזיר path+query
    if (/^https?:\/\//i.test(url)) return u.toString();
    return `${u.pathname}${u.search}`;
  } catch {
    // במקרה של URL לא תקין — נחזיר כמות שהוא
    return url;
  }
}

/* =======================================================================
   API ציבורי
   ======================================================================= */

/** שליחת מייל אישור הזמנה */
export async function sendReservationEmail(opts: {
  to: string;
  restaurantName: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
  people: number;
  customerName?: string;
  manageUrl?: string;
  reservationId?: string;
  note?: string | null;
  lang?: string | null; // ← שפת המייל (he/en/ka), אם לא יינתן — ברירת מחדל he
}) {
  const L = normLang(opts.lang);
  const subject = MAIL_I18N.confirmedSubject[L](opts.restaurantName);

  const manageUrlL = withLang(opts.manageUrl, L);

  const html = renderReservationCard({
    lang: L,
    restaurantName: opts.restaurantName,
    date: opts.date,
    time: opts.time,
    people: opts.people,
    customerName: opts.customerName,
    manageUrl: manageUrlL,
    note: opts.note ?? null,
  });

  const textLines = [
    subject,
    `${MAIL_I18N.date[L]}: ${opts.date} | ${MAIL_I18N.time[L]}: ${opts.time} | ${MAIL_I18N.guests[L]}: ${opts.people}`,
    manageUrlL ? `${MAIL_I18N.manageCta[L]}: ${manageUrlL}` : "",
  ].filter(Boolean);
  const text = textLines.join("\n");

  return await sendMailAny({ to: opts.to, subject, html, text });
}

/** (אופציונלי) שליחת מייל תזכורת */
export async function sendReminderEmail(opts: {
  to: string;
  restaurantName: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
  people: number;
  manageUrl?: string;
  lang?: string | null;
}) {
  const L = normLang(opts.lang);
  const subject = MAIL_I18N.reminderSubject[L];
  const manageUrlL = withLang(opts.manageUrl, L);

  const html = renderReservationCard({
    lang: L,
    restaurantName: opts.restaurantName,
    date: opts.date,
    time: opts.time,
    people: opts.people,
    manageUrl: manageUrlL,
  });

  const textLines = [
    subject,
    `${MAIL_I18N.date[L]}: ${opts.date} | ${MAIL_I18N.time[L]}: ${opts.time} | ${MAIL_I18N.guests[L]}: ${opts.people}`,
    manageUrlL ? `${MAIL_I18N.manageCta[L]}: ${manageUrlL}` : "",
  ].filter(Boolean);
  const text = textLines.join("\n");

  return await sendMailAny({ to: opts.to, subject, html, text });
}
