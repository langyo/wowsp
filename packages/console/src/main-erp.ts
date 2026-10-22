import { createApp } from "vue";

import ErpApp from "@/views/ErpApp";
import { bootHikari } from "@/shared/theme";

bootHikari("zh-CN");

createApp(ErpApp).mount("#app");
