// src/lib/mail.ts
// שליחת אימייל אימות דרך Resend (אם RESEND_API_KEY + BASE_URL מוגדרים). אחרת: לוג בלבד.

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const BASE_URL = Deno.env.get("BASE_URL") ?? ""; // למשל: https://your-app.deno.dev

export async function sendVerifyEmail(to: string, token: string) {
  const verifyUrl = `${BASE_URL}/verify?token=${encodeURIComponent(token)}`;
  const subject = "אימות כתובת מייל - GeoTable";
  const html = `
    <div style="font-family:Arial,sans-serif">
      <h2>אימות כתובת המייל שלך</h2>
      <p>כדי להשלים את ההרשמה, יש ללחוץ על הקישור הבא:</p>
      <p><a href="${verifyUrl}" target="_blank" rel="noopener">אימות חשבון</a></p>
      <p>אם לא ביקשת לפתוח חשבון — התעלם מהודעה זו.</p>
    </div>
  `;

  if (!RESEND_API_KEY || !BASE_URL) {
    console.log("[MAIL] (dry-run) would send to:", to, "url:", verifyUrl);
    return;
  }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "GeoTable <no-reply@your-domain>",
      to: [to],
      subject,
      html,
    }),
  });
  if (!r.ok) {
    const text = await r.text();
    console.error("[MAIL] send failed:", r.status, text);
  }
}
