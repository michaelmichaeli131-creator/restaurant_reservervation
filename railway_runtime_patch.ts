// Build-time compatibility/security patch for the modernized overlay.
// The deployment overlay is reconstructed during the Docker build, so these
// production-only fixes are applied after extraction. The same patcher can be
// run in CI against the reconstructed workspace by setting SPOTBOOK_ROOT.

const ROOT = (Deno.env.get("SPOTBOOK_ROOT") ?? "/app").replace(/\/$/, "");
const file = (rel: string) => `${ROOT}/${rel.replace(/^\//, "")}`;

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

function replaceAllIfPresent(text: string, from: string, to: string): string {
  return text.includes(from) ? text.split(from).join(to) : text;
}

// 1) Trust Railway's forwarded scheme/host and let Railway's internal HTTP
// health probe reach /__health without being redirected to HTTPS.
{
  const path = file("server.ts");
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

  if (!text.includes('if (NODE_ENV !== "development") { ctx.response.status = 404; return; }')) {
    throw new Error("Expected production gate on /__echo");
  }

  await write(path, text);
}

// 2) Railway terminates TLS at the edge. Keep browser cookies Secure while
// allowing Oak to emit them over the trusted internal HTTP hop. Oak 17 types
// SameSite values in lowercase. Normalize old snapshots without duplicating
// an existing `as const` assertion.
for (const rel of ["lib/session.ts", "middleware/i18n.ts", "routes/lang.ts"]) {
  const path = file(rel);
  let text = await read(path);
  text = replaceAllIfPresent(text, 'sameSite: "lax" as const as const', 'sameSite: "lax" as const');
  text = replaceAllIfPresent(text, 'sameSite: "Lax" as const', 'sameSite: "lax" as const');
  text = replaceAllIfPresent(text, 'sameSite: "Lax"', 'sameSite: "lax"');

  if (rel === "lib/session.ts") {
    text = replaceRequired(
      text,
      "secure: isHttps(ctx),",
      "secure: isHttps(ctx), ignoreInsecure: true,",
      "session secure cookie options",
      "secure: isHttps(ctx), ignoreInsecure: true,",
    );
  } else {
    text = replaceRequired(
      text,
      "const firstTry = { ...base, secure: isSecure(ctx) };",
      "const firstTry = { ...base, secure: isSecure(ctx), ignoreInsecure: true };",
      `${rel} secure cookie options`,
      "const firstTry = { ...base, secure: isSecure(ctx), ignoreInsecure: true };",
    );
  }
  await write(path, text);
}

// 3) Existing code uses debugLog/dlog both as (tag, data) and
// (tag, message, data). Support both forms. This is a no-op in production when
// debug logging is disabled, but removes a large class of compatibility errors.
{
  const path = file("lib/debug.ts");
  let text = await read(path);
  if (!text.includes("extra?: unknown")) {
    text = replaceRequired(
      text,
      "export function debugLog(tag: string, data?: unknown) {\n  if (!ENABLED) return;",
      "export function debugLog(tag: string, data?: unknown, extra?: unknown) {\n  if (!ENABLED) return;\n  if (extra !== undefined) data = { message: data, data: extra };",
      "debugLog 3-argument compatibility",
    );
  }
  await write(path, text);
}

// 4) Staff time clock is a real permission used throughout the staff flows but
// was missing from the central union type.
{
  const path = file("database.ts");
  let text = await read(path);
  if (!text.includes('| "time.clock"')) {
    text = replaceRequired(
      text,
      '| "menu.manage";',
      '| "menu.manage"\n  | "time.clock";',
      "StaffPermission time.clock",
    );
  }
  await write(path, text);
}

// 5) Newer TS/WebCrypto declarations distinguish ArrayBuffer from
// SharedArrayBuffer-backed typed arrays. Copy external byte views into fresh
// Uint8Arrays before handing them to WebCrypto. Runtime behavior is unchanged.
{
  const path = file("lib/auth.ts");
  let text = await read(path);
  if (!text.includes("const saltBytes = new Uint8Array(salt.length);")) {
    text = replaceRequired(
      text,
      '  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: ALGO, salt, iterations }, key, length * 8);',
      '  const saltBytes = new Uint8Array(salt.length);\n  saltBytes.set(salt);\n  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: ALGO, salt: saltBytes, iterations }, key, length * 8);',
      "PBKDF2 BufferSource compatibility",
    );
  }
  await write(path, text);
}

{
  const path = file("lib/token.ts");
  let text = await read(path);
  if (!text.includes("const signature = new Uint8Array(sigBytes.length);")) {
    text = replaceRequired(
      text,
      '  const sigBytes = b64urlToBytes(sigB64u);\n  return await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(message));',
      '  const sigBytes = b64urlToBytes(sigB64u);\n  const signature = new Uint8Array(sigBytes.length);\n  signature.set(sigBytes);\n  return await crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(message));',
      "HMAC BufferSource compatibility",
    );
  }
  await write(path, text);
}

// 6) Oak 17 exposes body parsers as methods on ctx.request.body. Replace legacy
// Oak body() call sites that would otherwise silently fail or throw at runtime.
{
  const path = file("routes/owner_capacity.ts");
  let text = await read(path);
  text = replaceRequired(
    text,
    'const body = await (ctx.request.body({ type: "form" }).value) as URLSearchParams;',
    'const body = await ctx.request.body.form();',
    "owner capacity Oak 17 form body",
    'const body = await ctx.request.body.form();',
  );
  await write(path, text);
}

{
  const path = file("routes/owner_payroll.ts");
  let text = await read(path);
  if (!text.includes("body = await ctx.request.body.json();")) {
    const legacy = /    let body: any = \{\};\n    try \{\n      body = await ctx\.request\.body\(\{ type: "json" \}\)\.value;\n    \} catch \{\n      try \{\n        body = await \(ctx\.request\.originalRequest\?\.request\?\.json\?\.\(\) \?\?\n          ctx\.request\.originalRequest\?\.json\?\.\(\)\);\n      \} catch \{\n        body = \{\};\n      \}\n    \}/;
    text = replaceRequired(
      text,
      legacy,
      '    let body: any = {};\n    try {\n      body = await ctx.request.body.json();\n    } catch {\n      body = {};\n    }',
      "owner payroll Oak 17 JSON body",
    );
  }
  await write(path, text);
}

// System-time writes used a mix of Oak 12/17 body APIs. Replace the parser as
// one unit so JSON, urlencoded, multipart and plain-text requests use Oak 17.
{
  const path = file("routes/system_time.ts");
  let text = await read(path);
  const modernParser = `async function readBody(ctx: any) {
  const ct = String(ctx.request.headers.get("content-type") || "").toLowerCase();
  const bodyApi = (ctx.request as any).body;

  try {
    if (ct.includes("application/json")) {
      const value = await bodyApi.json();
      return value && typeof value === "object" ? value : {};
    }
    if (ct.includes("application/x-www-form-urlencoded")) {
      const form = await bodyApi.form();
      return Object.fromEntries(form.entries());
    }
    if (ct.includes("multipart/form-data")) {
      const form = await bodyApi.formData();
      return Object.fromEntries(form.entries());
    }

    const raw = String(await bodyApi.text() || "").trim();
    if (!raw) return {};
    if (raw.startsWith("{")) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    }
    const params = new URLSearchParams(raw);
    const entries = Object.fromEntries(params.entries());
    return Object.keys(entries).length ? entries : {};
  } catch {
    return {};
  }
}`;

  if (!text.includes("const bodyApi = (ctx.request as any).body;")) {
    text = replaceRequired(
      text,
      /async function readBody\(ctx: any\) \{[\s\S]*?\n\}\n\nasync function ensureAccess/,
      `${modernParser}\n\nasync function ensureAccess`,
      "system-time Oak 17 body parser",
    );
  }
  await write(path, text);
}

// 7) Floor-plan full response referenced a block-scoped legacy floorPlan. Patch
// only the full-plan route; the /statuses route intentionally keeps its own
// local legacy variable and must not be rewritten.
{
  const path = file("routes/owner_floor.ts");
  let text = await read(path);
  const statusesMarker = "\n// NEW: GET /api/floor-plans/:restaurantId/statuses";
  const splitAt = text.indexOf(statusesMarker);
  if (splitAt < 0) throw new Error("Patch marker not found: owner floor statuses route");

  let fullRoute = text.slice(0, splitAt);
  const statusesAndRest = text.slice(splitAt);

  const tripleAccess = `    if (!(await requireRestaurantAccess(ctx, restaurantId))) return;\n\n    if (!(await requireRestaurantAccess(ctx, restaurantId))) return;\n\n    if (!(await requireRestaurantAccess(ctx, restaurantId))) return;`;
  if (fullRoute.includes(tripleAccess)) {
    fullRoute = fullRoute.replace(tripleAccess, "    if (!(await requireRestaurantAccess(ctx, restaurantId))) return;");
  }

  if (!fullRoute.includes("let floorPlan: FloorPlan | FloorLayout | null")) {
    fullRoute = replaceRequired(
      fullRoute,
      "    const layoutCandidates = await listFloorLayouts(restaurantId).catch(() => []);\n    let liveTables = (layoutCandidates ?? [])",
      "    const activeLayout = await getActiveFloorLayout(restaurantId).catch(() => null);\n    let floorPlan: FloorPlan | FloorLayout | null = activeLayout ?? null;\n    const layoutCandidates = await listFloorLayouts(restaurantId).catch(() => []);\n    if (!floorPlan && layoutCandidates.length) floorPlan = layoutCandidates[0] as FloorLayout;\n    let liveTables = (layoutCandidates ?? [])",
      "owner floor response plan initialization",
    );
  }

  fullRoute = replaceRequired(
    fullRoute,
    "        const floorPlan = floorPlanRes.value as FloorPlan;",
    "        floorPlan = floorPlanRes.value as FloorPlan;",
    "owner floor legacy fallback scope",
    "        floorPlan = floorPlanRes.value as FloorPlan;",
  );
  fullRoute = replaceRequired(
    fullRoute,
    "      ...floorPlan,\n      tableStatuses,",
    "      ...(floorPlan ?? { restaurantId, tables: liveTables }),\n      tableStatuses,",
    "owner floor response metadata",
    "      ...(floorPlan ?? { restaurantId, tables: liveTables }),\n      tableStatuses,",
  );

  text = fullRoute + statusesAndRest;
  await write(path, text);
}

// 8) Owner-calendar access accidentally treated requireOwner()'s boolean guard
// as the User object. Use the guard, then read the authenticated user from state.
{
  const path = file("routes/owner_calendar.ts");
  let text = await read(path);
  if (!text.includes("const user = ctx.state.user;")) {
    text = replaceRequired(
      text,
      'async function ensureOwnerAccess(ctx: any, rid: string): Promise<Restaurant> {\n  const user = await requireOwner(ctx);',
      'async function ensureOwnerAccess(ctx: any, rid: string): Promise<Restaurant> {\n  if (!requireOwner(ctx)) ctx.throw(Status.Forbidden, "Owner access required");\n  const user = ctx.state.user;',
      "owner calendar authenticated user",
    );
  }
  await write(path, text);
}

// 9) Reservation portal supports database snapshots where the optional room
// enrichment helper is absent. Preserve the reservation rather than crashing.
{
  const path = file("routes/reservation_portal.ts");
  let text = await read(path);
  text = replaceAllIfPresent(
    text,
    "const reservation = reservationRaw ? await enrichReservationWithRoomMeta(reservationRaw.restaurantId, reservationRaw) : null;",
    'const reservation = reservationRaw ? (typeof enrichReservationWithRoomMeta === "function" ? await enrichReservationWithRoomMeta(reservationRaw.restaurantId, reservationRaw) : reservationRaw) : null;',
  );
  text = replaceAllIfPresent(
    text,
    "const fresh = freshRaw ? await enrichReservationWithRoomMeta(freshRaw.restaurantId, freshRaw) : freshRaw;",
    'const fresh = freshRaw ? (typeof enrichReservationWithRoomMeta === "function" ? await enrichReservationWithRoomMeta(freshRaw.restaurantId, freshRaw) : freshRaw) : freshRaw;',
  );
  await write(path, text);
}

// 10) One body utility in older snapshots calls debugLog without importing it.
{
  const path = file("routes/restaurants/_utils/body.ts");
  let text = await read(path);
  const importLine = 'import { debugLog } from "../../../lib/debug.ts";';
  if (!text.includes(importLine)) {
    text = `${importLine}\n${text}`;
  }
  await write(path, text);
}

// 11) Eta 3 renderAsync() no longer needs/accepts the old `async` constructor
// option; keeping it only creates a type error.
{
  const path = file("lib/view.ts");
  let text = await read(path);
  text = replaceAllIfPresent(text, "  async: true,\n", "");
  await write(path, text);
}

console.log(`[railway-patch] production compatibility patches applied under ${ROOT}`);
