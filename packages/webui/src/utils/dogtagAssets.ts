/**
 * Dog-tag asset overlay.
 *
 * Player dog tags render from two repo-shipped artifacts: the part PNGs
 * under `src/res/dogtags/` and the `id → [index, species, colorHEX?]` map
 * in `src/data/dogtags_map.json`. Both are snapshots of the game client, so
 * medals Wargaming adds later are unknown until a new app build ships.
 *
 * The desktop shell bridges that gap: `ensure_res_pack()` serves the
 * content-addressed resource pack from the fixed `res-latest` release
 * (see `scripts/release_models.py`), whose `dogtags/` subtree carries a
 * refreshed map plus any new part images. initDogtagPack() wires that
 * pack in once at startup:
 *
 *   - dogtagAssetUrl() serves part images from the pack cache (via
 *     convertFileSrc), falling back to the bundled publicDir paths during
 *     development or before the download finishes;
 *   - dogtagEntry() looks ids up in the bundled map overlaid by the pack's
 *     map (pack wins per id). The lookup touches dogtagMapVersion, a ref, so
 *     computeds that call it re-run when the overlay lands.
 */
import { ref } from "vue";
import mapRaw from "@/data/dogtags_map.json";

export type DogtagMapEntry = [string, string] | [string, string, string];

const entries = { ...mapRaw } as unknown as Record<string, DogtagMapEntry>;

/** Bumped when the pack's map is merged in; read by every lookup. */
export const dogtagMapVersion = ref(0);

const packRoot = ref<string | null>(null);
let convertFileSrc: ((path: string) => string) | null = null;
let initPromise: Promise<void> | null = null;

/** Wire up the downloaded dog-tag pack. Safe to call multiple times — only
 *  the first invocation fetches; every failure keeps the bundled snapshot. */
export function initDogtagPack(fetchPack: () => Promise<string>): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    // convertFileSrc only exists in the Tauri context; the web build keeps
    // serving the bundled snapshot.
    try {
      const mod = await import("@tauri-apps/api/core");
      convertFileSrc = mod.convertFileSrc;
    } catch {
      return;
    }
    let root: string;
    try {
      root = await fetchPack();
    } catch {
      return;
    }
    packRoot.value = root;

    // Overlay the pack's map (pack wins per id) so unknown medals resolve.
    try {
      const res = await fetch(convertFileSrc(`${root}/dogtags/dogtags_map.json`));
      if (res.ok) {
        Object.assign(entries, (await res.json()) as Record<string, DogtagMapEntry>);
        dogtagMapVersion.value++;
      }
    } catch {
      // Images still overlay; the bundled map keeps covering lookups.
    }
  })();
  return initPromise;
}

/** Map entry for a Vortex dog_tag id (null when unknown to both snapshots). */
export function dogtagEntry(id: number | null | undefined): DogtagMapEntry | null {
  void dogtagMapVersion.value;
  if (id == null) return null;
  return entries[String(id)] ?? null;
}

/** URL for a dog-tag part image (`"PCNP053.png"`, `"PCNA001/border.png"`). */
export function dogtagAssetUrl(relPath: string): string {
  const root = packRoot.value;
  if (root == null || convertFileSrc == null) return "/dogtags/" + relPath;
  return convertFileSrc(`${root}/dogtags/${relPath}`);
}
