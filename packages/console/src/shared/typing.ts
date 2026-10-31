/**
 * View an object through a string index signature.
 *
 * hikari's table components take their rows as `Record<string, unknown>[]`
 * (they render arbitrary column keys, so the library cannot know a caller's
 * row shape), and a declared interface is — by design — not assignable to a
 * record with a string index signature. Routing a row through this helper
 * keeps the caller's type while satisfying the open record, so the table
 * hand-off is checked instead of double-cast.
 */
export function asIndexable<T extends object>(obj: T): T & Record<string, unknown> {
  return obj as T & Record<string, unknown>;
}
