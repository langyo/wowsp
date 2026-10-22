import { defineComponent } from "vue";
import { HkButton } from "@celestia-island/hikari";

/**
 * /erp console — SCAFFOLD state: proves the real-hikari build chain. The
 * login/session/review/replay-admin surfaces land here per the parity
 * spec against the retired embedded page (HkAuthCard + HkAdminShell).
 */
export default defineComponent({
  name: "ErpApp",
  setup() {
    return () => (
      <main style={{ "max-width": "40rem", margin: "3rem auto", padding: "0 1rem" }}>
        <h1>WoWSP 后台</h1>
        <HkButton>hikari 已接通</HkButton>
      </main>
    );
  },
});
