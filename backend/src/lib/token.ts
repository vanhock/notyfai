import crypto from "node:crypto";

const SECRET = process.env.HOOK_SECRET;
const ALGORITHM = "sha256";

if (!SECRET) {
  throw new Error("HOOK_SECRET is required");
}

export function signInstanceId(instanceId: string): string {
  const signature = crypto.createHmac(ALGORITHM, SECRET!).update(instanceId).digest("hex");
  return `${instanceId}.${signature}`;
}

export function verifyAndGetInstanceId(token: string): string | null {
  const dot = token.lastIndexOf(".");
  if (dot === -1) return null;
  const instanceId = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = crypto.createHmac(ALGORITHM, SECRET!).update(instanceId).digest("hex");
  if (signature !== expected) return null;
  return instanceId;
}
