/** SectionBoundary: one failure is a hiccup (toast + remount), a repeated
 *  one is a broken section (retryable card fills the pane). */
import { mount } from "@vue/test-utils";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { defineComponent } from "vue";

vi.mock("@/utils/uiError", () => ({ reportUiError: vi.fn() }));

import { initLocaleMessages } from "@/i18n";
import { reportUiError } from "@/utils/uiError";
import SectionBoundary from "./SectionBoundary";

const mocked = vi.mocked(reportUiError);

beforeAll(async () => {
  await initLocaleMessages();
});

/** A child that throws on its first N renders, then renders "ok". */
function flakyChild(throws: number) {
  let rendered = 0;
  return defineComponent({
    setup() {
      return () => {
        rendered += 1;
        if (rendered <= throws) {
          throw new Error("boom");
        }
        return <span class="flaky-ok">ok</span>;
      };
    },
  });
}

describe("SectionBoundary", () => {
  it("recovers from a single render failure with a toast, no placeholder", async () => {
    mocked.mockClear();
    const Child = flakyChild(1);
    const wrapper = mount(SectionBoundary, {
      slots: { default: () => <Child /> },
    });
    await vi.waitFor(() => {
      expect(mocked).toHaveBeenCalled();
      expect(wrapper.find(".flaky-ok").exists()).toBe(true);
    });
    expect(wrapper.find(".hk-error-landing").exists()).toBe(false);
    wrapper.unmount();
  });

  it("fills the pane when the section keeps failing", async () => {
    mocked.mockClear();
    const Child = flakyChild(99);
    const wrapper = mount(SectionBoundary, {
      slots: { default: () => <Child /> },
    });
    await vi.waitFor(() => {
      expect(mocked.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(wrapper.find(".hk-error-landing").exists()).toBe(true);
    });
    wrapper.unmount();
  });
});
