/**
 * The realm codes the app knows (ru/eu/na/asia/cn — mirrors the Rust
 * wg_realm host table). One shared list so the probe-identity validators,
 * the account store and the overlay window (a bare page that cannot load
 * Pinia stores) can never drift apart.
 */
export const KNOWN_REALMS = ["ru", "eu", "na", "asia", "cn"] as const;

export const isKnownRealm = (code: string): boolean =>
  (KNOWN_REALMS as readonly string[]).includes(code);
