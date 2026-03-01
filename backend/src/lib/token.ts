import crypto from "node:crypto";

const SECRET = process.env.HOOK_SECRET;
const ALGORITHM = "sha256";

if (!SECRET) {
  throw new Error("HOOK_SECRET is required");
}

export type VerifiedToken = {
  instanceId: string;
  tokenVersion: number;
};

/**
 * Token format: {instanceId}.{version}.{hmac-sha256}
 */
export function signInstanceId(instanceId: string, version: number): string {
  const payload = `${instanceId}.${version}`;
  const signature = crypto.createHmac(ALGORITHM, SECRET!).update(payload).digest("hex");
  return `${instanceId}.${version}.${signature}`;
}

export function verifyAndGetInstanceId(token: string): VerifiedToken | null {
  const dot1 = token.indexOf(".");
  const dot2 = token.lastIndexOf(".");
  if (dot1 === -1 || dot1 === dot2) return null;

  const instanceId = token.slice(0, dot1);
  const versionStr = token.slice(dot1 + 1, dot2);
  const signature = token.slice(dot2 + 1);

  const version = parseInt(versionStr, 10);
  if (isNaN(version)) return null;

  const expected = crypto
    .createHmac(ALGORITHM, SECRET!)
    .update(`${instanceId}.${version}`)
    .digest("hex");

  if (signature !== expected) return null;
  return { instanceId, tokenVersion: version };
}
