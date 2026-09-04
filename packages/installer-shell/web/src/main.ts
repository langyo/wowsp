import { createApp } from "vue";

import App from "./App";
// hikari theme foundation first, then the app token layer (theme.scss), so
// app-local rules (app.scss) win the cascade — mirrors webui's load order.
import "./styles/hikari.scss";
import "./theme.scss";
import "./app.scss";

createApp(App).mount("#app");
