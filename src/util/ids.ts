import { randomBytes } from "node:crypto";

/** Short, readable, random identifiers such as `g-3f9a1c0b2d`. */
export function newId(prefix: string): string {
  return `${prefix}-${randomBytes(5).toString("hex")}`;
}

export function newSecret(): string {
  return randomBytes(32).toString("hex");
}
