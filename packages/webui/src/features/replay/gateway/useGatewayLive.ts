/** The PHONE live view's gateway flow (gateway-push §6): the auto-waiting
 *  state (viewing is free — no connection on mount), the 开始连接 handshake
 *  (health resolve → optional captcha sheet → optional password sheet →
 *  subscribe), the pushed battle's ArenaInfo mapping, and the
 *  host/bye-driven hint flips. Connection failures to a CUSTOM root
 *  surface as top-right toasts (hikari useToast); the official node's
 *  stay inline (the status pill). */
import { computed, onBeforeUnmount, ref } from "vue";
import { useToast } from "@celestia-island/hikari";

import { t, tError } from "@/i18n";
import type { ArenaInfo } from "@/api";
import { useGatewayStore } from "@/stores/gateway";
import { useShownPlayer } from "@/composables/useShownPlayer";
import {
  arenaOfGatewayBattle,
  gatewayRoute,
} from "@/features/replay/gateway/gatewayBattle";

export function useGatewayLive() {
  const gateway = useGatewayStore();
  const toast = useToast();
  const { shownPlayer } = useShownPlayer();

  /** The account chip's route — the phone subscribes to the channel of its
   *  own ACTIVE account (realm + accountId equality is the same-account
   *  confirmation, §2). Null until an account is bound/active. */
  const route = computed(() => {
    const p = shownPlayer.value;
    return p && p.accountId != null ? gatewayRoute(p.realm, p.accountId) : null;
  });

  // ── sheets ────────────────────────────────────────────────────────────
  /** Captcha bottom sheet (HkModal docks under 768px): open while the
   *  health document demands Turnstile. `captchaSiteKey` carries the doc's
   *  sitekey — the widget mounts ONLY once it lands (async-sitekey guard;
   *  an empty configured sitekey still mounts into placeholder mode). */
  const captchaSheetOpen = ref(false);
  const captchaSiteKey = ref<string | null>(null);
  /** Bumped after every failed exchange so the widget remints. */
  const captchaAttempt = ref(0);
  /** Password bottom sheet: open while the health document demands one. */
  const passwordSheetOpen = ref(false);
  const passwordBusy = ref(false);
  /** Inline (non-custom-node) connection error, keyed for the status row. */
  const inlineError = ref<string | null>(null);

  /** Credentials collected by the sheets for the CURRENT dial attempt. */
  let turnstileToken: string | undefined;
  let password: string | undefined;
  let needPassword = false;

  function fail(e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e);
    inlineError.value = msg;
    if (gateway.isCustomRoot) {
      toast.error(t("gateway.customNodeError", { detail: msg }));
    }
  }

  /** The dial itself — re-entered by the sheet callbacks with fresh creds. */
  async function dial(): Promise<void> {
    if (!route.value) return;
    if (needPassword && !password) {
      passwordSheetOpen.value = true;
      return;
    }
    try {
      await gateway.startSubscribe(gateway.config.root, route.value, {
        turnstileToken,
        password,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/captcha/.test(msg)) {
        // The exchange consumed the token — the challenge must run again.
        captchaAttempt.value += 1;
        turnstileToken = undefined;
        captchaSheetOpen.value = true;
        return;
      }
      if (/password/.test(msg)) {
        // Wrong password — re-ask (the stale value is dropped).
        password = undefined;
        passwordSheetOpen.value = true;
        return;
      }
      fail(e);
    }
  }

  /** 开始连接: resolve health, then open whichever sheet the node demands
   *  (§6.2) before dialing. */
  const connecting = ref(false);
  async function connect(): Promise<void> {
    if (connecting.value || !route.value) return;
    inlineError.value = null;
    // A fresh pass starts credential-clean: a wrong password (or a spent
    // turnstile token) from an earlier attempt must never ride along —
    // the sheets re-ask what the node demands.
    turnstileToken = undefined;
    password = undefined;
    connecting.value = true;
    try {
      const doc = await gateway.resolveHealth(gateway.config.root, true);
      needPassword = doc.auth.password.required;
      if (doc.auth.turnstile.required) {
        captchaSiteKey.value = doc.auth.turnstile.sitekey ?? "";
        captchaSheetOpen.value = true;
        return; // the sheet's verify callback continues the flow
      }
      await dial();
    } catch (e) {
      fail(e);
    } finally {
      connecting.value = false;
    }
  }

  function onCaptchaVerified(token: string): void {
    turnstileToken = token;
    captchaSheetOpen.value = false;
    connecting.value = true;
    void dial().finally(() => (connecting.value = false));
  }

  function onPasswordSubmit(pw: string): void {
    password = pw;
    passwordSheetOpen.value = false;
    connecting.value = true;
    passwordBusy.value = true;
    void dial().finally(() => {
      connecting.value = false;
      passwordBusy.value = false;
    });
  }

  /** 断开连接 (and the unmount hook): stop the subscription. */
  async function disconnect(): Promise<void> {
    captchaSheetOpen.value = false;
    passwordSheetOpen.value = false;
    inlineError.value = null;
    await gateway.stopSubscribe();
  }

  // ── pushed battle state ───────────────────────────────────────────────
  /** The pushed battle mapped into the ArenaInfo shape LiveBattlePanel
   *  renders (null before the first frame). */
  const arena = computed<ArenaInfo | null>(() =>
    gateway.battle ? arenaOfGatewayBattle(gateway.battle) : null,
  );
  /** The pushed battle's realm (stats routing + lookup jumps). */
  const battleRealm = computed(() => gateway.battle?.realm ?? "");
  /** The battle is over (`bye`): keep the last roster rendered with the
   *  ended hint, exactly like the local view's retention. */
  const ended = computed(() => gateway.battleEnded);

  // Fresh mount starts the receive pass clean; leaving the page stops the
  // subscription (viewing again is free — no socket while unmounted).
  gateway.clearBattle();
  onBeforeUnmount(() => {
    if (gateway.subPhase !== "stopped") void gateway.stopSubscribe();
  });

  return {
    // identity + route
    shownPlayer,
    route,
    // handshake
    connect,
    disconnect,
    connecting,
    inlineError,
    inlineErrorText: computed(() =>
      inlineError.value ? tError(inlineError.value) : null,
    ),
    // sheets
    captchaSheetOpen,
    captchaSiteKey,
    captchaAttempt,
    onCaptchaVerified,
    passwordSheetOpen,
    passwordBusy,
    onPasswordSubmit,
    // pushed battle
    arena,
    battleRealm,
    ended,
  };
}
