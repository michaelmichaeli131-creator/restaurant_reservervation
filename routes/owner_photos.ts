// src/routes/owner_photos.ts
// ניהול תמונות מסעדה — בעלים בלבד
// גרסה פשוטה ויציבה עם לוגים משופרים וקריאת JSON ידנית

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { getRestaurant, updateRestaurant } from "../database.ts";
import { requireOwner } from "../lib/auth.ts";
import { debugLog } from "../lib/debug.ts";

type PhotoItem = { id: string; dataUrl: string; alt?: string };

// ---- קריאת JSON בצורה הבטוחה ביותר ----
async function readJsonSafe(ctx: any): Promise<any | null> {
  try {
    const ct = ctx.request.headers.get("content-type") || "";
    debugLog("[photos][readJsonSafe] content-type:", ct);

    // נבדוק אם בכלל יש גוף
    if (!ctx.request.hasBody) {
      debugLog("[photos][readJsonSafe] no body present");
      return null;
    }

    // ננסה תמיד לקרוא את הגוף כטקסט
    const body = ctx.request.body();
    const v = await body.value;

    if (typeof v === "string") {
      debugLog("[photos][readJsonSafe] got string body len=", v.length);
      const preview = v.slice(0, 200);
      debugLog("[photos][readJsonSafe] preview:", preview);
      try {
        const json = JSON.parse(v);
        debugLog("[photos][readJsonSafe] parsed JSON OK");
        return json;
      } catch (e) {
        debugLog("[photos][readJsonSafe] JSON.parse failed:", String(e));
      }
    } else if (v && typeof v === "object") {
      debugLog("[photos][readJsonSafe] got object body directly");
      return v;
    }

    // fallback נוסף: אם לא עבד, ננסה לקרוא clone.text()
    const req: any = (ctx.request as any)?.request ?? null;
    if (req && typeof req.text === "function") {
      const text = await req.text();
      debugLog("[photos][readJsonSafe] fallback req.text() len=", text?.length);
      if (text && text.trim()) {
        const json = JSON.parse(text);
        debugLog("[photos][readJsonSafe] fallback parsed OK");
        return json;
      }
    }
  } catch (e) {
    debugLog("[photos][readJsonSafe] failed:", String(e));
  }

  debugLog("[photos][readJsonSafe] all attempts failed -> return null");
  return null;
}

const ownerPhotosRouter = new Router();

// ----------------------------------------------------
// GET: מסך ניהול תמונות
// ----------------------------------------------------
ownerPhotosRouter.get("/owner/restaurants/:id/photos", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const id = ctx.params.id!;
  const r = await getRestaurant(id);

  if (!r || r.ownerId !== (ctx.state as any)?.user?.id) {
    ctx.response.status = Status.NotFound;
    await render(ctx, "error", {
      title: "לא נמצא",
      message: "מסעדה לא נמצאה או שאין הרשאה.",
    });
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

// ----------------------------------------------------
// POST: העלאת תמונות כ-dataURL
// ----------------------------------------------------
ownerPhotosRouter.post(
  "/owner/restaurants/:id/photos/upload",
  async (ctx) => {
    if (!requireOwner(ctx)) return;

    const id = ctx.params.id!;
    const r = await getRestaurant(id);

    debugLog("[photos][upload] restaurant:", {
      id: r?.id,
      photosCount: Array.isArray(r?.photos) ? r.photos.length : 0,
    });

    if (!r || r.ownerId !== (ctx.state as any)?.user?.id) {
      ctx.response.status = Status.NotFound;
      ctx.response.body = "מסעדה לא נמצאה או אין הרשאה.";
      return;
    }

    const data = await readJsonSafe(ctx);
    debugLog("[photos][upload] data from readJsonSafe:", data);

    if (!data) {
      debugLog("[photos][upload] invalid JSON, no data");
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

    const MAX_FILES = 12;
    const MAX_DATAURL_LEN = Math.floor(1.8 * 1024 * 1024 * 1.6);
    const out: PhotoItem[] = [];

    for (const item of images.slice(0, MAX_FILES)) {
      const dataUrl = String(item?.dataUrl ?? "");
      const alt =
        typeof item?.alt === "string" ? item.alt.slice(0, 140) : undefined;

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

    debugLog("[photos][upload] added:", out.length, "total now:", nextPhotos.length);

    ctx.response.status = Status.OK;
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify({
      ok: true,
      added: out.length,
      total: nextPhotos.length,
    });
  }
);

// ----------------------------------------------------
// POST: מחיקת תמונה לפי id
// ----------------------------------------------------
ownerPhotosRouter.post(
  "/owner/restaurants/:id/photos/delete",
  async (ctx) => {
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

    debugLog("[photos][delete] removed:", pid, "total now:", nextPhotos.length);

    ctx.response.status = Status.OK;
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify({
      ok: true,
      removed: pid,
      total: nextPhotos.length,
    });
  }
);

export default ownerPhotosRouter;
export { ownerPhotosRouter };
