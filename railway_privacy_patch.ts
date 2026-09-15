// Production logging privacy hardening.
// Applied after the modernized overlay/runtime compatibility patch.

const ROOT = (Deno.env.get("SPOTBOOK_ROOT") ?? "/app").replace(/\/$/, "");
const file = (rel: string) => `${ROOT}/${rel.replace(/^\//, "")}`;

function replaceRequired(
  text: string,
  from: string | RegExp,
  to: string,
  label: string,
  already?: string,
): string {
  if (already && text.includes(already)) return text;
  const next = text.replace(from, to);
  if (next === text) throw new Error(`Privacy patch marker not found: ${label}`);
  return next;
}

// Keep operational request logs useful without storing customer email, user IDs,
// client IP addresses or authentication-state PII.
{
  const path = file("server.ts");
  let text = await Deno.readTextFile(path);

  text = replaceRequired(
    text,
    '  const ip = getClientIp(ctx) ?? "-";\n',
    "",
    "remove raw client IP from response logger",
    "authenticated:${String(user.role ?? \"user\")}",
  );

  text = replaceRequired(
    text,
    '  const userTag = user ? `${user.email}(${user.id})` : "-";',
    '  const userTag = user ? `authenticated:${String(user.role ?? "user")}` : "-";',
    "redact email/user id from response logger",
    'authenticated:${String(user.role ?? "user")}',
  );

  text = replaceRequired(
    text,
    '      ` ${dt.toFixed(1)}ms ip=${ip} user=${userTag}`,',
    '      ` ${dt.toFixed(1)}ms user=${userTag}`,',
    "redact IP from response log line",
    '`${dt.toFixed(1)}ms user=${userTag}`',
  );

  if (text.includes("userEmail: user?.email")) {
    text = text.replace(
      /  \/\/ 🔎 לוג מפורט ל-Auth Gate\n  console\.log\("\[AUTH_GATE\] check", \{\n    path,\n    needsAuth,\n    hasUser: Boolean\(user\),\n    userId: user\?\.id,\n    userEmail: user\?\.email,\n    role: user\?\.role,\n  \}\);/,
      '  // Production auth-gate log: intentionally excludes email/user ID.\n  console.log("[AUTH_GATE] check", {\n    path,\n    needsAuth,\n    hasUser: Boolean(user),\n    role: user?.role,\n  });',
    );
  }

  text = text.replace(
    /    console\.warn\("\[AUTH_GATE\] blocked – email not verified", \{\n      userId: user\.id,\n      email: user\.email,\n      path,\n    \}\);/,
    '    console.warn("[AUTH_GATE] blocked – email not verified", { path, role: user.role });',
  );

  text = text.replace(
    /    console\.warn\("\[AUTH_GATE\] blocked – user inactive", \{\n      userId: user\.id,\n      email: user\.email,\n      path,\n    \}\);/,
    '    console.warn("[AUTH_GATE] blocked – user inactive", { path, role: user.role });',
  );

  text = text.replace(
    /  console\.log\("\[AUTH_GATE\] access granted", \{\n    path,\n    userId: user\.id,\n    role: user\.role,\n  \}\);/,
    '  console.log("[AUTH_GATE] access granted", { path, role: user.role });',
  );

  if (text.includes("userEmail: user?.email") || text.includes("email: user.email")) {
    throw new Error("Privacy patch left a raw user email in AUTH_GATE logging");
  }

  await Deno.writeTextFile(path, text);
}

// Even if verbose debug logging is accidentally enabled later, never emit
// cookies/auth headers or a query string that may contain an admin key/token.
{
  const path = file("lib/log_mw.ts");
  let text = await Deno.readTextFile(path);

  text = replaceRequired(
    text,
    '      for (const [k,v] of req.headers.entries()) headers[k] = v;',
    '      for (const [k, v] of req.headers.entries()) {\n        const lower = String(k).toLowerCase();\n        headers[k] = ["cookie", "authorization", "proxy-authorization", "x-api-key"].includes(lower)\n          ? "[redacted]"\n          : v;\n      }',
    "redact sensitive request headers",
    '"[redacted]"',
  );

  text = replaceRequired(
    text,
    '      url: req.url?.toString?.() || "",',
    '      path: req.url?.pathname || "",',
    "drop query string from debug request logs",
    'path: req.url?.pathname || ""',
  );

  await Deno.writeTextFile(path, text);
}

console.log(`[privacy-patch] production log redaction applied under ${ROOT}`);
