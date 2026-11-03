/** Per-client install STATE of one catalog entry — the vocabulary the
 *  merged install tag and the entry-clients surfaces share. The flat
 *  tag used to list every root whose ledger record matched, which lied
 *  twice at once (2026-11-03): a record on a client the entry no
 *  longer applies to read as "installed", and a stale record whose
 *  files are long gone read the same as a healthy one. States, first
 *  match wins:
 *
 *  - "unsupported"  — the entry does not apply on this client's realm
 *    (the same rule the fan-out skips by). Wins over everything: a
 *    leftover record under a since-excluded realm is residue, not an
 *    install.
 *  - "needsUpdate"  — a ledger record exists but its version differs
 *    from the entry's current one.
 *  - "installed"    — a record whose version is current.
 *  - "notInstalled" — no record at all. */
import type { CatalogEntry, GameInstall, ModInstallRecord } from "@/api";

import { appliesToRealm, realmOfInstall } from "./servers";

export type EntryClientState =
  | "installed"
  | "needsUpdate"
  | "notInstalled"
  | "unsupported";

export interface EntryClientStatus {
  install: GameInstall;
  record: ModInstallRecord | undefined;
  state: EntryClientState;
}

export function entryClientStateOf(
  entry: CatalogEntry,
  install: GameInstall,
  record: ModInstallRecord | undefined,
): EntryClientState {
  if (!appliesToRealm(entry, realmOfInstall(install))) {
    return "unsupported";
  }
  if (!record) return "notInstalled";
  return record.version === entry.version ? "installed" : "needsUpdate";
}

/** Per-client statuses over every configured install, in the install
 *  detection order (the merged tag and the clients window share this
 *  derivation so they can never disagree). */
export function entryClientStatusesOf(
  entry: CatalogEntry,
  installs: readonly GameInstall[],
  recordOfEntryOn: (entry: CatalogEntry, root: string) => ModInstallRecord | undefined,
): EntryClientStatus[] {
  return installs.map((install) => {
    const record = recordOfEntryOn(entry, install.path);
    return {
      install,
      record,
      state: entryClientStateOf(entry, install, record),
    };
  });
}
