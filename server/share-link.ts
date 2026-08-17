import crypto from "node:crypto";

export const SHARE_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

const FILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sign(secret: string, fileId: string, expires: number): string {
  return crypto.createHmac("sha256", secret).update(`${fileId}:${expires}`).digest("hex");
}

/**
 * Stateless share token: `<fileId>:<expires>:<hmac>`, base64url-encoded.
 * Only the service secret can mint or validate it, so no database table or
 * revocation list is needed for the short-lived preview links.
 */
export function createShareToken(secret: string, fileId: string, expires = Math.floor(Date.now() / 1000) + SHARE_LIFETIME_SECONDS): string {
  return Buffer.from(`${fileId}:${expires}:${sign(secret, fileId, expires)}`, "utf8").toString("base64url");
}

export function parseShareToken(secret: string, token: string): { fileId: string; expires: number } | null {
  if (!token || token.length > 512) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const match = decoded.match(/^([^:]+):(\d{1,12}):([a-f0-9]{64})$/i);
  if (!match) return null;
  const fileId = match[1];
  const expires = Number(match[2]);
  if (!FILE_ID_PATTERN.test(fileId) || !Number.isSafeInteger(expires) || expires < 1) return null;
  const expected = sign(secret, fileId, expires);
  const actual = match[3].toLowerCase();
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(actual, "utf8");
  if (expectedBuffer.length !== actualBuffer.length || !crypto.timingSafeEqual(expectedBuffer, actualBuffer)) return null;
  if (expires < Math.floor(Date.now() / 1000)) return null;
  return { fileId, expires };
}
