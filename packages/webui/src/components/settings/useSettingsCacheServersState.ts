/** Cache-servers-section state for SettingsBody (设置 → 缓存服务器,
 *  docs/en/designs/cache-mesh.md §6.3): the master toggle, the ordered
 *  server ladder (official node pinned first, user rows add / remove /
 *  drag-reorder / probe), the autodiscover toggle + discover-now preview,
 *  all persisted through the network config's stats-cache fields. */
import { computed, ref } from "vue";

import { useToast } from "@celestia-island/hikari";

import {
  api,
  OFFICIAL_CACHE_SERVER,
  type NetworkConfig,
  type StatsCacheProbeRow,
} from "@/api";
import { t } from "@/i18n";
import { notifySettingsSaved } from "@/stores/settingsSavedFlash";

/** The loopback plain-http exception the Rust sanitize holds (§6.1): a LAN
 *  node on http://127.0.0.1:<port> (or localhost) is a first-class citizen
 *  — §5.3 private fleets add the node directly. */
const LOOPBACK_HTTP_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/i;

/** Whether a draft root passes the add-row gate (https, or loopback http). */
export function isAcceptableServerRoot(raw: string): boolean {
  return raw.startsWith("https://") || LOOPBACK_HTTP_RE.test(raw);
}

/** Normalize a draft root the way the shell's sanitize will: trim, fold
 * trailing slashes. */
export function normalizeDraftServerRoot(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/** One display row of the server ladder. */
export interface CacheServerListRow {
  url: string;
  kind: "official" | "user";
}

export function useSettingsCacheServersState() {
  const toast = useToast();

  // ── config snapshot ───────────────────────────────────────────────────
  // Defaults mirror the Rust serde defaults (§6.1): mesh on, official node
  // in the ladder, autodiscover on — so the pane renders sanely before the
  // first load answers (browser dev / older shell without the fields).
  const enabled = ref(true);
  const servers = ref<string[]>([OFFICIAL_CACHE_SERVER]);
  const autodiscover = ref(true);
  /** True while an add/remove/reorder/toggle save is in flight — a second
   *  click would re-read the config before the first save's response
   *  lands and drop its change. */
  const saving = ref(false);

  /** The official root as spelled in the saved list (trailing-slash
   *  variants fold together); null when a hand-edited config dropped it. */
  const officialUrl = computed(
    () => servers.value.find((s) => normalizeDraftServerRoot(s) === OFFICIAL_CACHE_SERVER) ?? null,
  );
  /** The user-managed rows: every saved entry except the official root. */
  const userServers = computed(() =>
    servers.value.filter((s) => normalizeDraftServerRoot(s) !== OFFICIAL_CACHE_SERVER),
  );
  /** Display rows: official pinned first (always shown, not removable —
   *  with its configured spelling when the list carries one), then the
   *  user rows in saved order. */
  const rows = computed<CacheServerListRow[]>(() => [
    { url: officialUrl.value ?? OFFICIAL_CACHE_SERVER, kind: "official" as const },
    ...userServers.value.map((url) => ({ url, kind: "user" as const })),
  ]);

  /** The last config the shell answered (the persist round-trip's spread
   *  base — a failed re-read falls back to it instead of wiping
   *  unrelated fields like the mirror list). */
  let lastBase: NetworkConfig | null = null;

  /** Load the config slice (idempotent — the section activation watcher
   *  and the pane's own saves both re-sync through it). */
  async function load() {
    try {
      const cfg = await api.getNetworkConfig();
      lastBase = cfg;
      enabled.value = cfg.statsCacheEnabled ?? true;
      // A MISSING field falls back to the official default; an explicitly
      // EMPTIED ladder (the hand-edited mesh-less config the shell keeps
      // durable) loads as empty — the pane still pins the official row for
      // display, but a later save must not silently resurrect the root.
      servers.value = cfg.statsCacheServers ?? [OFFICIAL_CACHE_SERVER];
      autodiscover.value = cfg.statsPeerAutodiscover ?? true;
    } catch {
      // mock backend / older shell without the fields — keep defaults
    }
  }

  /** Persist a slice of the stats-cache config, spreading the rest of the
   *  network config back so unrelated fields survive the round-trip
   *  (the saveMirrors pattern), and adopt the SANITIZED echo — the shell
   *  may correct the list (invalid root dropped, bare host → https). */
  async function persist(patch: {
    enabled?: boolean;
    servers?: string[];
    autodiscover?: boolean;
  }): Promise<boolean> {
    if (saving.value) return false;
    saving.value = true;
    const intended = {
      enabled: patch.enabled ?? enabled.value,
      servers: patch.servers ?? servers.value,
      autodiscover: patch.autodiscover ?? autodiscover.value,
    };
    try {
      let base: NetworkConfig;
      try {
        base = await api.getNetworkConfig();
        lastBase = base;
      } catch {
        base = lastBase ?? { mode: "system", proxy: null, resourceCdn: null };
      }
      const next: NetworkConfig = {
        ...base,
        statsCacheEnabled: intended.enabled,
        statsCacheServers: intended.servers,
        statsPeerAutodiscover: intended.autodiscover,
      };
      // Read-only provenance fields the shell computes — never send back.
      delete next.effectiveProxy;
      delete next.proxySource;
      const saved = await api.setNetworkConfig(next);
      // Adopt the sanitized echo where present; a backend without the
      // fields (mock / older shell) keeps what we intended.
      enabled.value = saved?.statsCacheEnabled ?? intended.enabled;
      servers.value =
        saved?.statsCacheServers && saved.statsCacheServers.length > 0
          ? saved.statsCacheServers
          : intended.servers;
      autodiscover.value = saved?.statsPeerAutodiscover ?? intended.autodiscover;
      notifySettingsSaved();
      return true;
    } catch (e) {
      toast.error(
        t("cacheServers.saveFailed", {
          message: e instanceof Error ? e.message : String(e),
        }),
      );
      return false;
    } finally {
      saving.value = false;
    }
  }

  async function setEnabled(value: boolean) {
    if (enabled.value === value) return;
    await persist({ enabled: value });
  }

  async function setAutodiscover(value: boolean) {
    if (autodiscover.value === value) return;
    await persist({ autodiscover: value });
  }

  // ── ladder edits ──────────────────────────────────────────────────────
  /** The add-row input draft. */
  const newServerDraft = ref("");
  /** Two-step remove confirm (url of the armed user row). */
  const removeArmed = ref<string | null>(null);

  /** The next full ladder for a user-rows change: official pinned first
   *  (restoring it if a hand edit dropped it), then the user rows. */
  function ladderWith(userList: string[]): string[] {
    return [OFFICIAL_CACHE_SERVER, ...userList];
  }

  /** Add a server root: trimmed, https-gated (loopback http tolerated),
   *  deduped against the whole ladder, persisted. A duplicate just clears
   *  the draft (the updates-section convention). */
  async function addServer(raw: string) {
    if (saving.value) return;
    const url = normalizeDraftServerRoot(raw);
    if (!isAcceptableServerRoot(url)) {
      toast.warning(t("cacheServers.addInvalid"));
      return;
    }
    if (rows.value.some((row) => normalizeDraftServerRoot(row.url) === url)) {
      newServerDraft.value = "";
      return;
    }
    const ok = await persist({ servers: ladderWith([...userServers.value, url]) });
    if (ok) newServerDraft.value = "";
  }

  /** Remove one user row (the official row is never removable — the
   *  section only renders the control on user rows). */
  async function removeServer(url: string) {
    if (saving.value) return;
    if (normalizeDraftServerRoot(url) === OFFICIAL_CACHE_SERVER) return;
    const ok = await persist({
      servers: ladderWith(userServers.value.filter((s) => s !== url)),
    });
    if (ok) {
      removeArmed.value = null;
      const next = { ...probeState.value };
      delete next[url];
      probeState.value = next;
    }
  }

  /** Drag-reorder within the user rows (indexes are positions inside the
   *  user-rows list, exactly what HkDraggableList reports). */
  async function reorderUser(from: number, to: number) {
    const list = [...userServers.value];
    if (from < 0 || from >= list.length || to < 0 || to >= list.length) return;
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    await persist({ servers: ladderWith(list) });
  }

  // ── probe (§6.3) ──────────────────────────────────────────────────────
  // probeState holds one entry per visible row url: "testing" while the
  // probe call is in flight, the backend's row afterwards; absent = never
  // probed. A refused probe (older shell) drops the pending marks so rows
  // fall back to "untested" instead of spinning forever.
  const probing = ref(false);
  const probeState = ref<Record<string, StatsCacheProbeRow | "testing">>({});

  /** Probe every visible row once (the header's 测试全部 and the section
   *  activation watcher both land here). */
  async function testAll() {
    if (probing.value) return;
    const visible = rows.value.map((row) => row.url);
    if (visible.length === 0) return;
    probing.value = true;
    const pending: Record<string, StatsCacheProbeRow | "testing"> = {};
    for (const url of visible) pending[url] = "testing";
    probeState.value = pending;
    try {
      const folded = { ...pending };
      for (const row of await api.statsCacheProbe(visible)) folded[row.url] = row;
      probeState.value = folded;
    } catch {
      probeState.value = {};
    } finally {
      probing.value = false;
    }
  }

  // ── autodiscover preview (§6.1) ───────────────────────────────────────
  const discovering = ref(false);
  /** Verified community roots of the last discover-now walk (list-only
   *  preview — nothing is auto-added; null before the first walk). */
  const discoveredUrls = ref<string[] | null>(null);

  async function discoverNow() {
    if (discovering.value) return;
    discovering.value = true;
    try {
      discoveredUrls.value = await api.statsCacheAutodiscover();
    } catch (e) {
      toast.error(
        t("cacheServers.discoverFailed", {
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      discovering.value = false;
    }
  }

  return {
    enabled,
    autodiscover,
    servers,
    rows,
    userServers,
    saving,
    newServerDraft,
    removeArmed,
    probing,
    probeState,
    discovering,
    discoveredUrls,
    load,
    persist,
    setEnabled,
    setAutodiscover,
    addServer,
    removeServer,
    reorderUser,
    testAll,
    discoverNow,
  };
}
