// Build-time compatibility/security patch for the modernized overlay.
// The deployment overlay is reconstructed during the Docker build, so these
// production-only fixes are applied after extraction. Every required marker is
// checked so the image fails closed instead of shipping a partial patch.

async function read(path: string): Promise<string> {
  return await Deno.readTextFile(path);
}

async function write(path: string, text: string): Promise<void> {
  await Deno.writeTextFile(path, text);
}

function replaceRequired(
  text: string,
  from: string | RegExp,
  to: string,
  label: string,
  already?: string,
): string {
  if (already && text.includes(already)) return text;
  const next = text.replace(from, to);
  if (next === text) throw new Error(`Patch marker not found: ${label}`);
  return next;
}

// 1) Trust Railway's forwarded scheme/host and let Railway's internal HTTP
// health probe reach /__health without being redirected to HTTPS.
{
  const path = "/app/server.ts";
  let text = await read(path);

  text = replaceRequired(
    text,
    "export const app = new Application();",
    "export const app = new Application({ proxy: true });",
    "Oak proxy configuration",
    "new Application({ proxy: true })",
  );

  text = replaceRequired(
    text,
    '  if (NODE_ENV !== "development" && !isHttps(ctx)) {',
    '  if (NODE_ENV !== "development" && ctx.request.url.pathname !== "/__health" && !isHttps(ctx)) {',
    "healthcheck HTTPS exemption",
    'ctx.request.url.pathname !== "/__health"',
  );

  // The modernized overlay already hides /__echo in production. Verify that
  // protection is still present rather than adding a second, brittle guard.
  if (!text.includes('if (NODE_ENV !== "development") { ctx.response.status = 404; return; }')) {
    throw new Error("Expected production gate on /__echo");
  }

  await write(path, text);
}

// 2) Railway terminates TLS at the edge. Keep the browser cookie Secure while
// allowing Oak to emit it over the trusted internal HTTP hop.
{
  const path = "/app/lib/session.ts";
  let text = await read(path);
  text = replaceRequired(
    text,
    "secure: isHttps(ctx),",
    "secure: isHttps(ctx), ignoreInsecure: true,",
    "session secure cookie options",
    "secure: isHttps(ctx), ignoreInsecure: true,",
  );
  await write(path, text);
}

// 3) Apply the same trusted-proxy treatment to language preference cookies.
{
  const path = "/app/middleware/i18n.ts";
  let text = await read(path);
  text = replaceRequired(
    text,
    "const firstTry = { ...base, secure: isSecure(ctx) };",
    "const firstTry = { ...base, secure: isSecure(ctx), ignoreInsecure: true };",
    "i18n secure cookie options",
    "const firstTry = { ...base, secure: isSecure(ctx), ignoreInsecure: true };",
  );
  await write(path, text);
}

console.log("[railway-patch] production proxy/cookie patches applied");
