// src/routes/owner_photos.ts
// העלאת תמונות: עם Cloudflare R2 (unlimited size) או fallback ל-base64 (60KB)

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { getRestaurant, updateRestaurant } from "../database.ts";
import { requireOwner } from "../lib/auth.ts";
import { debugLog } from "../lib/debug.ts";
import { R2_ENABLED, uploadImageToR2, deleteImageFromR2, generatePhotoPath, extractPathFromUrl } from "../lib/r2.ts";

type PhotoItem = { id: string; dataUrl: string; alt?: string };

const ownerPhotosRouter = new Router();

/** עזר: הבטחת מערך */
function ensureArray<T = unknown>(v: unknown, fallback: T[] = []): T[] {
  return Array.isArray(v) ? (v as T[]) : fallback;
}

/** נרמול פורמט התמונות לכלל {id, dataUrl, alt?} (תאימות לאחור) */
function normalizePhotos(list: unknown): PhotoItem[] {
  const arr = ensureArray(list);
  const out: PhotoItem[] = [];
  for (const item of arr) {
    if (!item) continue;
    if (typeof item === "string") {
      out.push({ id: crypto.randomUUID(), dataUrl: String(item) });
    } else if (typeof item === "object") {
      const o = item as any;
      const id = String(o.id ?? crypto.randomUUID());
      const dataUrl = String(o.dataUrl ?? o.url ?? "");
      const alt = o.alt ? String(o.alt) : undefined;
      if (!dataUrl) continue;
      out.push({ id, dataUrl, alt });
    }
  }
  return out;
}

/** קריאת גוף בקשה לבייטים (תואם Oak חדשים וישנים) */
async function readBodyBytes(ctx: any): Promise<Uint8Array | null> {
  try {
    const webReq: any =
      (ctx.request && (ctx.request as any).request) ??
      (ctx.request && (ctx.request as any).originalRequest) ?? null;

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
      } catch (e) { debugLog("[photos][readBodyBytes] legacy bytes failed:", String(e)); }
      try {
        const b2 = (ctx.request as any).body({ type: "stream" });
        const rs: ReadableStream | undefined = await b2.value;
        if (rs) {
          const ab = await new Response(rs).arrayBuffer();
          return new Uint8Array(ab);
        }
      } catch (e) { debugLog("[photos][readBodyBytes] legacy stream failed:", String(e)); }
    }
  } catch (e) {
    debugLog("[photos][readBodyBytes] failed:", String(e));
  }
  return null;
}

/** Base64 encoder ללא apply/fromCharCode — עובד לכל גודל (אבל KV מגביל) */
function bytesToBase64(u8: Uint8Array): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  let i = 0;
  const len = u8.length;

  for (; i + 2 < len; i += 3) {
    const n = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2];
    out +=
      chars[(n >> 18) & 63] +
      chars[(n >> 12) & 63] +
      chars[(n >> 6) & 63] +
      chars[n & 63];
  }

  if (i < len) {
    const rem = len - i;
    if (rem === 1) {
      const n = u8[i] << 16;
      out += chars[(n >> 18) & 63] + chars[(n >> 12) & 63] + "==";
    } else {
      const n = (u8[i] << 16) | (u8[i + 1] << 8);
      out +=
        chars[(n >> 18) & 63] +
        chars[(n >> 12) & 63] +
        chars[(n >> 6) & 63] +
        "=";
    }
  }
  return out;
}

/** קבועים ללוגיקת גודל/סוג */
const MAX_DATAURL_LENGTH = 60 * 1024; // ~60KB כולל prefix (KV value budget)
const MAX_BYTES = 10 * 1024 * 1024;   // 10MB max upload (R2 supports much more, but reasonable web limit)
const MIME_RE = /^image\/(png|jpeg|webp)/i;  // No $ anchor - allows params like ;charset=...

/** Detect image MIME type from magic bytes (fallback when header is missing) */
function detectMimeFromBytes(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
    return "image/png";
  }

  // JPEG: FF D8 FF
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    return "image/jpeg";
  }

  // WebP: RIFF....WEBP
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return "image/webp";
  }

  return null;
}

// ---------------- GET: דף התמונות ----------------
ownerPhotosRouter.get("/owner/restaurants/:id/photos", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const id = ctx.params.id!;
  const r = await getRestaurant(id);

  if (!r || r.ownerId !== (ctx.state as any)?.user?.id) {
    const t = (ctx.state as any)?.t ?? ((_: string, fb?: string) => fb ?? _);
    ctx.response.status = Status.NotFound;
    await render(ctx, "error", {
      title: t("common.not_found", "Not found"),
      message: t("owner.photos.not_found", "Restaurant not found or access denied."),
    });
    return;
  }

  // נוודא שהפורמט תמיד אחיד בתצוגה
  const normalized = normalizePhotos(r.photos);
  if (normalized.length !== ensureArray(r.photos).length) {
    // אם יש הבדל (למשל היו מחרוזות), נשמור חזרה בפורמט התקני — שקט.
    await updateRestaurant(id, { photos: normalized } as any).catch(() => {});
  }

  const saved = ctx.request.url.searchParams.get("saved") === "1";
  const t = (ctx.state as any)?.t ?? ((_: string, fb?: string) => fb ?? _);
  await render(ctx, "owner_photos.eta", {
    title: `${t("owner.photos.title", "Photos")} — ${r.name}`,
    page: "owner_photos",
    restaurant: { ...r, photos: normalized },
    saved,
  });
});

// ---------------- (אופציונלי) GET JSON: לקבלת גלריה בצורה אחידה ----------------
ownerPhotosRouter.get("/owner/restaurants/:id/photos.json", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  if (!r || r.ownerId !== (ctx.state as any)?.user?.id) {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = { ok: false, error: "forbidden" };
    return;
  }
  const normalized = normalizePhotos(r.photos);
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = JSON.stringify({ ok: true, photos: normalized });
});

/** Helper: decode base64 to Uint8Array */
function base64ToBytes(base64: string): Uint8Array {
  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return bytes;
}

/** Helper: process a single image (binary or base64) and upload to R2 or store as dataUrl */
async function processAndStoreImage(
  restaurantId: string,
  imageBytes: Uint8Array,
  contentType: string,
): Promise<PhotoItem> {
  const pid = crypto.randomUUID();
  let photoUrl: string;

  if (R2_ENABLED) {
    const path = generatePhotoPath(restaurantId, pid, contentType);
    photoUrl = await uploadImageToR2(imageBytes, contentType, path);
    debugLog(`[photos] ✅ Uploaded to R2: ${photoUrl}`);
  } else {
    const base64 = bytesToBase64(imageBytes);
    photoUrl = `data:${contentType};base64,${base64}`;
    debugLog(`[photos] ✅ Using base64 fallback (${photoUrl.length} bytes)`);
  }

  return { id: pid, dataUrl: photoUrl };
}

// ---------------- POST: העלאת תמונה (binary OR JSON with base64) ----------------
ownerPhotosRouter.post("/owner/restaurants/:id/photos/upload", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  if (!r || r.ownerId !== (ctx.state as any)?.user?.id) {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = "אין הרשאה למסעדה זו.";
    return;
  }

  // Check content-type to determine format
  const headerContentType =
    ctx.request.headers.get("content-type") ||
    ((ctx.request as any)?.request?.headers?.get?.("content-type") ?? "") ||
    ((ctx.request as any)?.originalRequest?.headers?.get?.("content-type") ?? "");

  debugLog("[photos][upload] header content-type:", headerContentType);

  // === JSON FORMAT (from edit page - base64 images in JSON) ===
  if (headerContentType.includes("application/json")) {
    debugLog("[photos][upload] processing as JSON with base64 images");

    try {
      const bytes = await readBodyBytes(ctx);
      if (!bytes || !bytes.length) {
        ctx.response.status = Status.BadRequest;
        ctx.response.body = "Empty request body.";
        return;
      }

      const bodyText = new TextDecoder().decode(bytes);
      const payload = JSON.parse(bodyText);
      const images = Array.isArray(payload.images) ? payload.images : [];

      if (!images.length) {
        ctx.response.status = Status.BadRequest;
        ctx.response.body = "No images provided.";
        return;
      }

      const prev = normalizePhotos(r.photos);
      const newPhotos: PhotoItem[] = [];

      for (const img of images) {
        const dataUrl = typeof img === "string" ? img : img?.dataUrl;
        if (!dataUrl || !dataUrl.startsWith("data:image/")) continue;

        // Parse data URL: data:image/png;base64,XXXX
        const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
        if (!match) continue;

        const mimeType = match[1];
        const base64Data = match[2];

        if (!MIME_RE.test(mimeType)) {
          debugLog("[photos][upload] skipping unsupported mime:", mimeType);
          continue;
        }

        const imageBytes = base64ToBytes(base64Data);
        if (imageBytes.length > MAX_BYTES) {
          debugLog("[photos][upload] skipping oversized image:", imageBytes.length);
          continue;
        }

        const photo = await processAndStoreImage(id, imageBytes, mimeType);
        newPhotos.push(photo);
      }

      if (!newPhotos.length) {
        ctx.response.status = Status.BadRequest;
        ctx.response.body = "No valid images to upload.";
        return;
      }

      const next = [...prev, ...newPhotos];
      await updateRestaurant(id, { photos: next } as any);

      ctx.response.status = Status.OK;
      ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
      ctx.response.body = JSON.stringify({
        ok: true,
        added: newPhotos.length,
        total: next.length,
        r2: R2_ENABLED
      });
      return;

    } catch (e) {
      debugLog("[photos][upload] JSON processing failed:", String(e));
      ctx.response.status = Status.BadRequest;
      ctx.response.body = "Invalid JSON payload.";
      return;
    }
  }

  // === BINARY FORMAT (from photos page - raw image bytes) ===
  debugLog("[photos][upload] processing as binary image");

  const bytes = await readBodyBytes(ctx);
  if (!bytes || !bytes.length) {
    debugLog("[photos][upload] no bytes read");
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "Empty image body.";
    return;
  }

  if (bytes.length > MAX_BYTES) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body =
      "התמונה גדולה מדי לשמירה ב-DB הנוכחי. הקטינו/כווצו צד-לקוח (נסו שוב), או עברו לאחסון קבצים חיצוני.";
    return;
  }

  // Try to get content-type, fallback to magic byte detection
  let contentType = headerContentType;
  if (!MIME_RE.test(contentType || "")) {
    const detected = detectMimeFromBytes(bytes);
    debugLog("[photos][upload] detected from bytes:", detected);
    if (detected) {
      contentType = detected;
    }
  }

  if (!MIME_RE.test(contentType || "")) {
    debugLog("[photos][upload] unsupported content-type after fallback:", contentType);
    ctx.response.status = Status.UnsupportedMediaType;
    ctx.response.body = "Unsupported image format. Use PNG/JPEG/WebP.";
    return;
  }

  try {
    const newPhoto = await processAndStoreImage(id, bytes, contentType);
    const prev = normalizePhotos(r.photos);
    const next = [...prev, newPhoto];

    await updateRestaurant(id, { photos: next } as any);

    ctx.response.status = Status.OK;
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify({
      ok: true,
      added: 1,
      total: next.length,
      id: newPhoto.id,
      r2: R2_ENABLED
    });
  } catch (e) {
    debugLog("[photos][upload] failed:", String(e));
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
      (ctx.request && (ctx.request as any).originalRequest) ?? null;

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

  const prev = normalizePhotos(r.photos);
  const photoToDelete = prev.find((p: PhotoItem) => p.id === pid);
  const next = prev.filter((p: PhotoItem) => p.id !== pid);

  if (next.length === prev.length) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = JSON.stringify({ ok: false, error: "not_found" });
    return;
  }

  // If photo is in R2 (not base64), delete from R2
  if (R2_ENABLED && photoToDelete && photoToDelete.dataUrl.startsWith("https://")) {
    try {
      const r2Path = extractPathFromUrl(photoToDelete.dataUrl);
      if (r2Path) {
        await deleteImageFromR2(r2Path);
        debugLog(`[photos] 🗑️ Deleted from R2: ${r2Path}`);
      }
    } catch (e) {
      debugLog(`[photos] ⚠️ R2 delete failed (continuing anyway):`, String(e));
      // Continue even if R2 delete fails - remove from DB
    }
  }

  await updateRestaurant(id, { photos: next } as any);

  ctx.response.status = Status.OK;
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = JSON.stringify({ ok: true, removed: pid, total: next.length });
});

export default ownerPhotosRouter;
export { ownerPhotosRouter };
