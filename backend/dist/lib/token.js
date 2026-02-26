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
function signInstanceId(instanceId) {
    const signature = node_crypto_1.default.createHmac(ALGORITHM, SECRET).update(instanceId).digest("hex");
    return `${instanceId}.${signature}`;
}
function verifyAndGetInstanceId(token) {
    const dot = token.lastIndexOf(".");
    if (dot === -1)
        return null;
    const instanceId = token.slice(0, dot);
    const signature = token.slice(dot + 1);
    const expected = node_crypto_1.default.createHmac(ALGORITHM, SECRET).update(instanceId).digest("hex");
    if (signature !== expected)
        return null;
    return instanceId;
}
