import { createApp } from "vue";

import FeedbackApp from "@/views/FeedbackApp";
import { createFeedbackI18n } from "@/shared/i18n";
import { bootHikari } from "@/shared/theme";

const i18n = createFeedbackI18n();
bootHikari(String(i18n.global.locale));

createApp(FeedbackApp).use(i18n).mount("#app");
