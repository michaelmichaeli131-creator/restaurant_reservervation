// src/routes/owner_photos.ts
// העלאת תמונות פשוטה — קובץ אחד בכל בקשה
// ללא JSON, ללא multipart. מקבל את הקובץ ישירות כ-binary body.

import { Router, Status } from "jsr:@oak/oak";
import { getRestaurant, updateRestaurant } from "../database.ts";
import { requireOwner } from "../lib/auth.ts";
import { debugLog } from "../lib/debug.ts";

const ownerPhotosRouter = new Router();

// ---------------- GET ----------------
ownerPhotosRouter.get("/owner/restaurants/:id/photos", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const id = ctx.params.id!;
  const r = await getRestaurant(id);

  if (!r || r.ownerId !== (ctx.state as any)?.user?.id) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "מסעדה לא נמצאה או אין הרשאה.";
    return;
  }

await render(ctx, "owner_photos.eta", {
  title: `תמונות — ${r.name}`,
  page: "owner_photos",
  restaurant: r,
});

// ---------------- POST (UPLOAD IMAGE) ----------------
ownerPhotosRouter.post("/owner/restaurants/:id/photos/upload", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const id = ctx.params.id!;
  const r = await getRestaurant(id);

  if (!r || r.ownerId !== (ctx.state as any)?.user?.id) {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = "אין הרשאה למסעדה זו.";
    return;
  }

  // קריאה ישירה של גוף הבקשה כ-bytes
  let bytes: Uint8Array | null = null;
  try {
    const body = ctx.request.body({ type: "bytes" });
    bytes = await body.value;
  } catch (e) {
    debugLog("[photos][upload] failed to read bytes:", String(e));
  }

  if (!bytes || !bytes.length) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "לא התקבלה תמונה בבקשה.";
    return;
  }

  const contentType = ctx.request.headers.get("content-type") ?? "image/jpeg";
  debugLog("[photos][upload] received bytes:", bytes.length, "bytes type=", contentType);

  // המרת התמונה ל-dataURL כדי לשמור במסד נתונים
  const base64 = btoa(String.fromCharCode(...bytes));
  const dataUrl = `data:${contentType};base64,${base64}`;

  // יצירת מזהה תמונה
  const pid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const newPhoto = { id: pid, dataUrl };
  const prev = Array.isArray(r.photos) ? r.photos : [];
  const next = [...prev, newPhoto];

  await updateRestaurant(id, { photos: next } as any);

  ctx.response.status = Status.OK;
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = JSON.stringify({ ok: true, added: 1, total: next.length });
});

export default ownerPhotosRouter;
export { ownerPhotosRouter };
