"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.signInstanceId = signInstanceId;
exports.verifyAndGetInstanceId = verifyAndGetInstanceId;
const node_crypto_1 = __importDefault(require("node:crypto"));
const SECRET = process.env.HOOK_SECRET;
const ALGORITHM = "sha256";
if (!SECRET) {
    throw new Error("HOOK_SECRET is required");
}
/**
 * Token format: {instanceId}.{version}.{hmac-sha256}
 */
function signInstanceId(instanceId, version) {
    const payload = `${instanceId}.${version}`;
    const signature = node_crypto_1.default.createHmac(ALGORITHM, SECRET).update(payload).digest("hex");
    return `${instanceId}.${version}.${signature}`;
}
function verifyAndGetInstanceId(token) {
    const dot1 = token.indexOf(".");
    const dot2 = token.lastIndexOf(".");
    if (dot1 === -1 || dot1 === dot2)
        return null;
    const instanceId = token.slice(0, dot1);
    const versionStr = token.slice(dot1 + 1, dot2);
    const signature = token.slice(dot2 + 1);
    const version = parseInt(versionStr, 10);
    if (isNaN(version))
        return null;
    const expected = node_crypto_1.default
        .createHmac(ALGORITHM, SECRET)
        .update(`${instanceId}.${version}`)
        .digest("hex");
    if (signature !== expected)
        return null;
    return { instanceId, tokenVersion: version };
}
