import { defineComponent } from "vue";
import { RouterView } from "vue-router";
import SiteNav from "@/components/SiteNav";
import SiteFooter from "@/components/SiteFooter";
import "./App.scss";

export default defineComponent({
  name: "SiteApp",
  setup() {
    return () => (
      <div class="site">
        <SiteNav />
        <main class="site__main">
          <RouterView />
        </main>
        <SiteFooter />
      </div>
    );
  },
});
