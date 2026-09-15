// Build-time compatibility/security patch for the modernized overlay.
// The deployment overlay is reconstructed during the Docker build, so these
// small production-only fixes must be applied after extraction.

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

// 1) Trust Railway's forwarded scheme/host, keep the debug echo endpoint out of
// production, and allow Railway's internal HTTP health probe through without
// redirecting it to HTTPS.
{
  const path = "/app/server.ts";
  let text = await read(path);

  text = replaceRequired(
    text,
    "const app = new Application();",
    "const app = new Application({ proxy: true });",
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

  const echoMarker = 'root.get("/__echo", (ctx) => {\n';
  const echoGuard =
    '  if (NODE_ENV !== "development") {\n' +
    '    ctx.response.status = Status.NotFound;\n' +
    '    ctx.response.body = "Not Found";\n' +
    '    return;\n' +
    '  }\n';
  if (!text.includes('ctx.response.body = "Not Found";\n    return;\n  }\n  const info = {')) {
    if (!text.includes(echoMarker)) throw new Error("Patch marker not found: /__echo");
    text = text.replace(echoMarker, echoMarker + echoGuard);
  }

  await write(path, text);
}

// 2) Session cookie: the public request is HTTPS but Railway terminates TLS at
// the edge. Oak therefore sees an HTTP backend hop. `ignoreInsecure` prevents
// Oak from throwing while still emitting the Secure attribute requested by us.
{
  const path = "/app/lib/session.ts";
  let text = await read(path);
  if (!text.includes("ignoreInsecure: true")) {
    const startMarker = "await ctx.cookies.set(cookieName, sid, {";
    const start = text.indexOf(startMarker);
    if (start < 0) throw new Error("Patch marker not found: session cookie set");
    const end = text.indexOf("\n  });", start);
    if (end < 0) throw new Error("Patch marker not found: session cookie block end");
    const block = text.slice(start, end);
    const patched = block.replace(
      /(\n\s*secure,[^\n]*)/,
      "$1\n    ignoreInsecure: true,",
    );
    if (patched === block) throw new Error("Patch marker not found: session secure option");
    text = text.slice(0, start) + patched + text.slice(end);
  }
  await write(path, text);
}

// 3) Language cookies use the same TLS-terminated proxy path.
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
