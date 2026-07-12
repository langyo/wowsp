import { onUnmounted, ref, type Ref } from "vue";
import { usePopupRegistryStore } from "@/stores/popupRegistry";

export interface UseOverlayOptions {
  name: string;
  group?: string;
}

export interface OverlayHandle {
  isOpen: Ref<boolean>;
  open: () => void;
  close: () => void;
  toggle: () => void;
  onUpdate: (v: boolean) => void;
}

export function useOverlay(opts: UseOverlayOptions): OverlayHandle {
  const store = usePopupRegistryStore();
  const isOpen = ref(false);

  function open(): void {
    if (isOpen.value) return;
    if (opts.group) store.closeGroup(opts.group);
    isOpen.value = true;
    store.register(opts.name, close, opts.group);
  }
  function close(): void {
    if (!isOpen.value) return;
    isOpen.value = false;
    store.unregister(opts.name);
  }
  function toggle(): void {
    if (isOpen.value) close();
    else open();
  }
  function onUpdate(v: boolean): void {
    if (v) open();
    else close();
  }
  onUnmounted(() => {
    if (isOpen.value) store.unregister(opts.name);
  });
  return { isOpen, open, close, toggle, onUpdate };
}
