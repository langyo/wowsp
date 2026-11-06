/**
 * WoWSP AI (decision model) identity — the ONE place the app derives the
 * model version stamped on AI surfaces.
 *
 * The two decision heads (fire / move) ship with the app, so the model
 * version follows the app version; {@link AI_WEIGHTS_TRAINED_AT} marks the
 * training run that produced the current weights. A model-pack update bumps
 * that constant in the same PR — no other module carries a model version, and
 * every AI surface (today the report sheet's footer) reads it from here.
 */
export const AI_WEIGHTS_TRAINED_AT = "2026-10-31";

/** The decision model's identity as displayed on AI artifacts. */
export interface AiModelVersion {
  /** The app version the weights are published with (the AI version follows
   *  the WoWSP release train for now). */
  version: string;
  /** Date (YYYY-MM-DD) of the training run behind the current weights. */
  trainedAt: string;
}

/** Build-time app version. Guarded for vitest/browser contexts where the
 *  vite define is absent (a bare reference would throw). */
function appVersion(): string {
  const injected = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "";
  return injected.trim() || "dev";
}

/** The current model identity (app version + last weights training date). */
export function aiModelVersion(): AiModelVersion {
  return { version: appVersion(), trainedAt: AI_WEIGHTS_TRAINED_AT };
}
