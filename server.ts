// --- DEBUG: view source files that are actually deployed ---
import { Router as _DbgRouter } from "@oak/oak";
// אם כבר יש לך dbg Router, תוכל להשתמש בו; אחרת:
const dbg2 = new _DbgRouter();

dbg2.get("/__file", async (ctx) => {
  ctx.response.headers.set("Cache-Control", "no-store");
  const name = ctx.request.url.searchParams.get("name") || "";
  // מרשים לקרוא רק קבצים ספציפיים לבטיחות
  const allow: Record<string, string> = {
    "routes/auth.ts": `${Deno.cwd()}/routes/auth.ts`,
    "routes/restaurants.ts": `${Deno.cwd()}/routes/restaurants.ts`,
    "routes/owner.ts": `${Deno.cwd()}/routes/owner.ts`,
    "server.ts": `${Deno.cwd()}/server.ts`,
  };
  const path = allow[name];
  if (!path) {
    ctx.response.status = 400;
    ctx.response.body = "bad or disallowed name";
    return;
  }
  try {
    const txt = await Deno.readTextFile(path);
    ctx.response.type = "text";
    ctx.response.body = txt;
  } catch (e) {
    ctx.response.status = 404;
    ctx.response.body = `not found: ${path} (${String(e?.message ?? e)})`;
  }
});

// ודא שהוספת את הראוטר הזה לאפליקציה:
app.use(dbg2.routes());
app.use(dbg2.allowedMethods());
