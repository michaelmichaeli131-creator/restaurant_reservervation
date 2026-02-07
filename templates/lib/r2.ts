// lib/r2.ts
// Cloudflare R2 (S3-compatible) client for restaurant image uploads

import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

const R2_ACCOUNT_ID = Deno.env.get("R2_ACCOUNT_ID");
const R2_ACCESS_KEY = Deno.env.get("R2_ACCESS_KEY");
const R2_SECRET_KEY = Deno.env.get("R2_SECRET_KEY");
const R2_BUCKET = Deno.env.get("R2_BUCKET");
const R2_PUBLIC_URL = Deno.env.get("R2_PUBLIC_URL");

// Check if R2 is configured
export const R2_ENABLED = !!(R2_ACCOUNT_ID && R2_ACCESS_KEY && R2_SECRET_KEY && R2_BUCKET && R2_PUBLIC_URL);

let s3Client: S3Client | null = null;

if (R2_ENABLED) {
  s3Client = new S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY!,
      secretAccessKey: R2_SECRET_KEY!,
    },
  });
  console.log("[R2] ✅ Configured and ready");
} else {
  console.log("[R2] ⚠️ Not configured - using base64 fallback");
}

/**
 * Upload image to R2
 * @param imageBytes - Image binary data
 * @param contentType - MIME type (e.g., "image/jpeg")
 * @param path - Storage path (e.g., "restaurants/rest-id/photo-id.jpg")
 * @returns Public URL of uploaded image
 */
export async function uploadImageToR2(
  imageBytes: Uint8Array,
  contentType: string,
  path: string,
): Promise<string> {
  if (!R2_ENABLED || !s3Client) {
    throw new Error("R2 not configured. Set R2_* environment variables in .env");
  }

  try {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: path,
        Body: imageBytes,
        ContentType: contentType,
      }),
    );

    const publicUrl = `${R2_PUBLIC_URL}/${path}`;
    console.log(`[R2] ✅ Uploaded: ${path} → ${publicUrl}`);
    return publicUrl;
  } catch (error) {
    console.error("[R2] ❌ Upload failed:", error);
    throw new Error(`Failed to upload to R2: ${error}`);
  }
}

/**
 * Delete image from R2
 * @param path - Storage path (e.g., "restaurants/rest-id/photo-id.jpg")
 */
export async function deleteImageFromR2(path: string): Promise<void> {
  if (!R2_ENABLED || !s3Client) {
    throw new Error("R2 not configured.");
  }

  try {
    await s3Client.send(
      new DeleteObjectCommand({
        Bucket: R2_BUCKET,
        Key: path,
      }),
    );
    console.log(`[R2] 🗑️ Deleted: ${path}`);
  } catch (error) {
    console.error("[R2] ❌ Delete failed:", error);
    throw new Error(`Failed to delete from R2: ${error}`);
  }
}

/**
 * Generate R2 path for restaurant photo
 * @param restaurantId - Restaurant UUID
 * @param photoId - Photo UUID
 * @param contentType - MIME type to determine extension
 * @returns Path string (e.g., "restaurants/abc-123/photo-xyz.jpg")
 */
export function generatePhotoPath(restaurantId: string, photoId: string, contentType: string): string {
  // Extract extension from content type
  const ext = contentType.split("/")[1]?.replace("jpeg", "jpg") || "jpg";
  return `restaurants/${restaurantId}/${photoId}.${ext}`;
}

/**
 * Extract R2 path from public URL
 * @param url - Public R2 URL
 * @returns Path portion (e.g., "restaurants/abc-123/photo.jpg")
 */
export function extractPathFromUrl(url: string): string | null {
  if (!url || !R2_PUBLIC_URL) return null;

  try {
    const publicUrlBase = R2_PUBLIC_URL.replace(/\/$/, ""); // Remove trailing slash
    if (url.startsWith(publicUrlBase + "/")) {
      return url.substring(publicUrlBase.length + 1);
    }
  } catch {
    return null;
  }

  return null;
}
