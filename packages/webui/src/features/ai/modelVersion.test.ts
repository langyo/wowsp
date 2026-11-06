import { describe, expect, it } from "vitest";

import { AI_WEIGHTS_TRAINED_AT, aiModelVersion } from "./modelVersion";

describe("aiModelVersion", () => {
  it("stamps the app version and an ISO training date", () => {
    const version = aiModelVersion();
    expect(version.version.length).toBeGreaterThan(0);
    expect(version.trainedAt).toBe(AI_WEIGHTS_TRAINED_AT);
    expect(version.trainedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
