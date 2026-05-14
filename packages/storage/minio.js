import crypto from "node:crypto";
import { Client } from "minio";
import { config } from "../core/config.js";

let client;
let bucketReady = false;

export function getStorageClient() {
  if (!client) {
    client = new Client({
      endPoint: config.storage.endpoint,
      port: config.storage.port,
      useSSL: config.storage.useSSL,
      accessKey: config.storage.accessKey,
      secretKey: config.storage.secretKey,
    });
  }
  return client;
}

export async function ensureBucket() {
  if (bucketReady) return;
  const storage = getStorageClient();
  const exists = await storage.bucketExists(config.storage.bucket).catch(() => false);
  if (!exists) {
    await storage.makeBucket(config.storage.bucket);
  }
  bucketReady = true;
}

export function checksum(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export async function putArtifactObject({ ticketId, filename, mimeType, content }) {
  await ensureBucket();
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
  const size = buffer.byteLength;
  if (size > config.artifactMaxBytes) {
    const err = new Error(`Artifact exceeds ${config.artifactMaxBytes} byte limit.`);
    err.code = "artifact_too_large";
    throw err;
  }

  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "-");
  const objectKey = `${ticketId}/${crypto.randomUUID()}-${safeName}`;
  await getStorageClient().putObject(config.storage.bucket, objectKey, buffer, size, {
    "content-type": mimeType,
  });

  return {
    objectKey,
    filename,
    mimeType,
    sizeBytes: size,
    checksum: checksum(buffer),
  };
}

export async function presignedArtifactUrl(objectKey, expirySeconds = 60 * 60) {
  await ensureBucket();
  return getStorageClient().presignedGetObject(config.storage.bucket, objectKey, expirySeconds);
}
