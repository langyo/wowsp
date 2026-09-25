import { computed, defineComponent, type PropType } from "vue";

import { ChevronDown, FolderOpen } from "lucide-vue-next";

import { HkAffixPicker, HkButton, HkInput, type HkAffixOption } from "@celestia-island/hikari";

import type { PathFieldStrings } from "../i18n";

import "./PathField.scss";

/** One enumerated drive, as the backend's `list_drives` reports it. */
export interface DriveInfo {
  mount: string;
  kind: string;
  label?: string | null;
}

/** Windows drive-letter prefix (`X:\` / `X:/`), case-insensitive. */
const DRIVE_PREFIX = /^[A-Za-z]:[\\/]/;

/**
 * PathField — the install-location editor, composed like hikari's own
 * HkPhoneInput: the drive lives in the prefix slot as an HkAffixPicker
 * chip (the mount is shown once, on the chip), while the mono HkInput
 * holds only the rest of the path relative to that mount. Picking a
 * mount rewrites the path in place (old prefix stripped, leading
 * separators trimmed), the typed remainder stays untouched. Typing or
 * pasting a drive-prefixed absolute path into the box is accepted
 * verbatim, and an emptied box falls back to the bare mount root. The
 * contract with the host is unchanged — modelValue always carries the
 * full absolute path in both directions. The right end keeps the
 * classic 浏览… directory browse.
 *
 * Presentational only — drives come in through props, both events go
 * out; the field's blur re-emits so the host can run its root-dir
 * nesting pass when the user leaves the box.
 */
export default defineComponent({
  name: "PathField",
  props: {
    modelValue: { type: String, default: "" },
    disabled: { type: Boolean, default: false },
    drives: { type: Array as PropType<DriveInfo[]>, default: () => [] },
    /** Localized labels (browse button, picker chrome, drive kinds) —
     *  resolved by the host from the wizard locale each render. */
    labels: { type: Object as PropType<PathFieldStrings>, required: true },
  },
  emits: {
    "update:modelValue": (_value: string) => true,
    browse: () => true,
    blur: (_e: FocusEvent) => true,
  },
  setup(props, { emit }) {
    /** The mount the current value starts with, longest match first
     *  (a Windows drive letter, else the deepest known unix mount). */
    const selectedMount = computed<string>(() => {
      const value = props.modelValue;
      if (DRIVE_PREFIX.test(value)) {
        const letter = `${value[0].toUpperCase()}:\\`;
        return props.drives.some((d) => d.mount.toUpperCase() === letter) ? letter : "";
      }
      const matches = props.drives
        .map((d) => d.mount)
        .filter((mount) => value.startsWith(mount))
        .sort((a, b) => b.length - a.length);
      return matches[0] ?? "";
    });

    const options = computed<readonly HkAffixOption[]>(() =>
      props.drives.map((drive) => ({
        key: drive.mount,
        label: drive.mount,
        meta: props.labels.kinds[drive.kind] ?? props.labels.kinds.unknown,
        keywords: drive.label ?? "",
      })),
    );

    /** What the input box shows: the modelValue minus the chip's mount
     *  (and any leftover separators) — the drive itself is displayed once,
     *  on the chip, so the box never repeats the prefix. */
    const rest = computed<string>(() =>
      selectedMount.value
        ? props.modelValue
            .slice(selectedMount.value.length)
            .replace(/^[\\/]+/, "")
        : props.modelValue,
    );

    /** Input edits re-join the box's remainder onto the chip's mount. A
     *  value that carries its own drive prefix (typed or pasted absolute
     *  path) passes through verbatim; an emptied box falls back to the
     *  bare mount root (the host's blur pass re-nests a product folder
     *  under it). */
    function editRest(v: string) {
      if (DRIVE_PREFIX.test(v)) {
        emit("update:modelValue", v);
      } else if (!v) {
        emit("update:modelValue", selectedMount.value || "");
      } else {
        emit(
          "update:modelValue",
          selectedMount.value ? selectedMount.value + v : v,
        );
      }
    }

    /** Rewrites the path around the picked mount: strip whatever prefix
     *  the value currently starts with, trim the leftover separators,
     *  then join onto the new mount (which already ends with its own). */
    function pickMount(mount: string) {
      let rest = props.modelValue;
      if (DRIVE_PREFIX.test(rest)) {
        rest = rest.slice(3);
      } else if (selectedMount.value) {
        rest = rest.slice(selectedMount.value.length);
      }
      rest = rest.replace(/^[\\/]+/, "");
      const joined = /^[\\/]$/.test(mount.slice(-1))
        ? mount + rest
        : `${mount}/${rest}`;
      emit("update:modelValue", rest ? joined : mount);
    }

    return () => (
      <div class="path-field">
        <HkInput
          modelValue={rest.value}
          onUpdate:modelValue={editRest}
          disabled={props.disabled}
          spellcheck={false}
          align="start"
          id="dir-input"
          autocomplete="off"
          onBlur={(e: FocusEvent) => emit("blur", e)}
        >
          {{
            prefix: () => (
              <HkAffixPicker
                options={options.value}
                mode="single"
                side="prefix"
                selected={selectedMount.value}
                disabled={props.disabled}
                chipClass="path-field-chip"
                chipLabel={props.labels.chipLabel}
                title={props.labels.pickerTitle}
                searchPlaceholder={props.labels.searchPlaceholder}
                emptyText={props.labels.emptyText}
                onSelect={pickMount}
              >
                {{
                  chip: () => (
                    <>
                      <span class="path-field-chip__mount" data-empty={!selectedMount.value || undefined}>
                        {selectedMount.value || props.labels.diskChip}
                      </span>
                      <ChevronDown size={12} class="path-field-chip__caret" aria-hidden="true" />
                    </>
                  ),
                }}
              </HkAffixPicker>
            ),
          }}
        </HkInput>
        <HkButton
          variant="ghost"
          disabled={props.disabled}
          onClick={() => emit("browse")}
        >
          <FolderOpen size={14} />
          {props.labels.browse}
        </HkButton>
      </div>
    );
  },
});
