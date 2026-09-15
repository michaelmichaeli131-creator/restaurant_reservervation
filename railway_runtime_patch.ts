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

  // The modernized overlay already hides /__echo in production. Verify that
  // protection is still present rather than adding a second, brittle guard.
  if (!text.includes('if (NODE_ENV !== "development") { ctx.response.status = 404; return; }')) {
    throw new Error("Expected production gate on /__echo");
  }

  await write(path, text);
}

// 2) Railway terminates TLS at the edge. Keep browser cookies Secure while
// allowing Oak to emit them over the trusted internal HTTP hop. Normalize the
// SameSite spelling to Oak 17's typed lowercase literal at the same time.
for (const rel of ["lib/session.ts", "middleware/i18n.ts", "routes/lang.ts"]) {
  const path = file(rel);
  let text = await read(path);
  text = replaceAllIfPresent(text, 'sameSite: "Lax"', 'sameSite: "lax" as const');

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

// 5) Oak 17 exposes body parsers as methods on ctx.request.body. Replace two
// legacy Oak body() call sites that would otherwise fail at runtime.
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

// 6) Floor-plan live API referenced a block-scoped legacy floorPlan variable
// after the block ended. Preserve the active layout as response metadata and
// fall back to legacy KV data when necessary.
{
  const path = file("routes/owner_floor.ts");
  let text = await read(path);

  const tripleAccess = `    if (!(await requireRestaurantAccess(ctx, restaurantId))) return;\n\n    if (!(await requireRestaurantAccess(ctx, restaurantId))) return;\n\n    if (!(await requireRestaurantAccess(ctx, restaurantId))) return;`;
  if (text.includes(tripleAccess)) {
    text = text.replace(tripleAccess, "    if (!(await requireRestaurantAccess(ctx, restaurantId))) return;");
  }

  if (!text.includes("let floorPlan: FloorPlan | FloorLayout | null")) {
    text = replaceRequired(
      text,
      "    const layoutCandidates = await listFloorLayouts(restaurantId).catch(() => []);\n    let liveTables = (layoutCandidates ?? [])",
      "    const activeLayout = await getActiveFloorLayout(restaurantId).catch(() => null);\n    let floorPlan: FloorPlan | FloorLayout | null = activeLayout ?? null;\n    const layoutCandidates = await listFloorLayouts(restaurantId).catch(() => []);\n    if (!floorPlan && layoutCandidates.length) floorPlan = layoutCandidates[0] as FloorLayout;\n    let liveTables = (layoutCandidates ?? [])",
      "owner floor response plan initialization",
    );
  }

  text = replaceAllIfPresent(
    text,
    "        const floorPlan = floorPlanRes.value as FloorPlan;",
    "        floorPlan = floorPlanRes.value as FloorPlan;",
  );
  text = replaceAllIfPresent(
    text,
    "      ...floorPlan,\n      tableStatuses,",
    "      ...(floorPlan ?? { restaurantId, tables: liveTables }),\n      tableStatuses,",
  );
  await write(path, text);
}

// 7) One body utility in older snapshots calls debugLog without importing it.
{
  const path = file("routes/restaurants/_utils/body.ts");
  let text = await read(path);
  if (!text.includes('import { debugLog } from "../../../lib/debug.ts";')) {
    text = replaceRequired(
      text,
      "// src/routes/restaurants/_utils/body.ts\n",
      '// src/routes/restaurants/_utils/body.ts\nimport { debugLog } from "../../../lib/debug.ts";\n',
      "restaurant body debugLog import",
    );
  }
  await write(path, text);
}

// 8) Eta 3 renderAsync() no longer needs/accepts the old `async` constructor
// option; keeping it only creates a type error.
{
  const path = file("lib/view.ts");
  let text = await read(path);
  text = replaceAllIfPresent(text, "  async: true,\n", "");
  await write(path, text);
}

console.log(`[railway-patch] production compatibility patches applied under ${ROOT}`);
