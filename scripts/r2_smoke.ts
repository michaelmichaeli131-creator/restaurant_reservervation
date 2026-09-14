import { deleteImageFromR2, R2_ENABLED, uploadImageToR2 } from "../lib/r2.ts";

if (!R2_ENABLED) {
  console.error("[R2_SMOKE] FAIL: R2 is not configured");
  Deno.exit(1);
}

// 1x1 transparent PNG. The object is temporary and is always deleted in finally.
const pngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const bytes = Uint8Array.from(atob(pngB64), (c) => c.charCodeAt(0));
const path = `smoke-tests/spotbook-${crypto.randomUUID()}.png`;
let uploaded = false;

try {
  const url = await uploadImageToR2(bytes, "image/png", path);
  uploaded = true;

  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`public URL returned HTTP ${response.status}`);
  }
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength === 0) {
    throw new Error("public URL returned an empty object");
  }

  console.log(`[R2_SMOKE] PASS: upload + public fetch (${body.byteLength} bytes)`);
} catch (error) {
  console.error("[R2_SMOKE] FAIL:", error);
  Deno.exitCode = 1;
} finally {
  if (uploaded) {
    try {
      await deleteImageFromR2(path);
      console.log("[R2_SMOKE] CLEANUP: temporary object deleted");
    } catch (error) {
      console.error("[R2_SMOKE] CLEANUP FAIL:", error);
      Deno.exitCode = 1;
    }
  }
}
