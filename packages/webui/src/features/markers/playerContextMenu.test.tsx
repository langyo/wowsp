/** Player context menu — the delegation resolver and the request
 *  builder: attr resolution (closest + AI filter + inner-binding
 *  deferral), the standard action items, and the marker tag strip the
 *  header pins above them (toggle round-trips against the store). */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { HkContextMenuProvider } from "@celestia-island/hikari";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@/transport", () => ({ transport: { invoke: mocks.invoke } }));

import { RPC } from "@/rpc";
import { useMarkersStore } from "@/stores/markers";
import {
  PlayerContextMenuHost,
  buildPlayerContextMenuRequest,
  playerFromPoint,
  type PlayerMenuDeps,
} from "./playerContextMenu";

function point(target: EventTarget | null, opts: { defaultPrevented?: boolean } = {}) {
  return { x: 5, y: 6, kind: "pointer" as const, target, ...opts };
}

/** A fake player row (the delegation contract's carrier). */
function makeRow(nickname: string, account?: string, realm?: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML =
    `<span class="nick" data-player-name="${nickname}"` +
    (account ? ` data-player-account="${account}"` : "") +
    (realm ? ` data-player-realm="${realm}"` : "") +
    ">x</span>";
  document.body.appendChild(host);
  return host.firstElementChild as HTMLElement;
}

beforeEach(() => {
  setActivePinia(createPinia());
  mocks.invoke.mockReset();
});

afterEach(() => {
  document.querySelectorAll(".nick").forEach((el) => el.closest("div")?.remove());
  document
    .querySelectorAll(".hk-select-popout, .hk-select-sheet-panel, .hk-select-sheet-scrim")
    .forEach((el) => el.remove());
  window.history.replaceState(null, "");
});

describe("playerFromPoint", () => {
  it("resolves the closest player row with account and realm", () => {
    const nick = makeRow("langyo", "2035526744", "eu");
    expect(playerFromPoint(point(nick))).toEqual({
      nickname: "langyo",
      accountId: 2035526744,
      realm: "eu",
    });
    // A descendant resolves through closest() — right-clicks land on the
    // masked display spans inside the row, not the attr carrier itself.
    const inner = document.createElement("em");
    nick.appendChild(inner);
    expect(playerFromPoint(point(inner))?.nickname).toBe("langyo");
  });

  it("drops AI/scripted names and non-player targets", () => {
    expect(playerFromPoint(point(makeRow(":Pohl:")))).toBeNull();
    const plain = document.createElement("div");
    document.body.appendChild(plain);
    expect(playerFromPoint(point(plain))).toBeNull();
    plain.remove();
  });

  it("steps aside when an inner binding already claimed the event", () => {
    expect(playerFromPoint(point(makeRow("langyo"), { defaultPrevented: true }))).toBeNull();
  });

  it("tolerates a malformed account attr", () => {
    const nick = makeRow("langyo", "not-a-number");
    expect(playerFromPoint(point(nick))?.accountId).toBeNull();
  });
});

describe("buildPlayerContextMenuRequest", () => {
  function makeDeps(): PlayerMenuDeps {
    return {
      markers: useMarkersStore(),
      openLookup: vi.fn(),
      copyName: vi.fn(),
    };
  }

  it("returns null without a player row", () => {
    const plain = document.createElement("div");
    document.body.appendChild(plain);
    expect(buildPlayerContextMenuRequest(point(plain), makeDeps())).toBeNull();
    plain.remove();
  });

  it("builds the standard menu with the tag strip pinned above", async () => {
    mocks.invoke.mockImplementation((cmd: string) =>
      cmd === RPC.markers_list
        ? Promise.resolve([
            { nickname: "langyo", color: "red", note: null, accountId: 1, createdAt: 1 },
          ])
        : Promise.resolve([]),
    );
    const deps = makeDeps();
    await deps.markers.ensureLoaded();

    const nick = makeRow("langyo", "1", "eu");
    const req = buildPlayerContextMenuRequest(point(nick), deps)!;
    expect(req.title).toBe("langyo");
    expect(req.items.map((i) => i.key)).toEqual(["lookup", "copy"]);

    // Render the header region: three dots, the stored color applied.
    const host = document.createElement("div");
    document.body.appendChild(host);
    createApp(
      defineComponent({
        render: () => h("div", [req.header!()]),
      }),
    ).mount(host);
    const dots = Array.from(host.querySelectorAll(".hk-tag-dot")) as HTMLButtonElement[];
    expect(dots).toHaveLength(3);
    expect(dots.filter((b) => b.hasAttribute("data-active"))).toHaveLength(1);

    // Toggle round-trip: clicking another color re-marks (upsert by
    // nickname, account id sharpens)…
    mocks.invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
      Promise.resolve(
        cmd === RPC.markers_add
          ? [{ nickname: "langyo", color: args?.color, note: null, accountId: 1, createdAt: 2 }]
          : [],
      ),
    );
    dots[1].click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.invoke).toHaveBeenCalledWith(
      RPC.markers_add,
      expect.objectContaining({ nickname: "langyo", color: "yellow", accountId: 1 }),
    );

    // …and the actions route through the deps.
    req.onSelect?.("lookup", req.items[0]);
    expect(deps.openLookup).toHaveBeenCalledWith("langyo", "eu");
    req.onSelect?.("copy", req.items[1]);
    expect(deps.copyName).toHaveBeenCalledWith("langyo");
    host.remove();
  });

  it("unmarks when the ACTIVE color's dot is toggled", async () => {
    mocks.invoke.mockImplementation((cmd: string) =>
      cmd === RPC.markers_list
        ? Promise.resolve([
            { nickname: "langyo", color: "purple", note: null, accountId: 1, createdAt: 1 },
          ])
        : Promise.resolve([]),
    );
    const deps = makeDeps();
    await deps.markers.ensureLoaded();

    const nick = makeRow("langyo", "1");
    const req = buildPlayerContextMenuRequest(point(nick), deps)!;
    const host = document.createElement("div");
    document.body.appendChild(host);
    createApp(
      defineComponent({
        render: () => h("div", [req.header!()]),
      }),
    ).mount(host);
    const active = host.querySelector(".hk-tag-dot[data-active]") as HTMLButtonElement;
    expect(active.getAttribute("aria-pressed")).toBe("true");
    active.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.invoke).toHaveBeenCalledWith(
      RPC.markers_remove,
      expect.objectContaining({ nickname: "langyo" }),
    );
    host.remove();
  });

  it("dismissing a CLOUD row rides cloudDismiss, not markers_remove", async () => {
    mocks.invoke.mockImplementation((cmd: string) =>
      cmd === RPC.markers_list
        ? Promise.resolve([
            {
              nickname: "CheaterCN",
              color: "yellow",
              note: null,
              accountId: 77,
              createdAt: 1,
              source: "cloud",
            },
          ])
        : Promise.resolve([]),
    );
    const cloudDismiss = vi.fn().mockResolvedValue(undefined);
    const deps: PlayerMenuDeps = {
      markers: useMarkersStore(),
      openLookup: vi.fn(),
      copyName: vi.fn(),
      cloudDismiss,
    };
    await deps.markers.ensureLoaded();

    const nick = makeRow("CheaterCN", "77");
    const req = buildPlayerContextMenuRequest(point(nick), deps)!;
    const host = document.createElement("div");
    document.body.appendChild(host);
    createApp(
      defineComponent({
        render: () => h("div", [req.header!()]),
      }),
    ).mount(host);

    // Same-color click on the cloud row = the local false-positive
    // verdict: dismiss, never a markers_remove. (The ACTIVE dot is the
    // yellow one by construction — the store's cloud row is yellow.)
    const active = host.querySelector(".hk-tag-dot[data-active]") as HTMLButtonElement;
    active.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cloudDismiss).toHaveBeenCalledWith(77, true);
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      RPC.markers_remove,
      expect.anything(),
    );

    // Another color = the user's own LOCAL marker (which then shadows the
    // cloud row in the merged view) — an ordinary markers_add.
    mocks.invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
      Promise.resolve(
        cmd === RPC.markers_add
          ? [{ nickname: "CheaterCN", color: args?.color, note: null, accountId: 77, createdAt: 2 }]
          : [],
      ),
    );
    const red = Array.from(host.querySelectorAll(".hk-tag-dot")).find(
      (b) => !(b as HTMLButtonElement).hasAttribute("data-active"),
    ) as HTMLButtonElement;
    red.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.invoke).toHaveBeenCalledWith(
      RPC.markers_add,
      expect.objectContaining({ nickname: "CheaterCN", color: "red", accountId: 77 }),
    );
    host.remove();
  });
});

/** End-to-end regression: the host must reach the REAL provider API.
 *  The menu binding lives in App's provider CHILD (Vue injects only
 *  from ancestors — an App-setup call got hikari's no-op fallback and
 *  silently swallowed every right-click; this pins that wiring). */
describe("PlayerContextMenuHost — mounted through a real provider", () => {
  it("opens the menu on a right-click over a player row", async () => {
    mocks.invoke.mockImplementation((cmd: string) =>
      cmd === RPC.markers_list ? Promise.resolve([]) : Promise.resolve([]),
    );
    const host = document.createElement("div");
    document.body.appendChild(host);
    // The player row lives OUTSIDE the mount container — Vue's mount
    // clears the container's children, which would detach the row and
    // silently break event bubbling.
    const row = document.createElement("div");
    row.setAttribute("data-player-name", "langyo");
    row.setAttribute("data-player-account", "42");
    row.setAttribute("data-player-realm", "eu");
    row.innerHTML = '<span class="nick">masked</span>';
    document.body.appendChild(row);

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/", component: { render: () => null } }],
    });
    const Root = defineComponent({
      name: "ProviderRoot",
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

    row
      .querySelector(".nick")!
      .dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
      );
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();

    // The provider's real menu opened at the pointer: popout with the
    // tag strip above the standard rows, titled by the raw nickname.
    const popout = document.querySelector(".hk-select-popout");
    expect(popout).toBeTruthy();
    expect(popout!.querySelectorAll(".hk-tag-dot")).toHaveLength(3);
    const labels = Array.from(popout!.querySelectorAll(".hk-menu-row")).map(
      (r) => r.textContent,
    );
    expect(labels).toHaveLength(2);
    app.unmount();
    host.remove();
    row.remove();
  });
});
