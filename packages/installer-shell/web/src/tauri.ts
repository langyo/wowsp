/**
 * Minimal access to the `withGlobalTauri` global API. The installer shell
 * enables `app.withGlobalTauri`, so no npm @tauri-apps packages are needed
 * for this tiny frontend.
 */

interface TauriGlobal {
  core?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
  event?: { listen?: (event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void> };
  dialog?: { open?: (options?: { directory?: boolean; title?: string }) => Promise<string | string[] | null> };
  window?: {
    getCurrentWindow?: () => {
      minimize(): Promise<void>;
      close(): Promise<void>;
    };
  };
}

function tauri(): TauriGlobal | null {
  return (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__ ?? null;
}

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const invoke = tauri()?.core?.invoke;
  if (!invoke) throw new Error("Tauri API 不可用");
  return invoke(cmd, args) as Promise<T>;
}

export async function listen(event: string, handler: (payload: unknown) => void): Promise<void> {
  const listen = tauri()?.event?.listen;
  if (!listen) return;
  await listen(event, (e) => handler(e.payload));
}

export async function openDirectory(title: string): Promise<string | null> {
  const open = tauri()?.dialog?.open;
  if (!open) return null;
  const picked = await open({ directory: true, title });
  return typeof picked === "string" ? picked : null;
}
