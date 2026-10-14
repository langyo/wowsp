/**
 * WoWSP API client — thin wrappers over the transport singleton that map
 * each Tauri command to a typed call, so feature code imports
 * `api.detectGameInstall()` instead of touching `transport.invoke(RPC...)`
 * directly. The definitions live in the domain modules under `./modules/`
 * (shell, game, replay, stats, respack, modhub, pairing, contribution);
 * this file composes the `api` object and re-exports every symbol so
 * `@/api/client` importers see the exact same surface as before the split.
 */
import { shellApi } from "./modules/shell";
import { gameApi } from "./modules/game";
import { replayApi } from "./modules/replay";
import { statsApi } from "./modules/stats";
import { resPackApi } from "./modules/respack";
import { modHubApi } from "./modules/modhub";
import { pairingApi } from "./modules/pairing";
import { contributionApi } from "./modules/contribution";

export * from "./modules/shell";
export * from "./modules/game";
export * from "./modules/replay";
export * from "./modules/stats";
export * from "./modules/respack";
export * from "./modules/modhub";
export * from "./modules/pairing";
export * from "./modules/contribution";

export const api = {
  ...shellApi,
  ...gameApi,
  ...replayApi,
  ...statsApi,
  ...resPackApi,
  ...modHubApi,
  ...pairingApi,
  ...contributionApi,
};
