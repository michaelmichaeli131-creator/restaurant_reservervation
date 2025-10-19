import { Router } from "jsr:@oak/oak";

const router = new Router();

router.get("/lang/:code", (ctx) => {
  const code = (ctx.params.code || "").toLowerCase();
  const back = ctx.request.headers.get("referer") || "/";
  if (!["he", "en", "ka"].includes(code)) return ctx.response.redirect(back);

  ctx.cookies.set("sb_lang", code, {
    httpOnly: false,
    sameSite: "Lax",
    secure: true,
    path: "/",
    maxAge: 60 * 60 * 24 * 180
  });

  ctx.response.redirect(back);
});

export default router;
