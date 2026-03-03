import { randomBytes } from "crypto";

/** Generate a Codex-style item ID: `item_<hex>` */
export function itemId(): string {
  return "item_" + randomBytes(12).toString("hex");
}

/** Generate a Codex-style call ID: `call_<hex>` */
export function callId(): string {
  return "call_" + randomBytes(12).toString("hex");
}

/** Generate a UUID v4 string. */
export function makeId(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant RFC 4122
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
