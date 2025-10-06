// src/routes/owner_photos.ts
// ניהול תמונות מסעדה — בעלים בלבד
// קריאת JSON עמידה (Oak 11–17+): נסיונות מרובים כולל Web Request clone().text()

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { getRestaurant, updateRestaurant } from "../database.ts";
import { requireOwner } from "../lib/auth.ts";
import { debugLog } from "../lib/debug.ts";

type PhotoItem = { id: string; dataUrl: string; alt?: string };

// ---- JSON reader hardened ----
async function readJsonSafe(ctx: any): Promise<any | null> {
  // לוג על סוג התוכן כדי לעזור בדיבאג
  try {
    const ct = ctx.request?.headers?.get?.("content-type") || "";
    debugLog("[photos][readJsonSafe] content-type:", ct);
  } catch {}

  // 1) Web Request תקני: clone().text() ואז JSON.parse
  try {
    const req =
      (ctx.request as any)?.request ??
      (ctx.request as any)?.originalRequest ??
      (ctx as any)?.request ??
      null;

    if (req && typeof req.clone === "function" && typeof req.text === "function") {
      const text = await req.clone().text();
      if (text && text.trim().length) {
        const data = JSON.parse(text);
        if (data && typeof data === "object") return data;
      }
    }
  } catch (e) {
    debugLog("[photos] req.clone().text() parse failed", String(e));
  }

  // 2) Oak קלאסי: body({ type: "json" })
  try {
    if (typeof ctx.request?.body === "function") {
      const b = ctx.request.body({ type: "json" });
      const v = await b.value;
      if (v && typeof v === "object") return v;
    }
  } catch (e) {
    debugLog("[photos] body({json}) failed", String(e));
  }

  // 3) Oak bytes -> טקסט -> JSON
  try {
    if (typeof ctx.request?.body === "function") {
      const b2 = ctx.request.body({ type: "bytes" });
      const bytes: Uint8Array = await b2.value;
      if (bytes && bytes.length) {
        const text = new TextDecoder().decode(bytes);
        if (text && text.trim().length) {
          const v = JSON.parse(text);
          if (v && typeof v === "object") return v;
        }
      }
    }
  } catch (e) {
    debugLog("[photos] body({bytes}) parse failed", String(e));
  }

  // 4) ניסיון ישיר: originalRequest.json (אם קיים)
  try {
    const req =
      (ctx.request as any)?.originalRequest ??
      (ctx.request as any)?.request ??
      null;
    if (req && typeof req.json === "function") {
      const v = await req.json();
      if (v && typeof v === "object") return v;
    }
  } catch (e) {
    debugLog("[photos] originalRequest.json failed", String(e));
  }

  return null;
}

const ownerPhotosRouter = new Router();

// GET: מסך ניהול תמונות
ownerPhotosRouter.get("/owner/restaurants/:id/photos", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const id = ctx.params.id!;
  const r = await getRestaurant(id);

  if (!r || r.ownerId !== (ctx.state as any)?.user?.id) {
    ctx.response.status = Status.NotFound;
    await render(ctx, "error", { title: "לא נמצא", message: "מסעדה לא נמצאה או שאין הרשאה." });
    return;
  }

  const saved = ctx.request.url.searchParams.get("saved") === "1";
  await render(ctx, "owner_photos.eta", {
    title: `תמונות — ${r.name}`,
    page: "owner_photos",
    restaurant: r,
    saved,
  });
});

// POST (JSON): העלאת תמונות כ-dataURL
// payload: { images: Array<{ dataUrl: string, alt?: string }> }
ownerPhotosRouter.post("/owner/restaurants/:id/photos/upload", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const id = ctx.params.id!;
  const r = await getRestaurant(id);

  if (!r || r.ownerId !== (ctx.state as any)?.user?.id) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "מסעדה לא נמצאה או אין הרשאה.";
    return;
  }

  const data = await readJsonSafe(ctx);
  if (!data) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "Invalid JSON";
    return;
  }

  const images = Array.isArray(data?.images) ? data.images : [];
  if (!images.length) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "no images";
    return;
  }

  // ולידציה בסיסית + מגבלות
  const MAX_FILES = 12;
  // ~1.8MB raw -> base64 ~1.33x-1.6x; נשאיר מרווח סביר
  const MAX_DATAURL_LEN = Math.floor(1.8 * 1024 * 1024 * 1.6);

  const out: PhotoItem[] = [];
  for (const item of images.slice(0, MAX_FILES)) {
    const dataUrl = String(item?.dataUrl ?? "");
    const alt = typeof item?.alt === "string" ? item.alt.slice(0, 140) : undefined;

    if (!/^data:image\/(png|jpe?g|webp);base64,/.test(dataUrl)) continue;
    if (dataUrl.length > MAX_DATAURL_LEN) continue;

    const idPart = Math.random().toString(36).slice(2, 10);
    out.push({ id: `${Date.now()}-${idPart}`, dataUrl, alt });
  }

  if (!out.length) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "no valid images";
    return;
  }

  const prev = Array.isArray(r.photos) ? r.photos : [];
  const nextPhotos = [...prev, ...out];

  await updateRestaurant(id, { photos: nextPhotos } as any);

  ctx.response.status = Status.OK;
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = JSON.stringify({ ok: true, added: out.length, total: nextPhotos.length });
});

// POST (JSON): מחיקת תמונה לפי id
// payload: { id: string }
ownerPhotosRouter.post("/owner/restaurants/:id/photos/delete", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const id = ctx.params.id!;
  const r = await getRestaurant(id);

  if (!r || r.ownerId !== (ctx.state as any)?.user?.id) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "מסעדה לא נמצאה או אין הרשאה.";
    return;
  }

  const data = await readJsonSafe(ctx);
  if (!data) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "Invalid JSON";
    return;
  }

  const pid = String(data?.id ?? "");
  if (!pid) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "missing id";
    return;
  }

  const prev = Array.isArray(r.photos) ? r.photos : [];
  const nextPhotos = prev.filter((p: PhotoItem) => p.id !== pid);

  await updateRestaurant(id, { photos: nextPhotos } as any);

  ctx.response.status = Status.OK;
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = JSON.stringify({ ok: true, removed: pid, total: nextPhotos.length });
});

export default ownerPhotosRouter;
export { ownerPhotosRouter };
