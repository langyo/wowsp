/**
 * SelfhostWizard — the desktop settings' private-gateway deployment wizard
 * (gateway-push §7): six verified steps (env probe → wrangler login →
 * target domain → KV bucket → deploy → verify) driven by
 * gateway_selfhost_probe / gateway_selfhost_step, with every step's
 * streamed output (wowsp://gateway-selfhost, buffered in the gateway
 * store) rendered in a mono log pane. Deploy/verify success shows the
 * resulting URL + QR + copy and tells the user to enter it on the phone
 * (Settings → 手机服务 → 自定义).
 *
 * The wizard rides hikari's HkModal (windowed surface of the settings
 * shell) and HkStepFlow (the step timeline + directional body swaps);
 * step advancing is host-gated — a step's action button is the only way
 * forward, and the timeline is not clickable (steps verify before
 * advancing, per the contract). The CF token never appears here: wrangler
 * keeps its own login state (§7's red line).
 */
import { computed, defineComponent, ref, watch } from "vue";
import {
  HkAlert,
  HkButton,
  HkCopyBadge,
  HkInput,
  HkModal,
  HkQrCode,
  HkSpinner,
  HkStepFlow,
} from "@celestia-island/hikari";
import { CheckCircle2, CircleDashed, RotateCw, ServerCog } from "@lucide/vue";

import { t } from "@/i18n";
import { useGatewayStore } from "@/stores/gateway";
import { useClipboard } from "@/composables/useClipboard";
import "./SelfhostWizard.scss";

type WizardStep = "env" | "login" | "target" | "kv" | "deploy" | "verify";

const STEP_KEYS: readonly WizardStep[] = [
  "env",
  "login",
  "target",
  "kv",
  "deploy",
  "verify",
];

export default defineComponent({
  name: "SelfhostWizard",
  props: {
    modelValue: { type: Boolean, required: true },
  },
  emits: {
    "update:modelValue": (_v: boolean) => true,
  },
  setup(props, { emit }) {
    const gateway = useGatewayStore();
    const { copy } = useClipboard();

    const step = ref<WizardStep>("env");
    const domain = ref("");
    /** The wowsp CHECKOUT the worker sources deploy from — persisted in
     *  the gateway store (localStorage one-slot pref). Only needed when
     *  the app does not run from a checkout (dev builds auto-probe the
     *  exe's ancestors; installed builds cannot). */
    const repoDir = ref(gateway.selfhostRepo);
    function onRepoDir(v: string): void {
      repoDir.value = v;
      gateway.setSelfhostRepo(v);
    }
    /** The kv step's namespace id — forwarded to deploy. */
    const kvId = ref<string | null>(null);
    const deployedUrl = ref<string | null>(null);
    const verified = ref(false);
    const stepError = ref<string | null>(null);
    /** The deploy step's result URL — also the verify step's target. */

    /** Step args with EMPTY fields omitted: an empty repoDir must not
     *  reach Rust (its auto-probe would be overridden by ""), and an
     *  absent kvId keeps the kv step's create path. */
    function stepArgs(extra: {
      domain?: string;
      kvId?: string | null;
      repoDir?: string;
    }): { domain?: string; kvId?: string; repoDir?: string } {
      const out: { domain?: string; kvId?: string; repoDir?: string } = {};
      if (extra.domain?.trim()) out.domain = extra.domain.trim();
      if (extra.kvId) out.kvId = extra.kvId;
      if (extra.repoDir?.trim()) out.repoDir = extra.repoDir.trim();
      return out;
    }

    // HkStepFlow's step rows (key + label; the icon/disabled fields
    // stay unused — the wizard's timeline is display-only).
    const steps = computed(() =>
      STEP_KEYS.map((key) => ({
        key,
        label: t("gateway.selfhostStep." + key),
      })),
    );

    /** One env-probe row: label + found/missing voice. */
    const envRows = computed(() => {
      const env = gateway.selfhostEnv;
      return [
        { label: t("gateway.selfhostEnvNode"), value: env?.nodeVersion ?? env?.nodePath ?? null },
        { label: t("gateway.selfhostEnvNpx"), value: env?.npxPath ?? null },
        { label: t("gateway.selfhostEnvRust"), value: env?.rustc ?? null },
        { label: t("gateway.selfhostEnvWasm"), value: env?.wasmTarget ?? null },
        { label: t("gateway.selfhostEnvWorkerBuild"), value: env?.workerBuild ?? null },
      ];
    });
    const wranglerAuthed = computed(() => gateway.selfhostEnv?.wranglerAuthed ?? false);

    /** A step's runner: clear the error, run, auto-advance on success. */
    async function run(
      stepId: WizardStep,
      args?: { domain?: string; kvId?: string; repoDir?: string },
    ): Promise<void> {
      stepError.value = null;
      try {
        const result = await gateway.runSelfhostStep(mapStep(stepId), args);
        if (stepId === "login") {
          // The authed flag is part of the probe surface — refresh it so
          // the timeline's next steps (and a reopened wizard) see it.
          await gateway.probeSelfhost();
        }
        if (stepId === "kv") {
          // The created/reused namespace id rides the deploy step.
          kvId.value = typeof result.kvId === "string" ? result.kvId : null;
        }
        if (stepId === "deploy") {
          const url = typeof result.url === "string" ? result.url : null;
          deployedUrl.value = url;
        }
        if (stepId === "verify") verified.value = true;
        advance();
      } catch (e) {
        stepError.value = e instanceof Error ? e.message : String(e);
      }
    }

    function mapStep(id: WizardStep): "wrangler-login" | "list-zones" | "kv-ensure" | "deploy" | "verify" {
      switch (id) {
        case "target":
          return "list-zones";
        case "kv":
          return "kv-ensure";
        case "deploy":
          return "deploy";
        case "verify":
          return "verify";
        default:
          return "wrangler-login";
      }
    }

    function advance(): void {
      const idx = STEP_KEYS.indexOf(step.value);
      if (idx >= 0 && idx < STEP_KEYS.length - 1) step.value = STEP_KEYS[idx + 1];
    }

    /** Every open starts a fresh pass: reset state, clear the log, probe.
     *  immediate — a LANDING mount with the window already open (the
     *  settings modal hosting this wizard mounts it with modelValue true)
     *  must run the same pass a later open would. */
    watch(
      () => props.modelValue,
      (open) => {
        if (!open) return;
        step.value = "env";
        domain.value = "";
        repoDir.value = gateway.selfhostRepo;
        kvId.value = null;
        deployedUrl.value = null;
        verified.value = false;
        stepError.value = null;
        gateway.clearSelfhostLog();
        void gateway.probeSelfhost();
      },
      { immediate: true },
    );

    const busy = computed(() => gateway.selfhostStepBusy !== null);
    const logRows = computed(() => gateway.selfhostLog);

    function copyUrl(): void {
      if (deployedUrl.value) void copy(deployedUrl.value, t("gateway.selfhostUrlCopied"));
    }

    return () => (
      <HkModal
        modelValue={props.modelValue}
        onUpdate:modelValue={(v: boolean) => emit("update:modelValue", v)}
        title={t("gateway.selfhostTitle")}
        width="md"
      >
        {{
          default: () => (
            <div class="selfhost-wizard">
              <HkStepFlow steps={steps.value} modelValue={step.value}>
                {{
                  // Step bodies are keyed slots — one per step key.
                  env: () => (
                    <div class="selfhost-wizard__step">
                      <p class="selfhost-wizard__hint">{t("gateway.selfhostEnvHint")}</p>
                      {gateway.selfhostProbing ? (
                        <p class="selfhost-wizard__busy">
                          <HkSpinner size="xs" tone="current" />
                        </p>
                      ) : (
                        <ul class="selfhost-wizard__env">
                          {envRows.value.map((row) => (
                            <li key={row.label} class="selfhost-wizard__env-row">
                              <span class="selfhost-wizard__env-label">{row.label}</span>
                              {row.value ? (
                                <CheckCircle2 size={14} class="selfhost-wizard__ok" />
                              ) : (
                                <CircleDashed size={14} class="selfhost-wizard__miss" />
                              )}
                              <code class="selfhost-wizard__env-value">{row.value ?? t("gateway.selfhostMissing")}</code>
                            </li>
                          ))}
                          <li class="selfhost-wizard__env-row">
                            <span class="selfhost-wizard__env-label">{t("gateway.selfhostEnvWrangler")}</span>
                            {wranglerAuthed.value ? (
                              <CheckCircle2 size={14} class="selfhost-wizard__ok" />
                            ) : (
                              <CircleDashed size={14} class="selfhost-wizard__miss" />
                            )}
                            <code class="selfhost-wizard__env-value">
                              {wranglerAuthed.value
                                ? gateway.selfhostEnv?.account ?? t("gateway.selfhostAuthed")
                                : t("gateway.selfhostNotAuthed")}
                            </code>
                          </li>
                        </ul>
                      )}
                      {/* The wowsp checkout the worker sources deploy
                          from — only needed when the app is not run from a
                          checkout (installed builds); persisted for the
                          next wizard run. */}
                      <HkInput
                        modelValue={repoDir.value}
                        onUpdate:modelValue={(v: string) => onRepoDir(v)}
                        label={t("gateway.selfhostRepoDir")}
                        hint={t("gateway.selfhostRepoDirHint")}
                        placeholder="path/to/wowsp"
                        spellcheck={false}
                      />
                      <HkButton
                        variant="primary"
                        size="sm"
                        disabled={gateway.selfhostProbing}
                        onClick={advance}
                      >
                        {t("gateway.selfhostNext")}
                      </HkButton>
                    </div>
                  ),
                  login: () => (
                    <div class="selfhost-wizard__step">
                      <p class="selfhost-wizard__hint">{t("gateway.selfhostLoginHint")}</p>
                      <HkButton
                        variant="primary"
                        size="sm"
                        loading={busy.value}
                        disabled={busy.value}
                        onClick={() => void run("login")}
                      >
                        <ServerCog size={14} />
                        {wranglerAuthed.value
                          ? t("gateway.selfhostReauth")
                          : t("gateway.selfhostLogin")}
                      </HkButton>
                    </div>
                  ),
                  target: () => (
                    <div class="selfhost-wizard__step">
                      <p class="selfhost-wizard__hint">{t("gateway.selfhostTargetHint")}</p>
                      <div class="selfhost-wizard__field">
                        <HkInput
                          modelValue={domain.value}
                          onUpdate:modelValue={(v: string) => (domain.value = v)}
                          placeholder={t("gateway.selfhostDomainPlaceholder")}
                          spellcheck={false}
                        />
                        <HkButton
                          variant="primary"
                          size="sm"
                          loading={busy.value}
                          disabled={busy.value || !domain.value.trim()}
                          onClick={() => void run("target", { domain: domain.value.trim() })}
                        >
                          {t("gateway.selfhostValidate")}
                        </HkButton>
                      </div>
                    </div>
                  ),
                  kv: () => (
                    <div class="selfhost-wizard__step">
                      <p class="selfhost-wizard__hint">{t("gateway.selfhostKvHint")}</p>
                      <HkButton
                        variant="primary"
                        size="sm"
                        loading={busy.value}
                        disabled={busy.value}
                        onClick={() =>
                          void run("kv", stepArgs({ repoDir: repoDir.value }))
                        }
                      >
                        {t("gateway.selfhostKvCreate")}
                      </HkButton>
                    </div>
                  ),
                  deploy: () => (
                    <div class="selfhost-wizard__step">
                      <p class="selfhost-wizard__hint">{t("gateway.selfhostDeployHint")}</p>
                      <HkButton
                        variant="primary"
                        size="sm"
                        loading={busy.value}
                        disabled={busy.value || !domain.value.trim()}
                        onClick={() =>
                          void run(
                            "deploy",
                            stepArgs({
                              domain: domain.value,
                              kvId: kvId.value,
                              repoDir: repoDir.value,
                            }),
                          )
                        }
                      >
                        <RotateCw size={14} />
                        {t("gateway.selfhostDeploy")}
                      </HkButton>
                    </div>
                  ),
                  verify: () => (
                    <div class="selfhost-wizard__step">
                      <p class="selfhost-wizard__hint">{t("gateway.selfhostVerifyHint")}</p>
                      <HkButton
                        variant="primary"
                        size="sm"
                        loading={busy.value}
                        disabled={busy.value || verified.value}
                        onClick={() =>
                          void run(
                            "verify",
                            stepArgs({ domain: domain.value, repoDir: repoDir.value }),
                          )
                        }
                      >
                        {t("gateway.selfhostVerify")}
                      </HkButton>
                      {verified.value && deployedUrl.value ? (
                        <div class="selfhost-wizard__done">
                          <HkAlert variant="success" size="sm" message={t("gateway.selfhostDone")} />
                          <div class="selfhost-wizard__url">
                            <HkQrCode value={deployedUrl.value} size={132} />
                            <div class="selfhost-wizard__url-body">
                              <HkCopyBadge value={deployedUrl.value} mono>
                                {deployedUrl.value}
                              </HkCopyBadge>
                              <p class="selfhost-wizard__phone-hint">
                                {t("gateway.selfhostPhoneHint")}
                              </p>
                              <HkButton size="sm" variant="secondary" onClick={copyUrl}>
                                {t("gateway.selfhostCopyUrl")}
                              </HkButton>
                            </div>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ),
                }}
              </HkStepFlow>

              {stepError.value ? (
                <HkAlert variant="error" size="sm" message={stepError.value} />
              ) : null}

              {/* Streamed output (wowsp://gateway-selfhost buffered in the
                  store) — a plain mono pane; the lines are the wizard's
                  progress events (§7.5). */}
              <div class="selfhost-wizard__log">
                <p class="selfhost-wizard__log-title">{t("gateway.selfhostLog")}</p>
                <div class="selfhost-wizard__log-body">
                  {logRows.value.length === 0 ? (
                    <p class="selfhost-wizard__log-empty">{t("gateway.selfhostLogEmpty")}</p>
                  ) : (
                    logRows.value.map((row, i) => (
                      <p
                        key={i}
                        class={[
                          "selfhost-wizard__log-line",
                          row.stream === "stderr" ? "is-err" : "",
                          row.stream === "done" ? "is-done" : "",
                        ]}
                      >
                        {row.line || (row.stream === "done" ? t("gateway.selfhostStepDone") : "")}
                      </p>
                    ))
                  )}
                </div>
              </div>
            </div>
          ),
        }}
      </HkModal>
    );
  },
});
