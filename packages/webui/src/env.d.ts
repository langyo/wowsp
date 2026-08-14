/// <reference types="vite/client" />

namespace JSX {
  // Vue's JSX global types (vue/jsx.d.ts) are not loaded for .tsx files;
  // provide the same permissive element table so Teleport/Transition and
  // inline components type-check without per-file imports.
  interface Element {
    [key: string]: unknown;
  }
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
