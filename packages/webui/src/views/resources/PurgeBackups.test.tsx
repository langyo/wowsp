/** PurgeBackups — the launcher row + secondary window renderers, driven
 *  from a hand-built composable shape (the same pattern CrashPins uses),
 *  so no store machinery is needed beyond the hikari + i18n mocks. */
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick, ref } from "vue";

import type { PurgeBackup } from "@/api/modules/modhub";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/api", () => ({ api: {} }));
vi.mock("@celestia-island/hikari", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    // A plain button passthrough: the click handler arrives as an attr and
    // lands on the rendered element (the renderer only needs a real button).
    HkButton: defineComponent({
      name: "HkButton",
      props: ["loading", "variant", "size", "disabled"],
      setup(_, { slots, attrs }) {
        return () => h("button", attrs, slots.default?.());
      },
    }),
    // Modal passthrough that honours modelValue: closed hides the slot, so
    // the window tests can assert what the open state actually shows.
    HkModal: defineComponent({
      name: "HkModal",
      props: ["modelValue", "title", "width", "footerActions"],
      setup(props, { slots }) {
        return () =>
          props.modelValue ? h("div", { class: "modal-stub" }, slots.default?.()) : null;
      },
    }),
    HkScrollContainer: defineComponent({
      name: "HkScrollContainer",
      setup(_, { slots }) {
        return () => h("div", slots.default?.());
      },
    }),
    // Confirm dialog passthrough: open shows the message and a confirm
    // button wired to the component's onConfirm.
    HkConfirmDialog: defineComponent({
      name: "HkConfirmDialog",
      props: ["open", "title", "message", "confirmLabel", "loading"],
      emits: ["confirm", "update:open"],
      setup(props, { emit }) {
        return () =>
          props.open
            ? h("div", { class: "confirm-stub" }, [
                h("span", props.message),
                h("button", { class: "confirm-ok", onClick: () => emit("confirm") }, props.confirmLabel),
                h("button", { class: "confirm-cancel", onClick: () => emit("update:open", false) }, "x"),
              ])
            : null;
      },
    }),
    useToast: () => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }),
  };
});

import { renderPurgeBackups, renderPurgeBackupsWindow } from "./PurgeBackups";

function backup(
  dirName: string,
  stamp: number,
  hasMarker: boolean,
  done = 0,
  planned = 2,
): PurgeBackup {
  const unit = (id: string) => ({ id, name: `Mod ${id}`, preset: null });
  return {
    dirName,
    path: `C:/game/bin/1/${dirName}`,
    stamp,
    fileCount: 12,
    hasMarker,
    marker: hasMarker
      ? {
          mode: "wowsp-only",
          planned: [unit("a"), unit("b")].slice(0, planned),
          done: [unit("a"), unit("b")].slice(0, done),
          known: [],
          startedAt: "2026-10-31T12:00:00Z",
        }
      : null,
  };
}

function makePins(backups: PurgeBackup[]) {
  const pins = {
    backups: ref(backups),
    loading: ref(false),
    busyDir: ref<string | null>(null),
    deleteTarget: ref<PurgeBackup | null>(null),
    refresh: vi.fn(),
    resume: vi.fn(),
    dismiss: vi.fn(),
    restore: vi.fn(),
    askDelete: vi.fn(),
    doDelete: vi.fn(),
  };
  pins.askDelete.mockImplementation((b: PurgeBackup) => {
    pins.deleteTarget.value = b;
  });
  return pins;
}

/** One host mounting BOTH surfaces the way ResourcesView does: the
 *  collapsed launcher row (with its open callback) and the secondary
 *  window bound to an open ref. */
function host(pins: ReturnType<typeof makePins>) {
  const open = ref(false);
  const onOpen = vi.fn(() => (open.value = true));
  const onUpdate = vi.fn((v: boolean) => (open.value = v));
  const component = defineComponent({
    setup() {
      return () =>
        h("div", [
          renderPurgeBackups(pins as never, onOpen),
          renderPurgeBackupsWindow(pins as never, open.value, onUpdate),
        ]);
    },
  });
  return { component, open, onOpen, onUpdate };
}

describe("the collapsed launcher row (renderPurgeBackups)", () => {
  it("renders nothing without backups", () => {
    const wrapper = mount(host(makePins([])).component);
    expect(wrapper.find(".purge-backups").exists()).toBe(false);
  });

  it("shows the label, the count and the unfinished badge", () => {
    const pins = makePins([
      backup("res_mods.wowsp-purge-300", 300, false),
      backup("res_mods.wowsp-purge-100", 100, true, 1),
    ]);
    const wrapper = mount(host(pins).component);
    const row = wrapper.find(".purge-backups .purge-backups__row");
    expect(row.classes()).toContain("is-summary");
    expect(row.classes()).toContain("is-unfinished");
    expect(row.text()).toContain("resources.purgeBackups.launcher");
    expect(row.text()).toContain("resources.purgeBackups.count");
    expect(row.text()).toContain("resources.purgeBackups.unfinishedBadge");
  });

  it("stays quiet (no unfinished accent) when every backup completed", () => {
    const pins = makePins([backup("res_mods.wowsp-purge-300", 300, false)]);
    const wrapper = mount(host(pins).component);
    const row = wrapper.find(".purge-backups .purge-backups__row");
    expect(row.classes()).not.toContain("is-unfinished");
    expect(row.text()).not.toContain("resources.purgeBackups.unfinishedBadge");
  });

  it("opens the window on click and Enter", async () => {
    const scope = host(makePins([backup("res_mods.wowsp-purge-1", 1, false)]));
    const wrapper = mount(scope.component);
    const row = wrapper.find(".purge-backups .purge-backups__row");
    await row.trigger("click");
    expect(scope.onOpen).toHaveBeenCalledTimes(1);
    expect(scope.open.value).toBe(true);
    await row.trigger("keydown", { key: "Enter" });
    expect(scope.onOpen).toHaveBeenCalledTimes(2);
  });
});

describe("the backups window (renderPurgeBackupsWindow)", () => {
  it("shows nothing while closed and the rows once open", async () => {
    const pins = makePins([
      backup("res_mods.wowsp-purge-300", 300, false),
      backup("res_mods.wowsp-purge-100", 100, true, 1),
    ]);
    const scope = host(pins);
    const wrapper = mount(scope.component);
    expect(wrapper.find(".purge-backups--window").exists()).toBe(false);
    await wrapper.find(".purge-backups .purge-backups__row").trigger("click");
    expect(wrapper.find(".purge-backups--window").exists()).toBe(true);
    expect(wrapper.findAll(".purge-backups--window .purge-backups__row").length).toBe(2);
  });

  it("sorts the unfinished row FIRST with its warning accent and progress", () => {
    const pins = makePins([
      backup("res_mods.wowsp-purge-300", 300, false), // newest but completed
      backup("res_mods.wowsp-purge-100", 100, true, 1), // older but unfinished
    ]);
    const scope = host(pins);
    scope.open.value = true;
    const wrapper = mount(scope.component);
    const rows = wrapper.findAll(".purge-backups--window .purge-backups__row");
    expect(rows.length).toBe(2);
    expect(rows[0].classes()).toContain("is-unfinished");
    expect(rows[0].text()).toContain("res_mods.wowsp-purge-100");
    expect(rows[0].text()).toContain("resources.purgeBackups.unfinished");
    expect(rows[0].text()).toContain("resources.purgeBackups.progress");
    expect(rows[1].classes()).not.toContain("is-unfinished");
    expect(rows[1].text()).toContain("resources.purgeBackups.completed");
    // The remedy footnote rides along while anything is unfinished.
    expect(wrapper.find(".purge-backups__footnote").text()).toContain(
      "resources.purgeBackups.resumeBlocked",
    );
  });

  it("renders a corrupt marker as unreadable with dismiss as the only action", () => {
    const corrupt: PurgeBackup = {
      ...backup("res_mods.wowsp-purge-100", 100, false),
      hasMarker: true,
      marker: null, // the file exists but does not parse
    };
    const pins = makePins([corrupt]);
    const scope = host(pins);
    scope.open.value = true;
    const wrapper = mount(scope.component);
    const row = wrapper.find(".purge-backups--window .purge-backups__row");
    expect(row.classes()).toContain("is-unfinished");
    expect(row.text()).toContain("resources.purgeBackups.markerUnreadable");
    expect(row.text()).not.toContain("resources.purgeBackups.progress");
    // Resume stays hidden (the state is unknown); dismiss is the way out.
    const buttons = row.findAll("button");
    expect(buttons.length).toBe(1);
    expect(buttons[0].text()).toContain("resources.purgeBackups.dismiss");
    expect(row.text()).not.toContain("resources.purgeBackups.resume");
  });

  it("wires resume and dismiss on unfinished rows only", async () => {
    const pins = makePins([
      backup("res_mods.wowsp-purge-100", 100, true, 1),
      backup("res_mods.wowsp-purge-300", 300, false),
    ]);
    const scope = host(pins);
    scope.open.value = true;
    const wrapper = mount(scope.component);
    const rows = wrapper.findAll(".purge-backups--window .purge-backups__row");
    const unfinished = rows[0];
    const completed = rows[1];

    // Unfinished: primary resume + mark done — NO restore (the backend
    // refuses a merge-back while the marker is unresolved).
    const buttons = unfinished.findAll("button");
    expect(buttons.length).toBe(2); // resume, dismiss
    await buttons[0].trigger("click");
    expect(pins.resume).toHaveBeenCalledWith(
      expect.objectContaining({ dirName: "res_mods.wowsp-purge-100" }),
    );
    await buttons[1].trigger("click");
    expect(pins.dismiss).toHaveBeenCalledTimes(1);
    expect(unfinished.text()).not.toContain("resources.purgeBackups.restore");

    // Completed: restore + delete, never resume or dismiss.
    const doneButtons = completed.findAll("button");
    expect(doneButtons.length).toBe(2);
    await doneButtons[0].trigger("click");
    expect(pins.restore).toHaveBeenCalledWith(
      expect.objectContaining({ dirName: "res_mods.wowsp-purge-300" }),
    );
    await doneButtons[1].trigger("click");
    expect(pins.askDelete).toHaveBeenCalledWith(
      expect.objectContaining({ dirName: "res_mods.wowsp-purge-300" }),
    );
  });

  it("confirms a delete before it runs and can cancel it", async () => {
    const pins = makePins([backup("res_mods.wowsp-purge-300", 300, false)]);
    const scope = host(pins);
    scope.open.value = true;
    const wrapper = mount(scope.component);
    expect(wrapper.find(".confirm-stub").exists()).toBe(false);
    const completed = wrapper.findAll(
      ".purge-backups--window .purge-backups__row",
    )[0];
    await completed.findAll("button")[1].trigger("click"); // delete
    expect(pins.deleteTarget.value?.dirName).toBe("res_mods.wowsp-purge-300");
    const dialog = wrapper.find(".confirm-stub");
    expect(dialog.exists()).toBe(true);
    // The i18n mock returns keys verbatim, so the dialog is asserted on
    // its message KEY (the real t() interpolates name/count into it).
    expect(dialog.text()).toContain("resources.purgeBackups.confirmDelete");

    // Cancel closes without deleting; confirm runs doDelete and closes.
    await dialog.find(".confirm-cancel").trigger("click");
    expect(pins.deleteTarget.value).toBeNull();
    expect(pins.doDelete).not.toHaveBeenCalled();
    pins.askDelete(pins.backups.value[0]);
    await nextTick();
    await wrapper.find(".confirm-stub .confirm-ok").trigger("click");
    expect(pins.doDelete).toHaveBeenCalledTimes(1);
  });
});
