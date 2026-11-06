import { describe, expect, it } from "vitest";

import { createIdentityGate, identityCacheKey } from "./reportSheet";

describe("identityCacheKey", () => {
  it("separates the same nickname on different realms", () => {
    expect(identityCacheKey("asia", "ghost_rat")).not.toBe(
      identityCacheKey("eu", "ghost_rat"),
    );
    expect(identityCacheKey("asia", "ghost_rat")).toBe("asia\u0000ghost_rat");
  });
});

describe("createIdentityGate", () => {
  it("keeps only the latest ticket current — cache hits included", () => {
    const gate = createIdentityGate();
    const first = gate.next();
    expect(gate.isCurrent(first)).toBe(true);
    // A cache-hit resolve must also take a ticket, so a still-pending
    // lookup from the previous perspective is invalidated:
    const second = gate.next();
    expect(gate.isCurrent(second)).toBe(true);
    expect(gate.isCurrent(first)).toBe(false);
    // ...and vice versa: the newest ticket always wins.
    const third = gate.next();
    expect(gate.isCurrent(third)).toBe(true);
    expect(gate.isCurrent(second)).toBe(false);
  });
});
