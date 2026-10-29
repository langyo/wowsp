/**
 * Server-applicability vocabulary of the mod hub — WHICH game servers a
 * catalog entry applies to (mirrors the REALMS constant of
 * wowsp_tauri_shared::contribution; the backend teammate owns the Rust
 * side, this module is the webui's pure-function half).
 *
 * Semantics of `entry.servers`: absent/empty — or all five codes at
 * once — means the entry is UNIVERSAL (applies on every server);
 * otherwise only the listed realms apply. One or two realms read as an
 * EXCLUSIVE (专属) entry, three or four as a PARTIAL (部分服务器) one —
 * the compressed badge wording the detail pane shows. Everything here is
 * pure and i18n-free (labels live in views/resources/display.ts) so
 * servers.test.ts can assert the classification directly.
 */
import type { CatalogEntry, GameInstall } from "@/api";

/** The five canonical realm codes, in display order. */
export const SERVER_REALMS = ["ru", "eu", "na", "asia", "cn"] as const;

/** One canonical realm code. */
export type ServerRealm = (typeof SERVER_REALMS)[number];

/** The realm a game install belongs to: the resolved `realm` field
 *  first, else the kind's home server — both Chinese clients (360 /
 *  Kongzhong) are 国服 ("cn"), Lesta's build is the RU cluster, and every
 *  other kind (wargaming / steam / manual) leaves the realm UNKNOWN
 *  (null): those launchers install every region's client, so the folder
 *  alone says nothing. A null realm must never filter (see
 *  appliesToRealm). */
export function realmOfInstall(install: GameInstall | null | undefined): string | null {
  if (install?.realm) return install.realm;
  switch (install?.kind) {
    case "cn360":
    case "cnKongzhong":
      return "cn";
    case "lesta":
      return "ru";
    default:
      return null;
  }
}

/** The applicable realm list of a `servers` field, normalized: unknown
 *  codes dropped, duplicates merged, canonical order restored. Universal
 *  (absent/empty/all five — and the fully-unknown degenerate case) folds
 *  to all five codes, so callers always receive a concrete list to
 *  render. */
export function applicableRealms(servers?: string[] | null): ServerRealm[] {
  const wanted = new Set(
    (servers ?? []).filter((s): s is ServerRealm =>
      (SERVER_REALMS as readonly string[]).includes(s),
    ),
  );
  if (wanted.size === 0 || wanted.size === SERVER_REALMS.length) {
    return [...SERVER_REALMS];
  }
  return SERVER_REALMS.filter((r) => wanted.has(r));
}

/** Whether a catalog entry applies on a realm. Universal entries always
 *  apply; an UNKNOWN realm (null — launcher installs whose region never
 *  resolved, or a code this bundled vocabulary predates) never filters,
 *  so an ambiguous client sees everything rather than an over-filtered
 *  list. */
export function appliesToRealm(entry: CatalogEntry, realm: string | null): boolean {
  if (realm == null || !(SERVER_REALMS as readonly string[]).includes(realm)) {
    return true;
  }
  return applicableRealms(entry.servers).includes(realm as ServerRealm);
}

/** The compressed scope a `servers` field reads as — the detail pane's
 *  one-badge summary: universal (通用), partial (部分服务器, 3-4 realms)
 *  or exclusive (专属, 1-2 realms). Counting is over the NORMALIZED list,
 *  so unknown codes and duplicates never inflate the bucket. */
export function serverScopeOf(
  servers?: string[] | null,
): "universal" | "partial" | "exclusive" {
  const n = applicableRealms(servers).length;
  if (n === SERVER_REALMS.length) return "universal";
  return n <= 2 ? "exclusive" : "partial";
}
