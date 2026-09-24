import { defineStore } from "pinia";
import { ref } from "vue";

/**
 * Phone-layout navigation drawer state. The toggle (title-bar hamburger)
 * and the surface (AppShell's HkDrawer-hosted sidebar) are distant siblings,
 * so the open flag lives here. Only ever opened on phone LAYOUT — the
 * desktop sidebar is persistent and never routes through this store.
 */
export const useNavUiStore = defineStore("navUi", () => {
  const open = ref(false);

  function toggle() {
    open.value = !open.value;
  }

  function close() {
    open.value = false;
  }

  return { open, toggle, close };
});
