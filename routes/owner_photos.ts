// src/routes/owner_photos.ts
// העלאת תמונות פשוטה — קובץ אחד בכל בקשה (binary body, ללא JSON וללא multipart)

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { getRestaurant, updateRestaurant } from "../database.ts";
import { requireOwner } from "../lib/auth.ts";
import { debugLog } from "../lib/debug.ts";

type PhotoItem = { id: string; dataUrl: string; alt?: string };

const ownerPhotosRouter = new Router();

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

  // Oak 17+: אין ctx.request.body() לפענוח גופים בינאריים.
  // קוראים את ה-Web Request הגולמי ומוציאים ממנו arrayBuffer().
  let webReq: Request | null = null;
  try {
    webReq =
      ((ctx.request as any).request as Request | undefined) ??
      ((ctx.request as any).originalRequest as Request | undefined) ??
      null;
  } catch {
    webReq = null;
  }

  if (!webReq) {
    debugLog("[photos][upload] no web Request on ctx.request");
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "Invalid request.";
    return;
  }

  const contentType =
    webReq.headers.get("content-type") ??
    ctx.request.headers.get("content-type") ??
    "";

  if (!/^image\/(png|jpeg|webp)$/.test(contentType)) {
    debugLog("[photos][upload] unsupported content-type:", contentType);
    ctx.response.status = Status.UnsupportedMediaType; // 415
    ctx.response.body = "Unsupported image format. Use PNG/JPEG/WebP.";
    return;
  }

  let bytes: Uint8Array | null = null;
  try {
    const ab = await webReq.arrayBuffer();
    bytes = new Uint8Array(ab);
    debugLog("[photos][upload] received bytes:", bytes.length, "type:", contentType);
  } catch (e) {
    debugLog("[photos][upload] arrayBuffer() failed:", String(e));
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "Failed reading image body.";
    return;
  }

  if (!bytes || !bytes.length) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "Empty image body.";
    return;
  }

  // הגבלת גודל (למשל 2MB)
  const MAX_BYTES = 2 * 1024 * 1024;
  if (bytes.length > MAX_BYTES) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "Image too large (max 2MB).";
    return;
  }

  // המרה ל-base64 לשמירה בדאטה-URL (DB)
  // הערה: לשמירה יעילה/זולה יותר עדיף אחסון חיצוני (S3/GCS) ושמירת URL בלבד.
  let base64: string;
  try {
    // המרה מהירה של Uint8Array ל-base64
    // זה בטוח לקבצים עד כמה MB בודדים.
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, Array.from(chunk));
    }
    // deno-lint-ignore no-deprecated-deno-api
    base64 = btoa(binary);
  } catch (e) {
    debugLog("[photos][upload] base64 encode failed:", String(e));
    ctx.response.status = Status.InternalServerError;
    ctx.response.body = "Failed encoding image.";
    return;
  }

  const dataUrl = `data:${contentType};base64,${base64}`;
  const pid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const newPhoto: PhotoItem = { id: pid, dataUrl };

  const prev = Array.isArray(r.photos) ? r.photos : [];
  const next = [...prev, newPhoto];

  await updateRestaurant(id, { photos: next } as any);

  ctx.response.status = Status.OK;
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = JSON.stringify({ ok: true, added: 1, total: next.length });
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

  // כאן כן נקרא JSON פשוט ע"י Web Request text() (לא body() של Oak).
  let webReq: Request | null = null;
  try {
    webReq =
      ((ctx.request as any).request as Request | undefined) ??
      ((ctx.request as any).originalRequest as Request | undefined) ??
      null;
  } catch {
    webReq = null;
  }
  if (!webReq) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "Invalid request.";
    return;
  }

  let payload: any = null;
  try {
    const raw = await webReq.text();
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
