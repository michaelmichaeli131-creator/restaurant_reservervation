// src/routes/owner_photos.ts
// ניהול תמונות מסעדה — בעלים בלבד
// העלאה/מחיקה ללא שימוש ב-request.body: משתמשים ב-ctx.request.originalRequest (Web API)
// התמונות נשמרות במערך photos של ה-restaurant כ-dataURL (MVP פשוט ללא תלות בקבצים חיצוניים)

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { getRestaurant, updateRestaurant } from "../database.ts";
import { requireOwner } from "../lib/auth.ts";
import { debugLog } from "../lib/debug.ts";

type PhotoItem = { id: string; dataUrl: string; alt?: string };

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

  // שימוש ב-Web Request מקורית כדי לקרוא JSON
  let data: any = null;
  try {
    const req = (ctx.request as any).originalRequest ?? null;
    if (!req || typeof req.json !== "function") throw new Error("no_json_api");
    data = await req.json();
  } catch (e) {
    debugLog("[owner_photos][upload] json read failed", String(e));
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
  const MAX_SIZE_B64 = 1_800_000 * 1.4; // בערך ~1.8MB לפני base64 (מרווח)
  const out: PhotoItem[] = [];

  for (const item of images.slice(0, MAX_FILES)) {
    const dataUrl = String(item?.dataUrl ?? "");
    const alt = typeof item?.alt === "string" ? item.alt.slice(0, 140) : undefined;

    // לוודא שמדובר ב-data url תקין (image/*)
    if (!/^data:image\/(png|jpe?g|webp);base64,/.test(dataUrl)) continue;
    // הגבלת גודל בסיסית
    if (dataUrl.length > MAX_SIZE_B64 * 1.42) continue;

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

  let data: any = null;
  try {
    const req = (ctx.request as any).originalRequest ?? null;
    if (!req || typeof req.json !== "function") throw new Error("no_json_api");
    data = await req.json();
  } catch {
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
