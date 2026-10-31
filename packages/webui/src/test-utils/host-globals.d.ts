/**
 * Host bridges the Tauri shell installs on `window` before page load.
 *
 * `__TAURI__` is declared in `main.ts` as `unknown` (the app and the three
 * overlay entries each use a different slice of it, see `HostWindow` in
 * `@/utils/typing`). `__TAURI_INTERNALS__` — the v2 IPC/asset bridge, which the
 * app only ever probes with `"__TAURI_INTERNALS__" in window` — was never
 * declared anywhere, so every mock-mode test that stubbed or cleared it had to
 * double-cast `window` to a record first.
 *
 * It is an opaque host record (`convertFileSrc` plus the IPC plumbing behind
 * it have no publishable type), so the record itself IS the honest
 * declaration. Note this is a declaration of what the host may install, not a
 * guarantee it is there: the property stays optional and every consumer keeps
 * its `in` check.
 */
declare global {
  interface Window {
    __TAURI_INTERNALS__?: Record<string, unknown>;
  }
}

export {};
