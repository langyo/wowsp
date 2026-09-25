import { createApp } from "vue";

import { installHkTooltipBridge } from "@celestia-island/hikari";

import App from "./App";
// hikari theme foundation first, then the app token layer (theme.scss), so
// app-local rules (app.scss) win the cascade — mirrors webui's load order.
import "./styles/hikari.scss";
import "./theme.scss";
import "./app.scss";

// Document-level bridge: every element carrying a native `title` (the log
// drawer toggle, HkAffixPicker's chips — hikari internals included) is
// upgraded in place to the hikari bubble tooltip, with zero per-component
// migration. Installing twice is idempotent.
installHkTooltipBridge();

createApp(App).mount("#app");
