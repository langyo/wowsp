/** Regression: the app-wide native-menu suppressor must NOT count as the
 *  inner binding that consumed the event. playerFromPoint defers when the
 *  contextmenu is already defaultPrevented (that guard lets the tactical
 *  board's canvas menu stay innermost); a CAPTURE-phase blocker would
 *  set that flag before the player binding ever runs and silently kill
 *  the app-global player menu. */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { HkContextMenuProvider } from "@celestia-island/hikari";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@/transport", () => ({ transport: { invoke: mocks.invoke } }));

import { installNativeMenuBlock } from "@/utils/nativeMenu";
import { PlayerContextMenuHost } from "./playerContextMenu";

beforeEach(() => {
  setActivePinia(createPinia());
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(() => Promise.resolve([]));
});

afterEach(() => {
  document
    .querySelectorAll(".hk-select-popout, .hk-select-sheet-panel, .hk-select-sheet-scrim, .nick")
    .forEach((el) => el.remove());
  window.history.replaceState(null, "");
});

describe("native menu blocker + player context menu", () => {
  it("still opens the player menu and suppresses the platform menu", async () => {
    installNativeMenuBlock();
    const host = document.createElement("div");
    document.body.appendChild(host);
    // The row lives outside the mount container (Vue's mount clears it).
    const row = document.createElement("div");
    row.setAttribute("data-player-name", "langyo");
    row.innerHTML = '<span class="nick">masked</span>';
    document.body.appendChild(row);

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/", component: { render: () => null } }],
    });
    const Root = defineComponent({
      name: "BlockerRoot",
      setup() {
        return () => (
          <HkContextMenuProvider>
            <PlayerContextMenuHost />
          </HkContextMenuProvider>
        );
      },
    });
    const app = createApp(Root);
    app.use(router);
    app.mount(host);

    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 12,
      clientY: 10,
    });
    row.querySelector(".nick")!.dispatchEvent(event);
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();

    // The app's menu opened …
    expect(document.querySelector(".hk-select-popout")).toBeTruthy();
    // … and the platform menu is suppressed.
    expect(event.defaultPrevented).toBe(true);

    app.unmount();
    host.remove();
    row.remove();
  });
});
