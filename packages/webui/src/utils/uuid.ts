import { v4, v7 } from "uuid";

/** Random UUID (v4). */
export function uuid(): string {
  return v4();
}

/** Time-ordered UUID (v7). Used by the popup manager for unique handles. */
export function uuidv7(): string {
  return v7();
}
