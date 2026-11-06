// Router navigation safety net wiring contract (2026-11-05 field incident).
//
// The hikari family ships two kinds of hardening with DIFFERENT wiring
// surfaces: the boot-chrome/boot-recovery family is a Vite plugin (the
// config edit is an unavoidable integration point, so hosts never miss
// it), while the navigation safety runtime is a pure installer call that
// only the host's own router module can make — nothing fails when it is
// missing, and the app runs fine until a poisoned navigation producer
// fires. That is exactly how the 2026-11-05 field incident slipped through:
// shittim-chest wired the net into its router module the day it was written
// (shittim-chest #754, upstreamed as hikari #450), but wowsp adopted hikari
// piecemeal and never picked the wiring up — an entry state carrying
// current:"undefined/" then made every router.push() throw "Failed to
// execute 'replace' on 'Location': 'http://127.0.0.1:5199undefined/' is not
// a valid URL" until the app restarted (fixed in #1761). These pins keep
// the wiring from being silently refactored away:
//   - router/index.ts imports installNavigationSafetyNet from the
//     @celestia-island/hikari/runtime subpath (the aggregate entry does NOT
//     re-export the navigation family) AND installs it on the router;
//   - the runtime subpath still exports the family, so a hikari upgrade
//     that moves it fails here loudly instead of silently no-oping.
// The behavioral regression itself (fold -> navigate -> heal over a
// poisoned entry) is pinned next door in navigationSafetyNet.test.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import * as hikariRuntime from "@celestia-island/hikari/runtime";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf-8");

const routerSource = read("./index.ts");

describe("router navigation safety net wiring", () => {
  it("wires hikari's installNavigationSafetyNet at the router module scope", () => {
    expect(routerSource).toMatch(
      /import\s*\{\s*installNavigationSafetyNet\s*\}\s*from\s*"@celestia-island\/hikari\/runtime"/,
    );
    expect(routerSource).toMatch(/installNavigationSafetyNet\(\s*\{\s*router[\s,}]/);
  });

  it("keeps the runtime subpath exports alive across hikari upgrades", () => {
    expect(typeof hikariRuntime.installNavigationSafetyNet).toBe("function");
    expect(typeof hikariRuntime.installHistorySafetyNet).toBe("function");
    expect(typeof hikariRuntime.sanitizeHistoryUrl).toBe("function");
  });
});
