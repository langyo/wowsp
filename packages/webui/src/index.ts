/**
 * Public barrel for the @wowsp/shared_ui alias (which points back at this src).
 * Re-export the curated public surface here; internal modules use `@/` deep
 * imports. Pattern adapted from shittim-chest's webui barrel.
 */

export { default as App } from "./App";
export { default as SButton } from "@/components/base/SButton";
export * from "@/rpc";
export * from "@/transport";
export * from "@/stores/config";
export * from "@/stores/overlay";
export * from "@/stores/popupRegistry";
export * from "@/stores/replay";
