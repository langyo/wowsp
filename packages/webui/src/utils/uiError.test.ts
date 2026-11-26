/** reportUiError: the one UI error sink must stay QUIET for the browser's
 *  internal ResizeObserver resize-loop notices (both engine spellings — a
 *  benign layout race the engine drops on the floor, no app failure), while
 *  still logging and toasting every real error. @/api and hikari's useToast
 *  are mocked at the module boundary — the happy-dom test env has no Tauri
 *  backend and no toast provider to mount. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logUiError: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/api", () => ({ api: { logUiError: mocks.logUiError } }));
vi.mock("@celestia-island/hikari", () => ({
  useToast: () => ({ error: mocks.toastError }),
}));
vi.mock("@/i18n", () => ({
  t: (key: string, params?: Record<string, unknown>) =>
    `${key}:${params?.message ?? ""}`,
}));

describe("reportUiError", () => {
  // reportUiError dedupes toasts through a module-scope Set; every test
  // re-imports the module for a fresh sink so cases cannot leak verdicts.
  beforeEach(() => {
    vi.resetModules();
    mocks.logUiError.mockReset();
    mocks.toastError.mockReset();
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it.each([
    "ResizeObserver loop completed with undelivered notifications",
    "ResizeObserver loop limit exceeded",
  ])("swallows the benign resize-loop notice (%s) silently", async (message) => {
    const { reportUiError } = await import("./uiError");
    reportUiError(message);
    expect(mocks.logUiError).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(console.debug).toHaveBeenCalledTimes(1);
    expect(console.debug).toHaveBeenCalledWith(expect.stringContaining("ResizeObserver"), message);
  });

  it("still swallows the notice when a Vue handler wraps the message", async () => {
    const { reportUiError } = await import("./uiError");
    // app.config.errorHandler appends the handler info in parentheses.
    reportUiError(
      "ResizeObserver loop completed with undelivered notifications (render function)",
    );
    expect(mocks.logUiError).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("logs and toasts a real error", async () => {
    const { reportUiError } = await import("./uiError");
    reportUiError("Something actually broke", "Error: stack");
    expect(mocks.logUiError).toHaveBeenCalledTimes(1);
    expect(mocks.logUiError).toHaveBeenCalledWith("Something actually broke", "Error: stack");
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith("common.uiError:Something actually broke");
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("toasts a real error once per distinct message", async () => {
    const { reportUiError } = await import("./uiError");
    reportUiError("Same failure");
    reportUiError("Same failure");
    reportUiError("Other failure");
    expect(mocks.toastError).toHaveBeenCalledTimes(2);
  });
});
