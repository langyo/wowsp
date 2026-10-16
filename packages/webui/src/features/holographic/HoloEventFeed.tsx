/**
 * Bottom-left event feed of the holographic map (sink notifications + player
 * chat + achievement awards, newest first), extracted verbatim from
 * HolographicMap.tsx as a self-contained leaf component. It renders a plain
 * entry list — the playhead-crossing feed logic (what fires an entry and
 * when it expires) stays in HolographicMap.
 */
import { defineComponent, type PropType } from "vue";
import { MessageSquare, Trophy } from "@lucide/vue";
import BattleIcon from "@/components/base/BattleIcon";
import { t as i18nT } from "@/i18n";
import type { TeamRole } from "./teamColors";

/** Transient "X sunk Y" feed entry. Each side renders its own ship name
 *  with the player nickname underneath (killer left-aligned, victim
 *  right-aligned, "sank" centred). */
interface KillEvent {
  id: number;
  /** Victim's player nickname. */
  text: string;
  /** Victim's ship display name. */
  shipName: string;
  /** Victim's ship type (for the HUD icon). */
  shipType: string | null;
  /** Killer's ship display name. */
  killerShipName: string;
  /** Killer's ship type (for the HUD icon). */
  killerShipType: string | null;
  /** Killer's player nickname (resolved from the post-battle payload). */
  killerName: string | null;
  /** Role of the KILLER (the card tint is the killer's side). */
  role: TeamRole;
}
/** A battle-chat bubble (sender joined from the roster). */
interface ChatFeedEntry {
  id: number;
  sender: string;
  /** Sender is on the enemy side (roster relation ≥ 2) — drives the tint. */
  enemy: boolean;
  message: string;
}
/** An achievement award (localized name resolved from the bundle). */
interface AchievementFeedEntry {
  id: number;
  sender: string;
  enemy: boolean;
  /** Display name (raw id fallback when unmapped). */
  name: string;
  /** Game's achievement class (heroic/honorable/squad/...) — empty if unknown. */
  grade: string;
}
export type FeedEntry =
  | ({ kind: "kill" } & KillEvent)
  | ({ kind: "chat" } & ChatFeedEntry)
  | ({ kind: "achievement" } & AchievementFeedEntry);

/** Unified bottom-left event feed (sinks + chat + achievements), newest
 *  first; entries auto-expire after a few seconds (expiry owned by the
 *  parent). */
export default defineComponent({
  name: "HoloEventFeed",
  props: {
    entries: { type: Array as PropType<FeedEntry[]>, required: true },
  },
  setup(props) {
    return () => props.entries.length > 0 ? (
      <div class="holo-map__killfeed">
        {props.entries.map((e) => {
          if (e.kind === "kill") {
            return (
              <div key={e.id} class={["holo-map__kill", `holo-map__kill--${e.role}`]}>
                <div class="holo-map__kill-side holo-map__kill-side--killer">
                  <span class="holo-map__kill-ship">
                    <span class="holo-map__kill-ico">
                      {e.killerShipType ? (
                        <BattleIcon
                          kind="ship"
                          type={e.killerShipType}
                          variant={e.role === "enemy" ? "enemy" : "ally"}
                          size={13}
                        />
                      ) : null}
                    </span>
                    {e.killerShipName || e.killerName || "?"}
                  </span>
                  <span class="holo-map__kill-name">
                    {e.killerName ?? ""}
                  </span>
                </div>
                <span class="holo-map__kill-verb">{i18nT("replay.killVerb")}</span>
                <div class="holo-map__kill-side holo-map__kill-side--victim">
                  <span class="holo-map__kill-ship">
                    <span class="holo-map__kill-ico">
                      {e.shipType ? (
                        <BattleIcon
                          kind="ship"
                          type={e.shipType}
                          variant={e.role === "ally" ? "enemy" : "ally"}
                          size={13}
                        />
                      ) : null}
                    </span>
                    {e.shipName}
                  </span>
                  <span class="holo-map__kill-name">
                    {e.text}
                  </span>
                </div>
              </div>
            );
          }
          if (e.kind === "chat") {
            return (
              <div
                key={e.id}
                class={["holo-map__chat", e.enemy ? "holo-map__chat--enemy" : "holo-map__chat--ally"]}
              >
                <MessageSquare size={12} class="holo-map__chat-ico" />
                <span class="holo-map__chat-sender">{e.sender}</span>
                <span class="holo-map__chat-text">{e.message}</span>
              </div>
            );
          }
          return (
            <div
              key={e.id}
              class={[
                "holo-map__ach",
                e.enemy ? "holo-map__ach--enemy" : "holo-map__ach--ally",
              ]}
            >
              <Trophy size={12} class="holo-map__ach-ico" />
              <span class="holo-map__ach-sender">{e.sender}</span>
              <span class="holo-map__ach-verb">{i18nT("replay.achieved")}</span>
              <span class="holo-map__ach-name">{e.name}</span>
            </div>
          );
        })}
      </div>
    ) : null;
  },
});
