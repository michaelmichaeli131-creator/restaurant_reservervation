// src/lib/log_mw.ts
import { dlog } from "./debug.ts";
import { Status } from "jsr:@oak/oak";

export function requestLogger() {
  return async (ctx: any, next: () => Promise<unknown>) => {
    const t0 = Date.now();
    const req = ctx.request;
    const headers: Record<string,string> = {};
    try {
      for (const [k,v] of req.headers.entries()) headers[k] = v;
    } catch {}

    dlog("req", "incoming", {
      method: req.method,
      url: req.url?.toString?.() || "",
      ip: ctx.request.ip ?? ctx.state?.ip ?? undefined,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      serverNowISO: new Date().toISOString(),
      headers,
    });

    try {
      await next();
    } finally {
      const ms = Date.now() - t0;
      const res = ctx.response;
      dlog("req", "outgoing", {
        status: res.status ?? Status.OK,
        ms,
        type: res.type,
      });
    }
  };
}
