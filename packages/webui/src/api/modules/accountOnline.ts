/** Account online-probe domain (账号列表「疑似在线」标记): one batched WG
 *  account/info + CN vortex poll over the bound accounts, answering the
 *  freshest battle-finish timestamp per account. The WG public API has no
 *  per-player presence — the badge derived from this is "recently active,
 *  probably still around" (疑似在线), never a guarantee. Mirrors
 *  commands/account_online.rs. */
import { transport } from "@/transport";
import { RPC } from "@/rpc";

/** Mirrors AccountOnlineProbe — one bound account from the account store. */
export interface AccountOnlineProbe {
  accountId: number;
  nickname: string;
  realm: string;
}

/** Mirrors AccountOnlineStatus. `lastBattleTime` null = nothing usable
 *  this round (upstream hiccup / no exact CN hit) — the badge hides for
 *  the account; it never means "definitely offline". */
export interface AccountOnlineStatus {
  accountId: number;
  realm: string;
  lastBattleTime: number | null;
  /** Unix seconds when the backend swept this account. */
  checkedAt: number;
}

export const accountOnlineApi = {
  /** One poll: per-account last_battle_time for the given probes. */
  accountOnlineCheck: (probes: AccountOnlineProbe[]) =>
    transport.invoke<AccountOnlineStatus[]>(RPC.account_online_check, { probes }),
};
