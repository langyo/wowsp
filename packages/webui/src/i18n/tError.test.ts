/** tError: the plugin lifecycle stores' error contract mixes i18n keys
 *  (dot paths, no spaces — their busy/offline sentinels) with raw anyhow
 *  Display sentences from command rejections. Only the key may enter
 *  t(); a raw sentence must pass through verbatim (a lookup on it is a
 *  guaranteed miss that merely echoes the input back). */
import { beforeAll, describe, expect, it } from "vitest";

import { initLocaleMessages, t, tError } from "./index";

beforeAll(async () => {
  await initLocaleMessages();
});

describe("tError", () => {
  it("passes a raw backend sentence through verbatim", () => {
    const raw = "World of Warships is running from D:\\Games (pid 42) — close that client before installing";
    expect(tError(raw)).toBe(raw);
  });

  it("translates a key sentinel like t() does", () => {
    expect(tError("common.game.offline")).toBe(t("common.game.offline"));
    expect(tError("common.game.offline").length).toBeGreaterThan(0);
  });

  it("echoes an unknown space-free string like t() would", () => {
    expect(tError("not.a.real.key")).toBe(t("not.a.real.key"));
  });
});
