import { readFileSync } from "node:fs";
import { initializeApp, getApps, cert, type App } from "firebase-admin/app";

let _app: App | null = null;

function getServiceAccountJson(): object {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT env var is required for push notifications");
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed) as object;
  }
  const json = readFileSync(trimmed, "utf8");
  return JSON.parse(json) as object;
}

export function getFirebaseApp(): App {
  if (_app) return _app;

  const existing = getApps();
  if (existing.length > 0) {
    _app = existing[0];
    return _app;
  }

  _app = initializeApp({ credential: cert(getServiceAccountJson()) });
  return _app;
}
