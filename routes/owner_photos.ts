// src/routes/owner_photos.ts
// העלאת תמונות פשוטה — קובץ אחד בכל בקשה (binary body, ללא JSON וללא multipart)

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { getRestaurant, updateRestaurant } from "../database.ts";
import { requireOwner } from "../lib/auth.ts";
import { debugLog } from "../lib/debug.ts";
import { encodeBase64 } from "jsr:@std/encoding/base64"; // ✅ שימוש נכון

type PhotoItem = { id: string; dataUrl: string; alt?: string };

const ownerPhotosRouter = new Router();

/** קורא את גוף הבקשה כ-Uint8Array — תומך בגרסאות Oak שונות */
async function readBodyBytes(ctx: any): Promise<Uint8Array | null> {
  try {
    const webReq: any =
      (ctx.request && (ctx.request as any).request) ??
      (ctx.request && (ctx.request as any).originalRequest) ??
      null;

    if (webReq) {
      if (typeof webReq.arrayBuffer === "function") {
        const ab = await webReq.arrayBuffer();
        return new Uint8Array(ab);
      }
      if (webReq.body) {
        const ab = await new Response(webReq.body).arrayBuffer();
        return new Uint8Array(ab);
      }
    }

    if (ctx.request && typeof (ctx.request as any).body === "function") {
      try {
        const b = (ctx.request as any).body({ type: "bytes" });
        const bytes: Uint8Array = await b.value;
        if (bytes && bytes.length) return bytes;
      } catch (e) {
        debugLog("[photos][readBodyBytes] legacy body({bytes}) failed:", String(e));
      }
      try {
        const b2 = (ctx.request as any).body({ type: "stream" });
        const rs: ReadableStream | undefined = await b2.value;
        if (rs) {
          const ab = await new Response(rs).arrayBuffer();
          return new Uint8Array(ab);
        }
      } catch (e) {
        debugLog("[photos][readBodyBytes] legacy body({stream}) failed:", String(e));
      }
    }
  } catch (e) {
    debugLog("[photos][readBodyBytes] failed:", String(e));
  }
  return null;
}

// ---------------- GET: דף התמונות ----------------
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

// ---------------- POST: העלאת תמונה (binary body) ----------------
ownerPhotosRouter.post("/owner/restaurants/:id/photos/upload", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  if (!r || r.ownerId !== (ctx.state as any)?.user?.id) {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = "אין הרשאה למסעדה זו.";
    return;
  }

  const contentType =
    ctx.request.headers.get("content-type") ||
    ((ctx.request as any)?.request?.headers?.get?.("content-type") ?? "");

  if (!/^image\/(png|jpeg|webp)$/.test(contentType)) {
    debugLog("[photos][upload] unsupported content-type:", contentType);
    ctx.response.status = Status.UnsupportedMediaType;
    ctx.response.body = "Unsupported image format. Use PNG/JPEG/WebP.";
    return;
  }

  const bytes = await readBodyBytes(ctx);
  if (!bytes || !bytes.length) {
    debugLog("[photos][upload] no bytes read");
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "Empty image body.";
    return;
  }

  // הגדלת מגבלת גודל תמונה (למשל 20MB)
  const MAX_BYTES = 20 * 1024 * 1024;
  if (bytes.length > MAX_BYTES) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = `Image too large (max ${(MAX_BYTES / (1024 * 1024)).toFixed(0)}MB).`;
    return;
  }

  try {
    const base64 = encodeBase64(bytes); // ✅ שימוש תקין
    const dataUrl = `data:${contentType};base64,${base64}`;

    const pid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const newPhoto: PhotoItem = { id: pid, dataUrl };

    const prev = Array.isArray(r.photos) ? r.photos : [];
    const next = [...prev, newPhoto];

    await updateRestaurant(id, { photos: next } as any);

    ctx.response.status = Status.OK;
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify({ ok: true, added: 1, total: next.length });
  } catch (e) {
    debugLog("[photos][upload] base64 encode/save failed:", String(e));
    ctx.response.status = Status.InternalServerError;
    ctx.response.body = "Failed processing image.";
  }
});

// ---------------- POST: מחיקת תמונה ----------------
ownerPhotosRouter.post("/owner/restaurants/:id/photos/delete", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  if (!r || r.ownerId !== (ctx.state as any)?.user?.id) {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = "אין הרשאה למסעדה זו.";
    return;
  }

  let payload: any = null;
  try {
    const webReq: any =
      (ctx.request && (ctx.request as any).request) ??
      (ctx.request && (ctx.request as any).originalRequest) ??
      null;
    const raw = webReq && typeof webReq.text === "function"
      ? await webReq.text()
      : await new Response(webReq?.body ?? null).text();
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = null;
  }

  const pid = String(payload?.id ?? "");
  if (!pid) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "missing id";
    return;
  }

  const prev = Array.isArray(r.photos) ? r.photos : [];
  const next = prev.filter((p: PhotoItem) => p.id !== pid);

  await updateRestaurant(id, { photos: next } as any);

  ctx.response.status = Status.OK;
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = JSON.stringify({ ok: true, removed: pid, total: next.length });
});

export default ownerPhotosRouter;
export { ownerPhotosRouter };
