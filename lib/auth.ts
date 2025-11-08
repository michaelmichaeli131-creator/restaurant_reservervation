// /src/lib/mail.ts
// ------------------------------------------------------------------
// sendVerifyEmail & sendResetEmail עם תמיכה בשפות: he / en / ka
// - מנסה להשתמש ב-mail_wrapper.ts או mail_wrappers.ts (sendEmail)
// - אחרת: fallback ללוג בלבד כדי למנוע קריסה בדיפלוי
// - בניית Subject/Body לפי lang
// ------------------------------------------------------------------

type Lang = "he" | "en" | "ka";

// ===== Transport discovery =====
type SendEmailFn = (opts: {
  to: string;
  subject: string;
  html?: string;
  text?: string;
}) => Promise<unknown>;

let sendEmail: SendEmailFn | null = null;

async function discoverTransport() {
  if (sendEmail) return sendEmail;
  try {
    // נסה mail_wrapper.ts
    // deno-lint-ignore no-var
    const m1 = await import("./mail_wrapper.ts").catch(() => null as any);
    if (m1?.sendEmail) {
      sendEmail = m1.sendEmail as SendEmailFn;
      return sendEmail;
    }
  } catch { /* ignore */ }

  try {
    // לפעמים נקרא mail_wrappers.ts אצלך
    const m2 = await import("./mail_wrappers.ts").catch(() => null as any);
    if (m2?.sendEmail) {
      sendEmail = m2.sendEmail as SendEmailFn;
      return sendEmail;
    }
  } catch { /* ignore */ }

  // Fallback: לוג בלבד (לא נכשלים)
  sendEmail = async (opts) => {
    console.log("[MAIL:DRY-RUN]", {
      to: opts.to,
      subject: opts.subject,
      html: opts.html?.slice(0, 2000) ?? "",
      text: opts.text?.slice(0, 2000) ?? "",
    });
    return { ok: true, dryRun: true };
  };
  return sendEmail;
}

function baseUrl(): string {
  const app = Deno.env.get("APP_BASE_URL") || Deno.env.get("BASE_URL");
  if (app) return app.replace(/\/+$/, "");
  return ""; // ייקח מה־client בצד המקבל אם צריך
}

function tVerify(lang: Lang) {
  switch (lang) {
    case "en":
      return {
        subject: "Verify your email · SpotBook",
        title: "Confirm your email",
        cta: "Verify email",
        note: "If you didn't request this, you can ignore this email.",
      };
    case "ka":
      return {
        subject: "დაადასტურეთ თქვენი ელფოსტა · SpotBook",
        title: "დაადასტურეთ ელფოსტა",
        cta: "ელფოსტის დადასტურება",
        note: "თუ ეს მოთხოვნა თქვენგან არ იყო, უბრალოდ დააიგნორეთ ამ წერილი.",
      };
    default:
      return {
        subject: "אימות כתובת מייל · SpotBook",
        title: "אשר/י את כתובת המייל שלך",
        cta: "אימות מייל",
        note: "אם לא ביקשת זאת, ניתן להתעלם מהודעה זו.",
      };
  }
}

function tReset(lang: Lang) {
  switch (lang) {
    case "en":
      return {
        subject: "Reset your password · SpotBook",
        title: "Password reset",
        cta: "Set a new password",
        note: "If you didn't request this, you can ignore this email.",
      };
    case "ka":
      return {
        subject: "პაროლის აღდგენა · SpotBook",
        title: "პაროლის აღდგენა",
        cta: "ახალი პაროლის დაყენება",
        note: "თუ ეს მოთხოვნა თქვენგან არ იყო, უბრალოდ დააიგნორეთ ამ წერილი.",
      };
    default:
      return {
        subject: "איפוס סיסמה · SpotBook",
        title: "איפוס סיסמה",
        cta: "הגדרת סיסמה חדשה",
        note: "אם לא ביקשת זאת, ניתן להתעלם מהודעה זו.",
      };
  }
}

function htmlShell(title: string, inner: string) {
  // קונטיינר פשוט; אפשר להחליף ל־template ה־ETA שלך בהמשך
  return `<!doctype html>
<html dir="auto"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title></head>
<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5;color:#111;background:#fafafa;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #eee;border-radius:12px;overflow:hidden">
    <div style="padding:20px 24px">
      ${inner}
    </div>
  </div>
  <div style="max-width:560px;margin:12px auto 0;text-align:center;color:#666;font-size:12px">
    SpotBook · This message was sent automatically.
  </div>
</body></html>`;
}

function escapeHtml(s: string) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function makeBtn(href: string, label: string) {
  const safeHref = escapeHtml(href);
  const safeLabel = escapeHtml(label);
  return `<a href="${safeHref}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px">${safeLabel}</a>`;
}

// --------------------------- Public API -----------------------------

/** אימות מייל בהרשמה — כולל lang */
export async function sendVerifyEmail(to: string, token: string, lang: string = "he") {
  const L = (["he", "en", "ka"] as const).includes(lang as any) ? (lang as Lang) : "he";
  const dict = tVerify(L);

  const origin = baseUrl();
  const link = origin
    ? `${origin}/auth/verify?token=${encodeURIComponent(token)}&lang=${encodeURIComponent(L)}`
    : `/auth/verify?token=${encodeURIComponent(token)}&lang=${encodeURIComponent(L)}`;

  const html = htmlShell(dict.title, `
    <h1 style="margin:0 0 12px">${escapeHtml(dict.title)}</h1>
    <p>${escapeHtml("Click the button to finish verifying your email address.")}</p>
    <p>${makeBtn(link, dict.cta)}</p>
    <p style="color:#666;font-size:12px;margin-top:16px">${escapeHtml(dict.note)}</p>
  `);

  const text = `${dict.title}\n\n${link}\n\n${dict.note}\n`;

  const tx = await discoverTransport();
  await tx({ to, subject: dict.subject, html, text });
}

/** איפוס סיסמה — כולל lang */
export async function sendResetEmail(to: string, token: string, lang: string = "he") {
  const L = (["he", "en", "ka"] as const).includes(lang as any) ? (lang as Lang) : "he";
  const dict = tReset(L);

  const origin = baseUrl();
  const link = origin
    ? `${origin}/auth/reset?token=${encodeURIComponent(token)}&lang=${encodeURIComponent(L)}`
    : `/auth/reset?token=${encodeURIComponent(token)}&lang=${encodeURIComponent(L)}`;

  const html = htmlShell(dict.title, `
    <h1 style="margin:0 0 12px">${escapeHtml(dict.title)}</h1>
    <p>${escapeHtml("Click the button below to set a new password.")}</p>
    <p>${makeBtn(link, dict.cta)}</p>
    <p style="color:#666;font-size:12px;margin-top:16px">${escapeHtml(dict.note)}</p>
  `);

  const text = `${dict.title}\n\n${link}\n\n${dict.note}\n`;

  const tx = await discoverTransport();
  await tx({ to, subject: dict.subject, html, text });
}
