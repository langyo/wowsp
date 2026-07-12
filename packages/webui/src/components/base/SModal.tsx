import {
  computed,
  defineComponent,
  onBeforeUnmount,
  ref,
  watch,
  type PropType,
} from "vue";
import { X } from "lucide-vue-next";
import { usePopupManager } from "@/composables/usePopupManager";
import { useReportedTransition } from "@/composables/useReportedTransition";
import { focusFirst, trapFocus } from "@/utils/dom";
import SButton from "./SButton";
import "./SModal.scss";

export default defineComponent({
  name: "SModal",
  props: {
    modelValue: { type: Boolean, default: false },
    title: { type: String, default: undefined },
    closeable: { type: Boolean, default: true },
    width: { type: String, default: "32rem" },
  },
  emits: {
    "update:modelValue": (_v: boolean) => true,
    afterLeave: () => true,
  },
  setup(props, { emit, slots }) {
    const manager = usePopupManager();
    const animBus = useReportedTransition(300);
    const shouldRender = ref(false);
    const previouslyFocused = ref<HTMLElement | null>(null);
    const panelRef = ref<HTMLElement | null>(null);

    const style = computed(() => ({ maxWidth: props.width }));
    // Track the popup-manager handle so we unregister with the correct id on
    // close (previously passed "" which leaked the scroll-lock counter).
    let popupId = "";

    function close() {
      if (props.closeable) emit("update:modelValue", false);
    }

    watch(
      () => props.modelValue,
      (open) => {
        if (open) {
          previouslyFocused.value = document.activeElement as HTMLElement;
          const handle = manager.register("modal", true, props.title);
          popupId = handle.id;
          animBus.run();
          (panelRef as unknown as { _z?: number })._z = handle.zIndex;
          shouldRender.value = true;
          requestAnimationFrame(() => focusFirst(panelRef.value!));
        }
      },
    );

    watch(
      () => props.title,
      (t) => {
        // keep registry title synced (for breadcrumb if added later)
      },
    );

    function onBeforeEnter() {
      animBus.run();
    }
    function onAfterEnter() {
      animBus.cancel();
    }
    function onBeforeLeave() {
      animBus.run();
    }
    function onAfterLeave() {
      animBus.cancel();
      manager.unregister(popupId);
      popupId = "";
      shouldRender.value = false;
      previouslyFocused.value?.focus?.();
      emit("afterLeave");
    }

    function onOverlayClick() {
      close();
    }
    function onKeydown(e: KeyboardEvent) {
      if (e.key === "Escape" && props.closeable) {
        e.preventDefault();
        close();
        return;
      }
      if (e.key === "Tab") {
        trapFocus(panelRef.value!, e);
      }
    }

    onBeforeUnmount(() => {
      if (popupId) manager.unregister(popupId);
    });

    return () => {
      if (!shouldRender.value && !props.modelValue) return null;
      return (
        <Teleport to="body">
          <Transition name="s-modal-overlay" appear>
            {props.modelValue ? (
              <div class="s-modal-overlay" onClick={onOverlayClick} />
            ) : null}
          </Transition>
          <div class="s-modal-root" onKeydown={onKeydown}>
            <Transition
              name="s-modal-content"
              appear
              onBeforeEnter={onBeforeEnter}
              onAfterEnter={onAfterEnter}
              onBeforeLeave={onBeforeLeave}
              onAfterLeave={onAfterLeave}
            >
              {props.modelValue ? (
                <div
                  ref={panelRef}
                  class="s-modal"
                  role="dialog"
                  aria-modal="true"
                  aria-label={props.title}
                  style={style.value}
                  tabindex="-1"
                >
                  {props.title ? (
                    <header class="s-modal__header">
                      <h2 class="s-modal__title">{props.title}</h2>
                      {props.closeable ? (
                        <button class="s-modal__close" onClick={close} aria-label="Close">
                          <X size={16} />
                        </button>
                      ) : null}
                    </header>
                  ) : null}
                  <div class="s-modal__body">{slots.default?.()}</div>
                  {slots.footer ? <footer class="s-modal__footer">{slots.footer()}</footer> : null}
                </div>
              ) : null}
            </Transition>
          </div>
        </Teleport>
      );
    };
  },
});
