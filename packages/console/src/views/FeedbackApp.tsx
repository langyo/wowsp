import { defineComponent, onMounted, ref } from "vue";
import { HkButton } from "@celestia-island/hikari";

import { getFeedbackConfig } from "@/shared/api";

/**
 * /feedback console — SCAFFOLD state: proves the real-hikari build chain
 * (components + theme runtime + config API) end to end. The full form
 * (HkTextarea/HkCaptchaWidget/lookup-token UX/history view) lands in this
 * file per the parity spec against the retired embedded page.
 */
export default defineComponent({
  name: "FeedbackApp",
  setup() {
    const configError = ref("");
    onMounted(async () => {
      try {
        const cfg = await getFeedbackConfig();
        document.title = `WoWSP 反馈台 · v${cfg.latestVersion}`;
      } catch (e) {
        configError.value = String(e);
      }
    });
    return () => (
      <main style={{ "max-width": "40rem", margin: "3rem auto", padding: "0 1rem" }}>
        <h1>WoWSP 反馈台</h1>
        <HkButton>hikari 已接通</HkButton>
        {configError.value ? <p>{configError.value}</p> : null}
      </main>
    );
  },
});
