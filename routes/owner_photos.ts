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
const MIME_RE = /^image\/(png|jpeg|webp)$/i;

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

  // נוודא שהפורמט תמיד אחיד בתצוגה
  const normalized = normalizePhotos(r.photos);
  if (normalized.length !== ensureArray(r.photos).length) {
    // אם יש הבדל (למשל היו מחרוזות), נשמור חזרה בפורמט התקני — שקט.
    await updateRestaurant(id, { photos: normalized } as any).catch(() => {});
  }

  const saved = ctx.request.url.searchParams.get("saved") === "1";
  await render(ctx, "owner_photos.eta", {
    title: `תמונות — ${r.name}`,
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
    ((ctx.request as any)?.request?.headers?.get?.("content-type") ?? "") ||
    ((ctx.request as any)?.originalRequest?.headers?.get?.("content-type") ?? "");

  if (!MIME_RE.test(contentType || "")) {
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

  if (bytes.length > MAX_BYTES) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body =
      "התמונה גדולה מדי לשמירה ב-DB הנוכחי. הקטינו/כווצו צד-לקוח (נסו שוב), או עברו לאחסון קבצים חיצוני.";
    return;
  }

  try {
    const pid = crypto.randomUUID();
    let photoUrl: string;

    // Use R2 if configured, otherwise fallback to base64
    if (R2_ENABLED) {
      // Upload to Cloudflare R2 (unlimited size!)
      const path = generatePhotoPath(id, pid, contentType);
      photoUrl = await uploadImageToR2(bytes, contentType, path);
      debugLog(`[photos] ✅ Uploaded to R2: ${photoUrl}`);
    } else {
      // Fallback: base64 in KV (limited to 60 KB)
      const base64 = bytesToBase64(bytes);
      const dataUrl = `data:${contentType};base64,${base64}`;

      if (dataUrl.length > MAX_DATAURL_LENGTH) {
        ctx.response.status = Status.BadRequest;
        ctx.response.body =
          "התמונה עדיין גדולה מדי לשמירה. נסו תמונה קטנה יותר/מכווצת, או הגדירו Cloudflare R2 ב-.env";
        return;
      }

      photoUrl = dataUrl;
      debugLog(`[photos] ✅ Using base64 fallback (${dataUrl.length} bytes)`);
    }

    const newPhoto: PhotoItem = { id: pid, dataUrl: photoUrl };
    const prev = normalizePhotos(r.photos);
    const next = [...prev, newPhoto];

    await updateRestaurant(id, { photos: next } as any);

    ctx.response.status = Status.OK;
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify({
      ok: true,
      added: 1,
      total: next.length,
      id: pid,
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
