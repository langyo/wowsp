/**
 * Tests for ToastCardBase — the single card primitive behind the shell's
 * six bespoke top-right toasts. These pin the base's own contract: the
 * enter/--leave machine (delayed unmount, its window read off the
 * --duration-normal token with a 260 ms fallback), the wrappers'
 * auto-dismiss shape, the quiet × affordance, the action pills (kinds,
 * legacy hook class, disabled), and the foot row that houses the meta
 * readout (prop or slot) left of the action area — out of the headline
 * row. Per-card store wiring stays in the cards' own suites
 * (UpdateAppliedToast / DownloadToast pin theirs, unchanged).
 */
import { defineComponent, nextTick, onBeforeUnmount, onMounted, ref, type PropType } from "vue";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";

import { initLocaleMessages, t } from "@/i18n";
import ToastCardBase, { type ToastCardBaseInstance } from "./ToastCardBase";

enableAutoUnmount(afterEach);

// The quiet × carries a localized aria-label; the bundle loads lazily, so
// it must be in place before the first mount asserts on it.
beforeAll(async () => {
  await initLocaleMessages();
});

const CARD = ".toast-card-under-test";
const LEAVE_CLASS = "toast-card-under-test--leave";

/** Clicks the harness's action pills recorded, reset per test. */
const clicks: string[] = [];

/** Harness mirroring the per-card wrappers: raise on demand, optional
 *  auto-dismiss timer, every slot the base offers. */
const Harness = defineComponent({
  name: "ToastCardHarness",
  props: {
    role: { type: String as PropType<"status" | "alert">, default: "status" },
    /** >0 arms an auto-dismiss timer — the wrappers' shape. */
    autoDismissMs: { type: Number, default: 0 },
    /** Serve the meta through the slot — pins the slot's override of
     *  the meta prop. */
    metaSlot: { type: Boolean, default: false },
    /** Append a kind:"close" action — the icon × cancel grammar. */
    closeAction: { type: Boolean, default: false },
  },
  setup(props, { expose }) {
    const card = ref<ToastCardBaseInstance | null>(null);
    let autoTimer: number | undefined;

    function dismiss() {
      if (autoTimer !== undefined) {
        window.clearTimeout(autoTimer);
        autoTimer = undefined;
      }
      card.value?.dismiss();
    }

    function raise() {
      card.value?.show();
      if (props.autoDismissMs > 0) {
        if (autoTimer !== undefined) window.clearTimeout(autoTimer);
        autoTimer = window.setTimeout(dismiss, props.autoDismissMs);
      }
    }

    expose({ raise, dismiss });

    onBeforeUnmount(() => {
      if (autoTimer !== undefined) window.clearTimeout(autoTimer);
    });

    return () => (
      <ToastCardBase
        ref={card}
        tone="success"
        rootClass="toast-card-under-test"
        role={props.role}
        message="Base card under test"
        bold
        meta="42%"
        close
        onClose={dismiss}
        actions={[
          {
            label: "Do it",
            kind: "primary",
            class: "under-test__primary",
            onClick: () => clicks.push("primary"),
          },
          {
            label: "Skip",
            kind: "outline",
            disabled: true,
            onClick: () => clicks.push("outline"),
          },
          ...(props.closeAction
            ? [{ label: "Abort", kind: "close" as const, onClick: () => clicks.push("close") }]
            : []),
        ]}
      >
        {{
          icon: () => <span class="under-test__icon">◎</span>,
          ...(props.metaSlot ? { meta: () => <span class="under-test__meta-slot">7%</span> } : {}),
          trailing: () => <span class="under-test__trailing">trail</span>,
          progress: () => (
            <div class="toast-card__track">
              <div class="toast-card__fill" style={{ width: "40%" }} />
            </div>
          ),
        }}
      </ToastCardBase>
    );
  },
});

type HarnessVm = { raise(): void; dismiss(): void };

function mountHarness(props: { role?: "status" | "alert"; autoDismissMs?: number; metaSlot?: boolean; closeAction?: boolean } = {}) {
  return mount(Harness, { props });
}

/** expose() doesn't flow into the inferred instance type — the harness's
 *  drive-in surface is exactly these two calls. */
function vm(wrapper: ReturnType<typeof mountHarness>): HarnessVm {
  return wrapper.vm as unknown as HarnessVm;
}

function card(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(CARD);
}

beforeEach(() => {
  clicks.length = 0;
  vi.useFakeTimers();
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ToastCardBase", () => {
  it("raises on show() and folds out through --leave after the fallback leave window", async () => {
    const wrapper = mountHarness();
    expect(card()).toBeNull();

    vm(wrapper).raise();
    await nextTick();
    const el = card();
    expect(el).not.toBeNull();
    expect(el?.classList).toContain("toast-card--success");
    expect(el?.getAttribute("role")).toBe("status");
    expect(el?.classList).not.toContain(LEAVE_CLASS);

    vm(wrapper).dismiss();
    await nextTick();
    // Delayed unmount: still in the DOM, folded to the leave modifier.
    expect(card()).not.toBeNull();
    expect(card()?.classList).toContain(LEAVE_CLASS);

    // The fallback window (no theme sheet in the test env) is 260 ms.
    await vi.advanceTimersByTimeAsync(259);
    expect(card()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(card()).toBeNull();

    // A late dismiss on the unmounted card is a harmless no-op.
    vm(wrapper).dismiss();
    await nextTick();
    expect(card()).toBeNull();
  });

  it("restores a card that re-raises mid-leave instead of snapping out", async () => {
    const wrapper = mountHarness();
    vm(wrapper).raise();
    await nextTick();
    vm(wrapper).dismiss();
    await nextTick();
    expect(card()?.classList).toContain(LEAVE_CLASS);

    // A restart inside the leave window cancels the pending unmount.
    vm(wrapper).raise();
    await nextTick();
    expect(card()).not.toBeNull();
    expect(card()?.classList).not.toContain(LEAVE_CLASS);
    await vi.advanceTimersByTimeAsync(260);
    expect(card()).not.toBeNull();
  });

  it("auto-dismisses through the wrapper's armed timer", async () => {
    const wrapper = mountHarness({ autoDismissMs: 1000 });
    vm(wrapper).raise();
    await nextTick();
    expect(card()).not.toBeNull();

    await vi.advanceTimersByTimeAsync(999);
    expect(card()).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    expect(card()?.classList).toContain(LEAVE_CLASS);

    await vi.advanceTimersByTimeAsync(260);
    expect(card()).toBeNull();
  });

  it("folds through the quiet × close affordance", async () => {
    const wrapper = mountHarness();
    vm(wrapper).raise();
    await nextTick();

    const close = card()?.querySelector<HTMLElement>(".toast-card__close");
    expect(close).not.toBeNull();
    expect(close?.getAttribute("aria-label")).toBe(t("common.close"));
    close?.click();
    await nextTick();
    expect(card()?.classList).toContain(LEAVE_CLASS);
    await vi.advanceTimersByTimeAsync(260);
    expect(card()).toBeNull();
  });

  it("renders the action pills with their kinds, legacy hook and disabled state", async () => {
    const wrapper = mountHarness();
    vm(wrapper).raise();
    await nextTick();

    const primary = card()?.querySelector<HTMLElement>(".under-test__primary");
    const outline = card()?.querySelector<HTMLElement>(".toast-card__action--outline");
    expect(primary).not.toBeNull();
    expect(primary?.classList).toContain("toast-card__action--primary");
    expect(outline?.hasAttribute("disabled")).toBe(true);

    primary?.click();
    expect(clicks).toEqual(["primary"]);
    outline?.click();
    expect(clicks).toEqual(["primary"]); // disabled → no click lands
  });

  it("serves the meta readout, icon/trailing slots and the progress region", async () => {
    const wrapper = mountHarness();
    vm(wrapper).raise();
    await nextTick();

    const el = card();
    expect(el?.querySelector(".under-test__icon")).not.toBeNull();
    expect(el?.querySelector(".toast-card__meta")?.textContent).toBe("42%");
    // The legacy hook class rides along for the per-card parity suites.
    expect(el?.querySelector(".toast-card-under-test__meta")).not.toBeNull();
    expect(el?.querySelector(".under-test__trailing")).not.toBeNull();
    const fill = el?.querySelector<HTMLElement>(".toast-card__fill");
    expect(fill).not.toBeNull();
    expect(fill?.style.width).toBe("40%");
  });

  it("houses the meta readout in the foot row, out of the headline row", async () => {
    const wrapper = mountHarness();
    vm(wrapper).raise();
    await nextTick();

    const el = card();
    const foot = el?.querySelector<HTMLElement>(".toast-card__foot");
    expect(foot).not.toBeNull();
    const meta = el?.querySelector<HTMLElement>(".toast-card__meta");
    expect(meta?.textContent).toBe("42%");
    expect(foot?.contains(meta ?? null)).toBe(true);
    // The headline row no longer carries the readout — its whole line
    // is free to ellipsize.
    expect(el?.querySelector(".toast-card__row")?.contains(meta ?? null)).toBe(false);
    // The foot sits between the body and the progress slot (DOM order).
    expect(foot!.compareDocumentPosition(el!.querySelector(".toast-card__track")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders no foot row when neither meta nor actions exist", async () => {
    const Bare = defineComponent({
      name: "BareToastCard",
      setup() {
        const bare = ref<ToastCardBaseInstance | null>(null);
        onMounted(() => bare.value?.show());
        return () => <ToastCardBase ref={bare} rootClass="toast-card-bare" message="bare" />;
      },
    });
    mount(Bare);
    await nextTick();

    const el = document.body.querySelector<HTMLElement>(".toast-card-bare");
    expect(el).not.toBeNull();
    expect(el?.querySelector(".toast-card__foot")).toBeNull();
    expect(el?.querySelector(".toast-card__actions")).toBeNull();
  });

  it("renders a kind \"close\" action as the icon × inside the actions row", async () => {
    const wrapper = mountHarness({ closeAction: true });
    vm(wrapper).raise();
    await nextTick();

    const el = card();
    const actions = el?.querySelector<HTMLElement>(".toast-card__actions");
    expect(actions).not.toBeNull();
    const x = actions?.querySelector<HTMLElement>(".toast-card__close");
    expect(x).not.toBeNull();
    // The old visible label survives as the accessible name + the
    // delegated data-hint tooltip (native title= is policy-fenced).
    expect(x?.getAttribute("aria-label")).toBe("Abort");
    expect(x?.getAttribute("data-hint")).toBe("Abort");
    // The headline's quiet × (the boolean prop) is a different element
    // in the row — the action × did not replace it.
    expect(el?.querySelector(".toast-card__row .toast-card__close")).not.toBeNull();
    x?.click();
    expect(clicks).toEqual(["close"]);
  });

  it("lets the meta slot override the meta prop for a dynamic readout", async () => {
    const wrapper = mountHarness({ metaSlot: true });
    vm(wrapper).raise();
    await nextTick();

    // The slot's content wins over the "42%" prop, still inside the
    // legacy meta class pair.
    const meta = card()?.querySelector<HTMLElement>(".toast-card__meta");
    expect(meta?.textContent).toBe("7%");
    expect(meta?.querySelector(".under-test__meta-slot")).not.toBeNull();
  });

  it("carries the assertive role for alert cards", async () => {
    const wrapper = mountHarness({ role: "alert" });
    vm(wrapper).raise();
    await nextTick();
    expect(card()?.getAttribute("role")).toBe("alert");
  });

  it("reads the leave window off --duration-normal (s/ms parse)", async () => {
    const spy = vi
      .spyOn(window, "getComputedStyle")
      .mockReturnValue({ getPropertyValue: () => "0.04s" } as unknown as CSSStyleDeclaration);
    const wrapper = mountHarness();
    spy.mockRestore();

    vm(wrapper).raise();
    await nextTick();
    vm(wrapper).dismiss();
    await nextTick();
    await vi.advanceTimersByTimeAsync(39);
    expect(card()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(card()).toBeNull();
  });
});
