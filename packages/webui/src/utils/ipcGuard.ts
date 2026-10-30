/**
 * Startup IPC guard: the Tauri shell reaches Rust over the webview's
 * `ipc.localhost` host. A proxy client or firewall that hijacks loopback
 * hostnames can wedge that channel while the locally-served UI still
 * paints — every button then silently does nothing, the worst failure
 * shape this app has. The guard probes one cheap command after mount:
 * only a TIMEOUT (a rejection still proves the channel answered) raises
 * the reload notice, and the notice removes itself as soon as a later
 * probe answers.
 */
import { getVersion } from "@tauri-apps/api/app";

import { t } from "@/i18n";

const PROBE_TIMEOUT_MS = 4_000;
const RETRY_INTERVAL_MS = 5_000;
const NOTICE_ID = "wowsp-ipc-guard";

/** Distinguishes "the channel hung" from "the channel answered with an
 *  error" — only the former is the hijacked-loopback shape. */
class IpcTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new IpcTimeoutError()), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** True = the channel answered (success OR an error response), false = hung. */
export async function ipcChannelAnswers(probe: () => Promise<unknown>): Promise<boolean> {
  try {
    await withTimeout(probe(), PROBE_TIMEOUT_MS);
    return true;
  } catch (error) {
    return !(error instanceof IpcTimeoutError);
  }
}

function removeNotice(): void {
  document.getElementById(NOTICE_ID)?.remove();
}

/** The blocking notice (idempotent: one instance). */
function showNotice(): void {
  if (document.getElementById(NOTICE_ID)) return;
  const root = document.createElement("div");
  root.id = NOTICE_ID;
  root.className = "wowsp-ipc-guard";
  root.setAttribute("role", "alertdialog");
  root.setAttribute("aria-live", "assertive");

  const card = document.createElement("div");
  card.className = "wowsp-ipc-guard__card";

  const title = document.createElement("h2");
  title.className = "wowsp-ipc-guard__title";
  title.textContent = t("common.ipcBlockedTitle");

  const body = document.createElement("p");
  body.className = "wowsp-ipc-guard__body";
  body.textContent = t("common.ipcBlockedBody");

  const button = document.createElement("button");
  button.type = "button";
  button.className = "wowsp-ipc-guard__button";
  button.textContent = t("common.reload");
  button.addEventListener("click", () => window.location.reload());

  card.append(title, body, button);
  root.append(card);
  document.body.append(root);
}

/** Probe the channel once; on a hung channel raise the notice and keep
 *  polling until it answers (the notice then removes itself). */
export async function startIpcGuard(
  options: {
    probe?: () => Promise<unknown>;
    /** Defaults to "is this the Tauri shell" — injectable for tests. */
    isShell?: boolean;
  } = {},
): Promise<void> {
  // getVersion() from the Tauri API is a plain IPC round trip — the
  // cheapest real message the webview can send the shell.
  const probe = options.probe ?? (() => getVersion());
  const shell = options.isShell ?? "__TAURI_INTERNALS__" in window;
  if (!shell) return;
  if (await ipcChannelAnswers(probe)) return;
  showNotice();
  const timer = window.setInterval(() => {
    void ipcChannelAnswers(probe).then((answers) => {
      if (!answers) return;
      window.clearInterval(timer);
      removeNotice();
    });
  }, RETRY_INTERVAL_MS);
}
