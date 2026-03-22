import {
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "node:crypto";
import path from "node:path";
import s3Client from "./s3Client.js";

const BUCKET = process.env.S3_BUCKET_NAME;
const UPLOAD_EXP = Math.min(
  Math.max(Number(process.env.UPLOAD_URL_EXPIRATION ?? 900), 60),
  3600
);
const CDN_BASE_URL = (process.env.CDN_BASE_URL || "").replace(/\/+$/, "");
const REGION = process.env.S3_REGION || "auto"; // R2 uses "auto" for routing

if (!BUCKET) {
  throw new Error("S3_BUCKET_NAME missing in environment");
}

/* ============================================================
   DIRECT BUFFER UPLOAD (SERVER-SIDE)
============================================================ */
export async function uploadBufferToS3({ buffer, key, contentType }) {
  if (!buffer || !key || !contentType) {
    throw new Error("Missing parameters for buffer upload");
  }

  const cmd = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    ContentLength: buffer.length,
    CacheControl: "public, max-age=31536000, immutable",
    // ServerSideEncryption: "AES256",
  });

  await s3Client.send(cmd);

  return { publicUrl: publicUrlFromKey(key), key };
}

/* ============================================================
   SIGNED URL (FRONTEND UPLOAD)
============================================================ */
export async function createUploadUrl({ key, contentType }) {
  if (!key || !contentType) {
    throw new Error("key and contentType required");
  }

  const cmd = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
    CacheControl: "public, max-age=31536000, immutable",
    // ServerSideEncryption: "AES256",
  });

  const uploadUrl = await getSignedUrl(s3Client, cmd, {
    expiresIn: UPLOAD_EXP,
  });

  return {
    uploadUrl,
    publicUrl: publicUrlFromKey(key),
    key,
    expiresIn: UPLOAD_EXP,
  };
}

/* ============================================================
   KEY GENERATORS
============================================================ */
export function generateKey({ artistId, filename, folder = "" }) {
  if (!filename) throw new Error("filename is required");

  const ext = path.extname(filename).toLowerCase();
  const base = path
    .basename(filename, ext)
    .replaceAll(/\s+/g, "_")
    .replaceAll(/[^a-zA-Z0-9_-]/g, "");

  const rand = crypto.randomBytes(4).toString("hex");
  const ts = Date.now();

  const parts = [];
  if (artistId) parts.push("artists", artistId);
  if (folder) parts.push(folder);

  const finalName = `${ts}_${rand}_${base}${ext}`;
  return parts.length ? `${parts.join("/")}/${finalName}` : finalName;
}

export function generateFrontendKey({ filename, section = "generic" }) {
  if (!filename) throw new Error("filename required");

  const ext = path.extname(filename).toLowerCase();
  const base = path
    .basename(filename, ext)
    .replaceAll(/\s+/g, "_")
    .replaceAll(/[^a-zA-Z0-9_-]/g, "");

  const rand = crypto.randomBytes(4).toString("hex");
  const ts = Date.now();

  return `frontend/${section}/${ts}_${rand}_${base}${ext}`;
}

/* ============================================================
   URL HELPERS
============================================================ */
export function publicUrlFromKey(key) {
  if (!key) return "";

  if (CDN_BASE_URL) {
    return `${CDN_BASE_URL}/${key}`;
  }
  // Cloudflare R2 requires a public dev URL or custom domain. 
  // Set R2_PUBLIC_DEV_URL in your .env (e.g., https://pub-xxxxxxxxxxxx.r2.dev)
  const fallbackUrl = process.env.R2_PUBLIC_DEV_URL || "";
  return fallbackUrl ? `${fallbackUrl}/${key}` : key;
  // Use your Backblaze S3 Endpoint for the public URL
  // return `https://${BUCKET}.s3.${REGION}.backblazeb2.com/${key}`;
  // return `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`;
}

/* ============================================================
   OBJECT OPERATIONS
============================================================ */
export async function headObject(key) {
  if (!key) throw new Error("key required");
  return s3Client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
}

export async function deleteObject(key) {
  if (!key) return null;
  return s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

export async function deleteObjectWithVerify(key, opts = {}) {
  if (!key) return { success: true };

  const { retries = 3, backoffMs = 300 } = opts;
  let lastErr;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await deleteObject(key);

      try {
        await headObject(key);
        lastErr = new Error("Object still exists");
      } catch (err) {
        const status = err?.$metadata?.httpStatusCode;
        if (status === 404 || err?.name === "NotFound") {
          return { success: true, attempts: attempt };
        }
        lastErr = err;
      }
    } catch (err) {
      lastErr = err;
    }

    await new Promise((r) => setTimeout(r, backoffMs * attempt));
  }

  return {
    success: false,
    error: lastErr?.message || String(lastErr),
  };
}

export default {
  generateKey,
  generateFrontendKey,
  publicUrlFromKey,
  createUploadUrl,
  uploadBufferToS3,
  headObject,
  deleteObject,
  deleteObjectWithVerify,
};
