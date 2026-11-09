/** Layered resource-pack stack state (美化定制分层): the saved stack, the
 *  reorder/toggle/render flow and the render-report data. Split out of
 *  useModHub so the Mod Hub state machine keeps its existing shape; the
 *  catalog/installed pairing and the detail-pane selection stay there.
 *
 *  Semantics mirrored from the wire contract:
 *  - set_order persists the new top-to-bottom order and marks the stack
 *    dirty (rendered=false);
 *  - render then applies it, and the backend REFUSES while the game runs —
 *    the UI keeps the dirty state and toasts the reason;
 *  - legacy layers (managed=false) are pinned at the bottom and never
 *    reorderable. */
import { computed, ref, watch, type Ref } from "vue";
import { useToast } from "@celestia-island/hikari";

import {
  api,
  type LayerPathWinner,
  type LayerRenderReport,
  type LayerStack,
  type ModLayer,
} from "@/api";
import { requestModOpDisclaimer } from "@/features/modhub/ModOpDisclaimer";
import { t } from "@/i18n";
import { moveLayer, normalizeLayerOrder } from "./layerStackHelpers";

export type LayerMove = "top" | "up" | "down" | "bottom";

export function useLayerStack(gameRoot: Ref<string>) {
  const toast = useToast();

  const stack = ref<LayerStack | null>(null);
  const loading = ref(false);
  /** Any mutating layer RPC (order/enabled/render) in flight. */
  const busy = ref(false);
  const error = ref("");
  const report = ref<LayerRenderReport | null>(null);
  const paths = ref<LayerPathWinner[]>([]);
  const reportOpen = ref(false);
  const reportBusy = ref(false);

  // Bumped on root changes / resets; a late response from the previous root
  // must never publish into the new stack.
  let epoch = 0;

  const layers = computed(() => stack.value?.layers ?? []);
  const rendered = computed(() => stack.value?.rendered ?? true);
  const conflicts = computed(() => stack.value?.slotConflicts ?? []);

  function messageOf(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  /** Clear everything for a root switch (the caller's gameRoot watch also
   *  fires this). */
  function reset(): void {
    epoch++;
    stack.value = null;
    loading.value = false;
    busy.value = false;
    error.value = "";
    report.value = null;
    paths.value = [];
    reportOpen.value = false;
    reportBusy.value = false;
  }

  watch(gameRoot, reset, { flush: "sync" });

  function layerById(packId: string): ModLayer | null {
    return layers.value.find((layer) => layer.packId === packId) ?? null;
  }

  /** Load the stack for the active root. `silent` keeps the current stack
   *  on screen while a mutation-triggered reload lands. */
  async function refresh(silent = false): Promise<void> {
    if (!gameRoot.value) {
      stack.value = null;
      return;
    }
    const root = gameRoot.value;
    const gen = epoch;
    if (!silent) loading.value = true;
    error.value = "";
    try {
      const next = await api.modHubLayerStack(root);
      if (gen !== epoch || root !== gameRoot.value) return;
      stack.value = next;
    } catch (e) {
      if (gen !== epoch) return;
      error.value = messageOf(e);
    } finally {
      if (gen === epoch) loading.value = false;
    }
  }

  async function loadPaths(): Promise<void> {
    if (!gameRoot.value) return;
    try {
      paths.value = await api.modHubLayerPaths(gameRoot.value);
    } catch {
      paths.value = [];
    }
  }

  /** Render the saved order and reload the stack. Returns false when the
   *  render was refused (game running) — the dirty state stays. */
  async function renderNow(announce = true): Promise<boolean> {
    if (!gameRoot.value || busy.value) return false;
    busy.value = true;
    try {
      if (!(await requestModOpDisclaimer())) return false;
      const next = await api.modHubLayerRender(gameRoot.value);
      report.value = next;
      await refresh(true);
      if (announce) toast.success(t("resources.layers.applied"));
      return true;
    } catch (e) {
      const msg = messageOf(e);
      error.value = msg;
      toast.error(t("resources.layers.applyFailed", { reason: msg }));
      // The persisted order is still dirty when the render is refused —
      // reload the backend truth so the pending banner survives.
      await refresh(true);
      return false;
    } finally {
      busy.value = false;
    }
  }

  /** The pending banner's [立即应用] action. */
  async function applyNow(): Promise<void> {
    if (busy.value) return;
    await renderNow();
  }

  /** The header strip's 渲染报告 action: one idempotent render pass, then
   *  the per-path map, then the modal. */
  async function openReport(): Promise<void> {
    if (busy.value || reportBusy.value) return;
    reportBusy.value = true;
    try {
      // A clean stack's report pass changes nothing — don't claim "applied"
      // for it. A dirty stack really does apply the saved order.
      const wasDirty = !rendered.value;
      const ok = await renderNow(wasDirty);
      if (!ok) return;
      await loadPaths();
      reportOpen.value = true;
    } finally {
      reportBusy.value = false;
    }
  }

  function closeReport(): void {
    reportOpen.value = false;
  }

  /** Reorder flow: optimistic order → set_order → render. A refused render
   *  (game running) keeps rendered=false and toasts the reason. */
  async function setOrder(from: number, to: number): Promise<void> {
    if (!gameRoot.value || busy.value) return;
    busy.value = true;
    try {
      if (!(await requestModOpDisclaimer())) return;
      const current = layers.value;
      if (
        from === to ||
        from < 0 ||
        to < 0 ||
        from >= current.length ||
        to >= current.length
      ) {
        return;
      }
      const nextLayers = normalizeLayerOrder(moveLayer(current, from, to));
      const optimistic = stack.value;
      if (optimistic) {
        stack.value = { ...optimistic, layers: nextLayers, rendered: false };
      }
      const saved = await api.modHubLayerSetOrder(
        gameRoot.value,
        nextLayers.map((layer) => layer.packId),
      );
      stack.value = saved;
      try {
        const next = await api.modHubLayerRender(gameRoot.value);
        report.value = next;
        toast.success(t("resources.layers.applied"));
      } catch (e) {
        const msg = messageOf(e);
        error.value = msg;
        toast.error(t("resources.layers.applyFailed", { reason: msg }));
      }
      await refresh(true);
    } catch (e) {
      const msg = messageOf(e);
      error.value = msg;
      toast.error(t("resources.layers.applyFailed", { reason: msg }));
      await refresh(true);
    } finally {
      busy.value = false;
    }
  }

  /** Toggle one layer. The backend may already have rendered the change
   *  (rendered=true); otherwise the UI applies the render right away and
   *  keeps the dirty banner if it is refused. */
  async function setEnabled(layer: ModLayer, enabled: boolean): Promise<void> {
    if (!gameRoot.value || busy.value) return;
    busy.value = true;
    try {
      if (!(await requestModOpDisclaimer())) return;
      const next = await api.modHubLayerSetEnabled(
        gameRoot.value,
        layer.packId,
        enabled,
      );
      stack.value = next;
      if (!next.rendered) {
        try {
          const nextReport = await api.modHubLayerRender(gameRoot.value);
          report.value = nextReport;
          toast.success(t("resources.layers.applied"));
        } catch (e) {
          const msg = messageOf(e);
          error.value = msg;
          toast.error(t("resources.layers.applyFailed", { reason: msg }));
        }
      }
      await refresh(true);
    } catch (e) {
      const msg = messageOf(e);
      error.value = msg;
      toast.error(t("resources.layers.applyFailed", { reason: msg }));
      await refresh(true);
    } finally {
      busy.value = false;
    }
  }

  /** The detail pane's 置顶 / 上移 / 下移 / 置底 buttons. Legacy layers are
   *  pinned, and the destination never crosses into the legacy tail. */
  async function move(layer: ModLayer, direction: LayerMove): Promise<void> {
    if (!layer.managed || busy.value) return;
    const list = layers.value;
    const index = list.findIndex((entry) => entry.packId === layer.packId);
    if (index < 0) return;
    const lastManaged = list.filter((entry) => entry.managed).length - 1;
    let to = index;
    if (direction === "top") to = 0;
    else if (direction === "up") to = Math.max(0, index - 1);
    else if (direction === "down") to = Math.min(lastManaged, index + 1);
    else to = lastManaged;
    if (to === index || to < 0) return;
    await setOrder(index, to);
  }

  return {
    stack,
    layers,
    rendered,
    conflicts,
    loading,
    busy,
    error,
    report,
    paths,
    reportOpen,
    reportBusy,
    refresh,
    reset,
    layerById,
    loadPaths,
    renderNow,
    applyNow,
    openReport,
    closeReport,
    setOrder,
    setEnabled,
    move,
  };
}

export type LayerStackCtx = ReturnType<typeof useLayerStack>;
