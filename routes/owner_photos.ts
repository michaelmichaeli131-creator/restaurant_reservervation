// src/routes/owner_photos.ts
import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { getRestaurant, updateRestaurant } from "../database.ts";
import { requireOwner } from "../lib/auth.ts";
import { debugLog } from "../lib/debug.ts";

type PhotoItem = { id: string; dataUrl: string; alt?: string };

async function readJsonSafe(ctx: any): Promise<any | null> {
  // לוג ראשוני
  debugLog("[photos][readJsonSafe] START");
  debugLog("[photos] ctx.request.hasBody:", ctx.request.hasBody);
  try {
    const ct = ctx.request.headers.get("content-type") || "";
    debugLog("[photos][readJsonSafe] content-type header:", ct);
  } catch (e) {
    debugLog("[photos] error getting content-type header:", String(e));
  }

  // 1) ניסיון clone().text()
  try {
    const req =
      (ctx.request as any)?.request ??
      (ctx.request as any)?.originalRequest ??
      (ctx as any)?.request ??
      null;
    debugLog("[photos] trying clone/text method. req:", req);
    if (req && typeof req.clone === "function" && typeof req.text === "function") {
      const text = await req.clone().text();
      debugLog("[photos] clone().text result:", text && text.length, text?.slice(0, 200));
      if (text && text.trim().length) {
        const data = JSON.parse(text);
        debugLog("[photos] clone/text parsed JSON:", data);
        return data;
      }
    }
  } catch (e) {
    debugLog("[photos] req.clone().text() parse failed:", String(e));
  }

  // 2) Oak JSON body
  try {
    if (typeof ctx.request.body === "function") {
      const b = ctx.request.body({ type: "json" });
      debugLog("[photos] body({type: 'json'}) b:", b);
      const v = await b.value;
      debugLog("[photos] body({json}).value:", v);
      if (v && typeof v === "object") {
        return v;
      }
    }
  } catch (e) {
    debugLog("[photos] body({json}) failed:", String(e));
  }

  // 3) Oak bytes -> decode -> JSON
  try {
    if (typeof ctx.request.body === "function") {
      const b2 = ctx.request.body({ type: "bytes" });
      debugLog("[photos] body({bytes}) b2:", b2);
      const bytes: Uint8Array = await b2.value;
      debugLog("[photos] bytes length:", bytes?.length);
      if (bytes && bytes.length) {
        const text = new TextDecoder().decode(bytes);
        debugLog("[photos] decoded text from bytes:", text && text.length, text?.slice(0, 200));
        if (text && text.trim().length) {
          const v = JSON.parse(text);
          debugLog("[photos] parsed JSON from bytes:", v);
          return v;
        }
      }
    }
  } catch (e) {
    debugLog("[photos] body({bytes}) parse failed:", String(e));
  }

  // 4) originalRequest.json
  try {
    const req =
      (ctx.request as any)?.originalRequest ??
      (ctx.request as any)?.request ??
      null;
    debugLog("[photos] trying originalRequest.json. req:", req);
    if (req && typeof req.json === "function") {
      const v = await req.json();
      debugLog("[photos] originalRequest.json parsed:", v);
      return v;
    }
  } catch (e) {
    debugLog("[photos] originalRequest.json failed:", String(e));
  }

  debugLog("[photos][readJsonSafe] all methods failed -> returning null");
  return null;
}

const ownerPhotosRouter = new Router();

// GET (unchanged)
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

// POST upload
ownerPhotosRouter.post("/owner/restaurants/:id/photos/upload", async (ctx) => {
  debugLog("[photos][upload] start upload flow");
  if (!requireOwner(ctx)) {
    debugLog("[photos][upload] requireOwner failed");
    return;
  }
  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  debugLog("[photos][upload] restaurant:", r ? { id: r.id, photosCount: (r.photos ?? []).length } : null);

  if (!r || r.ownerId !== (ctx.state as any)?.user?.id) {
    debugLog("[photos][upload] unauthorized or not found");
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

  const images = Array.isArray(data.images) ? data.images : [];
  debugLog("[photos][upload] images array:", images.length, images.slice(0, 2));

  if (!images.length) {
    debugLog("[photos][upload] no images found in payload");
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "no images";
    return;
  }

  const MAX_FILES = 12;
  const MAX_DATAURL_LEN = Math.floor(1.8 * 1024 * 1024 * 1.6);
  const out: PhotoItem[] = [];
  for (const item of images.slice(0, MAX_FILES)) {
    const dataUrl = String(item?.dataUrl ?? "");
    const alt = typeof item?.alt === "string" ? item.alt.slice(0, 140) : undefined;
    debugLog("[photos][upload] check image", { length: dataUrl.length, alt });

    if (!/^data:image\/(png|jpe?g|webp);base64,/.test(dataUrl)) {
      debugLog("[photos][upload] dataUrl format invalid:", dataUrl.slice(0, 50));
      continue;
    }
    if (dataUrl.length > MAX_DATAURL_LEN) {
      debugLog("[photos][upload] dataUrl too long:", dataUrl.length, "max:", MAX_DATAURL_LEN);
      continue;
    }
    const idPart = Math.random().toString(36).slice(2, 10);
    out.push({ id: `${Date.now()}-${idPart}`, dataUrl, alt });
  }

  debugLog("[photos][upload] out array:", out.length, out.map(p => p.id));

  if (!out.length) {
    debugLog("[photos][upload] no valid images after filter");
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "no valid images";
    return;
  }

  const prev = Array.isArray(r.photos) ? r.photos : [];
  const nextPhotos = [...prev, ...out];
  debugLog("[photos][upload] nextPhotos length:", nextPhotos.length);

  await updateRestaurant(id, { photos: nextPhotos } as any);

  ctx.response.status = Status.OK;
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = JSON.stringify({ ok: true, added: out.length, total: nextPhotos.length });
  debugLog("[photos][upload] response sent OK");
});

// POST delete
ownerPhotosRouter.post("/owner/restaurants/:id/photos/delete", async (ctx) => {
  debugLog("[photos][delete] start delete flow");
  if (!requireOwner(ctx)) {
    debugLog("[photos][delete] requireOwner failed");
    return;
  }
  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  debugLog("[photos][delete] restaurant:", r ? { id: r.id, photosCount: (r.photos ?? []).length } : null);

  if (!r || r.ownerId !== (ctx.state as any)?.user?.id) {
    debugLog("[photos][delete] unauthorized or not found");
    ctx.response.status = Status.NotFound;
    ctx.response.body = "מסעדה לא נמצאה או אין הרשאה.";
    return;
  }

  const data = await readJsonSafe(ctx);
  debugLog("[photos][delete] data from readJsonSafe:", data);

  if (!data) {
    debugLog("[photos][delete] invalid JSON, no data");
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "Invalid JSON";
    return;
  }

  const pid = String(data?.id ?? "");
  debugLog("[photos][delete] pid:", pid);

  if (!pid) {
    debugLog("[photos][delete] missing id");
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "missing id";
    return;
  }

  const prev = Array.isArray(r.photos) ? r.photos : [];
  const nextPhotos = prev.filter((p: PhotoItem) => p.id !== pid);
  debugLog("[photos][delete] new photos length:", nextPhotos.length);

  await updateRestaurant(id, { photos: nextPhotos } as any);

  ctx.response.status = Status.OK;
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = JSON.stringify({ ok: true, removed: pid, total: nextPhotos.length });
  debugLog("[photos][delete] response sent OK");
});

export default ownerPhotosRouter;
export { ownerPhotosRouter };
