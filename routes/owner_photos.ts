// src/routes/owner_photos_debug.ts
import { Router, Status } from "jsr:@oak/oak";
import { getRestaurant, updateRestaurant } from "../database.ts";
import { requireOwner } from "../lib/auth.ts";
import { debugLog } from "../lib/debug.ts";

type PhotoItem = { id: string; dataUrl: string; alt?: string };

async function readJsonDebug(ctx: any): Promise<any | null> {
  debugLog("[photos][debug] hasBody:", ctx.request.hasBody);
  const ct = ctx.request.headers.get("content-type") || "";
  debugLog("[photos][debug] content-type header:", ct);

  // ניסיון JSON רגיל
  try {
    if (typeof ctx.request.body === "function") {
      const bodyObj = ctx.request.body({ type: "json" });
      debugLog("[photos][debug] bodyObj (json):", bodyObj);
      const v = await bodyObj.value;
      debugLog("[photos][debug] parsed JSON value:", v);
      return v;
    }
  } catch (e) {
    debugLog("[photos][debug] JSON parse error:", String(e));
  }

  // ניסיון text
  try {
    if (typeof ctx.request.body === "function") {
      const bodyTxt = await ctx.request.body({ type: "text" }).value;
      debugLog("[photos][debug] body as text:", bodyTxt);
      if (bodyTxt && bodyTxt.trim().length) {
        const parsed = JSON.parse(bodyTxt);
        debugLog("[photos][debug] parsed from text:", parsed);
        return parsed;
      }
    }
  } catch (e) {
    debugLog("[photos][debug] text->JSON error:", String(e));
  }

  // ניסיון bytes
  try {
    if (typeof ctx.request.body === "function") {
      const bytes = await ctx.request.body({ type: "bytes" }).value;
      debugLog("[photos][debug] body as bytes:", bytes && bytes.length);
      if (bytes) {
        const txt = new TextDecoder().decode(bytes);
        debugLog("[photos][debug] bytes decoded to text:", txt);
        if (txt && txt.trim().length) {
          const parsed = JSON.parse(txt);
          debugLog("[photos][debug] parsed from bytes:", parsed);
          return parsed;
        }
      }
    }
  } catch (e) {
    debugLog("[photos][debug] bytes->JSON error:", String(e));
  }

  // originalRequest json
  try {
    const req = (ctx.request as any).originalRequest
      ?? (ctx.request as any).request
      ?? null;
    debugLog("[photos][debug] originalRequest:", req);
    if (req && typeof req.json === "function") {
      const v = await req.json();
      debugLog("[photos][debug] originalRequest.json parsed:", v);
      return v;
    }
  } catch (e) {
    debugLog("[photos][debug] originalRequest.json error:", String(e));
  }

  return null;
}

const ownerPhotosRouterDebug = new Router();

ownerPhotosRouterDebug.post("/owner/restaurants/:id/photos/upload", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const id = ctx.params.id!;
  const restaurant = await getRestaurant(id);
  if (!restaurant) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "not found";
    return;
  }

  const data = await readJsonDebug(ctx);
  if (!data) {
    ctx.response.status = 400;
    ctx.response.body = "Invalid json.";
    return;
  }

  // אם הגענו לכאן – log מלא
  debugLog("[photos][upload] data:", data);

  const images = Array.isArray(data.images) ? data.images : [];
  if (!images.length) {
    ctx.response.status = 400;
    ctx.response.body = "no images";
    return;
  }

  const prev = restaurant.photos ?? [];
  const nextPhotos = [...prev, ...images].slice(-10);
  await updateRestaurant(id, { photos: nextPhotos });
  ctx.response.status = 200;
  ctx.response.body = { ok: true, count: images.length };
});

export default ownerPhotosRouterDebug;
export { ownerPhotosRouterDebug };
