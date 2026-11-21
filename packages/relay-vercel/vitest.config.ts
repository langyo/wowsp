import { defineConfig } from "vitest/config";

// Node environment, no DOM: the adapter runs on Web-standard APIs that
// Node >= 22 provides natively (fetch, Request/Response, crypto.subtle),
// which is exactly the edge-runtime surface the handlers target.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
