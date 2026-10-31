/// <reference types="vite/client" />

namespace JSX {
  // Vue's JSX global types (vue/jsx.d.ts) are not loaded for .tsx files;
  // provide the same permissive element table so Teleport/Transition and
  // inline components type-check without per-file imports.
  //
  // JSX expressions (fragments, component elements) ARE Vue VNodes at
  // runtime; typing them as the permissive record below forced a cast at
  // every site that hands a rendered node to a `VNode` prop. Element is
  // therefore the real VNode, intersected with the open attribute bag this
  // file exists for. (A heritage clause cannot extend an `import()` type —
  // TS2499 — so the alias goes through a type, not `interface extends`.)
  type Element = import("vue").VNode & { [key: string]: unknown };
  interface ElementClass {
    $props: Record<string, unknown>;
  }
  interface ElementAttributesProperty {
    $props: Record<string, unknown>;
  }
  interface IntrinsicAttributes {
    [key: string]: unknown;
  }
  interface IntrinsicElements {
    [name: string]: unknown;
  }
}

declare const __APP_VERSION__: string;

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<object, object, unknown>;
  export default component;
}

declare module "@/theme/theme.scss" {
  const css: string;
  export default css;
}
