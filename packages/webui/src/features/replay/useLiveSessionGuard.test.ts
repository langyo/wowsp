/** Live-session guard: the /live retention (post-battle review) must flip
 *  into a CLEAR the moment the client-session identity moves out from
 *  under the shown content — a different/relaunched client (PID change,
 *  which is also the earliest observable sign of an account switch, in
 *  port before any new roster) or the hub re-identifying a different
 *  player. A bare exit (client closed, nothing relaunched) keeps the
 *  review content. */
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api", () => ({ api: {} }));

import type { ArenaInfo, PlayingAccount, SessionSnapshot } from "@/api";
import { useGameStatusStore } from "@/stores/gameStatus";
import { useLiveSelfStore } from "@/stores/liveSelf";
import { useOverlayStore } from "@/stores/overlay";
import { useSessionStore } from "@/stores/session";
import { useLiveSessionGuard } from "./useLiveSessionGuard";

const fakeArena = (stamp: string): ArenaInfo =>
  ({ dateTime: stamp, vehicles: [], raw: null }) as unknown as ArenaInfo;

/** Seed the self feed the way the mine panel leaves it mid/post battle.
 *  The store's own new-battle watcher (queued by setArena) wipes the model
 *  on the next tick — wait it out BEFORE seeding, or it clobbers the seed. */
async function seedSelfContent(liveSelf: ReturnType<typeof useLiveSelfStore>) {
  liveSelf.setArena(fakeArena("2026-01-01 10:00:00"));
  await nextTick();
  liveSelf.model = { damage: 1 } as never;
  liveSelf.phase = "live";
}

const snapshotWith = (playing: PlayingAccount | null): SessionSnapshot =>
  ({
    process: { running: false, pid: null },
    playing,
    active: null,
    display: null,
  }) as SessionSnapshot;

async function rig() {
  const game = useGameStatusStore();
  const overlay = useOverlayStore();
  const liveSelf = useLiveSelfStore();
  const session = useSessionStore();
  useLiveSessionGuard();
  await nextTick();
  return { game, overlay, liveSelf, session };
}

async function setProcess(
  game: ReturnType<typeof useGameStatusStore>,
  patch: { running?: boolean; pid?: number | null },
) {
  game.process = { ...game.process, ...patch };
  await nextTick();
}

async function setPlaying(
  session: ReturnType<typeof useSessionStore>,
  playing: PlayingAccount | null,
) {
  session.snapshot = snapshotWith(playing);
  await nextTick();
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("useLiveSessionGuard", () => {
  it("keeps the review content while the same client session runs", async () => {
    const { game, overlay, liveSelf } = await rig();
    await setProcess(game, { running: true, pid: 100 });
    overlay.arenaInfo = fakeArena("2026-01-01 10:00:00");
    await seedSelfContent(liveSelf);
    await nextTick();
    // A poll refresh (same identity, fresh object) must not clear.
    await setProcess(game, { running: true, pid: 100 });
    expect(overlay.arenaInfo).not.toBeNull();
    expect(liveSelf.model).not.toBeNull();
    expect(liveSelf.phase).toBe("live");
  });

  it("retains the content on a bare exit (post-battle review)", async () => {
    const { game, overlay, liveSelf } = await rig();
    await setProcess(game, { running: true, pid: 100 });
    overlay.arenaInfo = fakeArena("2026-01-01 10:00:00");
    await seedSelfContent(liveSelf);
    await nextTick();
    await setProcess(game, { running: false, pid: null });
    expect(overlay.arenaInfo).not.toBeNull();
    expect(liveSelf.model).not.toBeNull();
  });

  it("does not clear when a failed process poll recovers with the same client", async () => {
    const { game, overlay } = await rig();
    await setProcess(game, { running: true, pid: 100 });
    // The process poll fails once (flips offline) right as the roster's
    // first read lands, then recovers with the SAME pid — the remembered
    // running PID backs the latch, so the recovery is not a session switch.
    await setProcess(game, { running: false, pid: null });
    overlay.arenaInfo = fakeArena("2026-01-01 10:00:00");
    await nextTick();
    await setProcess(game, { running: true, pid: 100 });
    expect(overlay.arenaInfo).not.toBeNull();
    // A genuinely different client after the blip still clears.
    await setProcess(game, { running: false, pid: null });
    await setProcess(game, { running: true, pid: 200 });
    expect(overlay.arenaInfo).toBeNull();
  });

  it("clears when a different client takes over (server switch)", async () => {
    const { game, overlay, liveSelf } = await rig();
    await setProcess(game, { running: true, pid: 100 });
    overlay.arenaInfo = fakeArena("2026-01-01 10:00:00");
    await seedSelfContent(liveSelf);
    await nextTick();
    await setProcess(game, { running: false, pid: null });
    await setProcess(game, { running: true, pid: 200 });
    expect(overlay.arenaInfo).toBeNull();
    expect(overlay.battleEnded).toBe(false);
    expect(liveSelf.model).toBeNull();
    expect(liveSelf.phase).toBe("idle");
  });

  it("clears on a same-machine relaunch (new PID — catches an account switch in port)", async () => {
    const { game, overlay, liveSelf } = await rig();
    await setProcess(game, { running: true, pid: 100 });
    overlay.arenaInfo = fakeArena("2026-01-01 10:00:00");
    await seedSelfContent(liveSelf);
    await nextTick();
    await setProcess(game, { running: false, pid: null });
    await setProcess(game, { running: true, pid: 300 });
    expect(overlay.arenaInfo).toBeNull();
    expect(liveSelf.model).toBeNull();
  });

  it("clears when the hub re-identifies a different player on the same process", async () => {
    const { game, overlay, liveSelf, session } = await rig();
    await setProcess(game, { running: true, pid: 100 });
    overlay.arenaInfo = fakeArena("2026-01-01 10:00:00");
    await seedSelfContent(liveSelf);
    await setPlaying(session, { realm: "asia", nickname: "Main", accountId: 1, source: "arena" });
    await setPlaying(session, { realm: "asia", nickname: "Alt", accountId: 2, source: "arena" });
    expect(overlay.arenaInfo).toBeNull();
    expect(liveSelf.model).toBeNull();
  });

  it("treats a playing id upgrade (same nickname) as the same account", async () => {
    const { game, overlay, liveSelf, session } = await rig();
    await setProcess(game, { running: true, pid: 100 });
    overlay.arenaInfo = fakeArena("2026-01-01 10:00:00");
    await seedSelfContent(liveSelf);
    await nextTick();
    await setPlaying(session, { realm: "asia", nickname: "Main", accountId: null, source: "arena" });
    await setPlaying(session, { realm: "asia", nickname: "Main", accountId: 7, source: "arena" });
    expect(overlay.arenaInfo).not.toBeNull();
    expect(liveSelf.model).not.toBeNull();
  });

  it("does not clear on the first playing observation", async () => {
    const { game, overlay, session } = await rig();
    await setProcess(game, { running: true, pid: 100 });
    overlay.arenaInfo = fakeArena("2026-01-01 10:00:00");
    await nextTick();
    await setPlaying(session, { realm: "asia", nickname: "Main", accountId: 1, source: "arena" });
    expect(overlay.arenaInfo).not.toBeNull();
  });

  it("clears a crash-leftover roster once any client runs", async () => {
    const { game, overlay } = await rig();
    // Roster read with no client running — stale by definition.
    overlay.arenaInfo = fakeArena("2026-01-01 09:00:00");
    await nextTick();
    await setProcess(game, { running: true, pid: 100 });
    expect(overlay.arenaInfo).toBeNull();
  });
});
