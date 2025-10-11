// src/routes/restaurants/_utils/body.ts
import { debugLog } from "../../../lib/debug.ts";
import { normalizeDate, normalizeTime, pickNonEmpty } from "./datetime.ts";

function lcContentType(ctx: any): string {
  return (ctx.request.headers.get("content-type") ?? "").toLowerCase();
}

function pickNativeRequest(reqAny: any): any | null {
  const cands = [
    reqAny?.originalRequest,
    reqAny?.request,
    reqAny?.raw,
    reqAny,
  ];
  for (const c of cands) {
    if (!c) continue;
    if (typeof c === "object" && (typeof c.formData === "function" || typeof c.json === "function" || typeof c.text === "function")) {
      return c;
    }
  }
  return null;
}

export async function readBody(ctx: any): Promise<{ payload: Record<string, unknown>; dbg: Record<string, unknown> }> {
  const dbg: Record<string, unknown> = { ct: lcContentType(ctx), phases: [] as any[] };
  const phase = (name: string, data?: unknown) => { try { (dbg.phases as any[]).push({ name, data }); } catch {} };

  const out: Record<string, unknown> = {};
  const merge = (dst: Record<string, unknown>, src: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(src)) if (v !== undefined && v !== null && v !== "") dst[k] = v;
    return dst;
  };
  const fromEntries = (iter: Iterable<[string, FormDataEntryValue]> | URLSearchParams) => {
    const o: Record<string, unknown> = {};
    for (const [k, v0] of (iter as any).entries()) {
      const v = typeof v0 === "string" ? v0 : (v0?.name ?? "");
      o[k] = v;
    }
    return o;
  };

  try {
    const native = pickNativeRequest((ctx as any).request);
    if (native) {
      phase("native.detected", Object.keys(native));
      const ct = dbg.ct;

      const useForm = /\bmultipart\/form-data\b/.test(ct);
      const useUrlEnc = /\bapplication\/x-www-form-urlencoded\b/.test(ct);
      const useJson = /\bapplication\/json\b/.test(ct);

      if (useJson && typeof native.json === "function") {
        try {
          const j = await native.json();
          if (j && typeof j === "object") { phase("native.json", j); merge(out, j); }
        } catch (e) { phase("native.json.error", String(e)); }
      } else if (useForm && typeof native.formData === "function") {
        try {
          const fd = await native.formData();
          const o = fromEntries(fd);
          phase("native.formData", o);
          merge(out, o);
        } catch (e) { phase("native.formData.error", String(e)); }
      } else if (useUrlEnc && typeof native.text === "function") {
        try {
          const t = await native.text();
          phase("native.text(urlencoded)", t.length > 200 ? t.slice(0,200)+"…" : t);
          const sp = new URLSearchParams(t);
          const o = fromEntries(sp);
          merge(out, o);
        } catch (e) { phase("native.text.urlencoded.error", String(e)); }
      } else if (typeof native.text === "function") {
        try {
          const t = await native.text();
          phase("native.text", t.length > 200 ? t.slice(0,200)+"…" : t);
          try { const j = JSON.parse(t); phase("native.text->json", j); merge(out, j as any); }
          catch {
            const sp = new URLSearchParams(t);
            const o = fromEntries(sp);
            if (Object.keys(o).length) { phase("native.text->urlencoded", o); merge(out, o); }
          }
        } catch (e) { phase("native.text.error", String(e)); }
      }
    } else {
      phase("native.missing", "no suitable Request with formData/json/text");
    }
  } catch (e) {
    phase("native.fatal", String(e));
  }

  if (Object.keys(out).length === 0) {
    async function tryOak(kind: "form" | "form-data" | "json" | "text" | "bytes") {
      try {
        const bodyFn = (ctx.request as any).body;
        if (typeof bodyFn !== "function") {
          phase(`oak.body(${kind}).skip`, "ctx.request.body is not a function");
          return;
        }
        const b = await bodyFn.call(ctx.request, { type: kind });
        if (!b) return;
        const t = b.type;
        if (t === "form") {
          const v = await b.value as URLSearchParams;
          const o = fromEntries(v);
          phase("oak.body(form)", o);
          merge(out, o);
        } else if (t === "form-data") {
          const v = await b.value;
          const r = await v.read();
          const o = (r?.fields ?? {}) as Record<string, unknown>;
          phase("oak.body(form-data)", o);
          merge(out, o);
        } else if (t === "json") {
          const j = await b.value as Record<string, unknown>;
          phase("oak.body(json)", j);
          merge(out, j || {});
        } else if (t === "text") {
          const txt = await b.value as string;
          phase("oak.body(text)", txt.length > 200 ? txt.slice(0,200)+"…" : txt);
          try { const j = JSON.parse(txt); phase("oak.body(text->json)", j); merge(out, j as any); }
          catch {
            const sp = new URLSearchParams(txt);
            const o = fromEntries(sp);
            if (Object.keys(o).length) { phase("oak.body(text->urlencoded)", o); merge(out, o); }
          }
        } else if (t === "bytes") {
          const u8 = await b.value as Uint8Array;
          const txt = new TextDecoder().decode(u8);
          phase("oak.body(bytes)", txt.length > 200 ? txt.slice(0,200)+"…" : txt);
          try { const j = JSON.parse(txt); phase("oak.body(bytes->json)", j); merge(out, j as any); }
          catch {
            const sp = new URLSearchParams(txt);
            const o = fromEntries(sp);
            if (Object.keys(o).length) { phase("oak.body(bytes->urlencoded)", o); merge(out, o); }
          }
        }
      } catch (e) {
        phase(`oak.body(${kind}).error`, String(e));
      }
    }

    await tryOak("json");
    if (Object.keys(out).length === 0) await tryOak("form");
    if (Object.keys(out).length === 0) await tryOak("form-data");
    if (Object.keys(out).length === 0) await tryOak("text");
    if (Object.keys(out).length === 0) await tryOak("bytes");
  } else {
    phase("oak.compat.skip", "already read via native request");
  }

  const qs = Object.fromEntries(ctx.request.url.searchParams);
  phase("querystring", qs);
  for (const [k, v] of Object.entries(qs)) {
    if ((out as any)[k] === undefined || (out as any)[k] === null || (out as any)[k] === "") (out as any)[k] = v;
  }

  phase("keys", Object.keys(out));
  return { payload: out, dbg };
}

export function extractFromReferer(ctx: any) {
  const ref = ctx.request.headers.get("referer") || ctx.request.headers.get("referrer") || "";
  try {
    const u = new URL(ref);
    return Object.fromEntries(u.searchParams);
  } catch { return {}; }
}

export function extractDateAndTime(ctx: any, payload: Record<string, unknown>) {
  const qs = ctx.request.url.searchParams;
  const ref = extractFromReferer(ctx);

  const rawDate = pickNonEmpty(
    (payload as any)["date"], (payload as any)["reservation_date"], (payload as any)["res_date"],
    qs.get("date"), qs.get("reservation_date"), qs.get("res_date"),
    (payload as any)["datetime"], (payload as any)["datetime_local"], (payload as any)["datetime-local"],
    qs.get("datetime"), qs.get("datetime_local"), qs.get("datetime-local"),
    (ref as any)["date"], (ref as any)["reservation_date"], (ref as any)["res_date"],
    (ref as any)["datetime"], (ref as any)["datetime_local"], (ref as any)["datetime-local"]
  );

  const hhmmFromHM = (() => {
    const h = pickNonEmpty((payload as any)["hour"], qs.get("hour"), (ref as any)["hour"]);
    const m = pickNonEmpty((payload as any)["minute"], qs.get("minute"), (ref as any)["minute"]);
    return h && m ? `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}` : "";
  })();

  const rawTime = pickNonEmpty(
    (payload as any)["time"], qs.get("time"), (ref as any)["time"],
    (payload as any)["time_display"], (payload as any)["timeDisplay"],
    qs.get("time_display"), qs.get("timeDisplay"),
    (ref as any)["time_display"], (ref as any)["timeDisplay"],
    hhmmFromHM,
    (payload as any)["datetime"], (payload as any)["datetime_local"], (payload as any)["datetime-local"],
    qs.get("datetime"), qs.get("datetime_local"), qs.get("datetime-local"),
    (ref as any)["datetime"], (ref as any)["datetime_local"], (ref as any)["datetime-local"]
  );

  const date = normalizeDate(rawDate);
  const time = normalizeTime(rawTime);

  debugLog("[restaurants] extractDateAndTime", {
    from_payload: { date: (payload as any)["date"], time: (payload as any)["time"], time_display: (payload as any)["time_display"] },
    from_qs: { date: qs.get("date"), time: qs.get("time") },
    from_ref: { date: (ref as any)["date"], time: (ref as any)["time"] },
    rawDate, rawTime,
    normalized: { date, time }
  });

  return { date, time };
}
