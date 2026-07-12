import { defineStore } from "pinia";
import { computed, ref } from "vue";

interface OverlayEntry {
  name: string;
  group?: string;
  close: () => void;
}

export const usePopupRegistryStore = defineStore("popupRegistry", () => {
  const entries = ref<Map<string, OverlayEntry>>(new Map());
  const count = computed(() => entries.value.size);
  const openNames = computed(() => [...entries.value.keys()]);

  function isOpen(name: string): boolean {
    return entries.value.has(name);
  }
  function register(name: string, close: () => void, group?: string): void {
    entries.value.set(name, { name, group, close });
  }
  function unregister(name: string): void {
    entries.value.delete(name);
  }
  function closeAll(): void {
    for (const entry of entries.value.values()) entry.close();
  }
  function closeGroup(group: string): void {
    for (const entry of entries.value.values()) {
      if (entry.group === group) entry.close();
    }
  }
  return { count, openNames, isOpen, register, unregister, closeAll, closeGroup };
});
