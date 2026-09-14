/**
 * Maps a remote image URL onto the app's proxied `media` protocol: the
 * request is served by the Rust backend, which honors the configured
 * network proxy and disk-caches the result under the app cache. Outside
 * the Tauri shell (browser dev / mock backend) the raw URL is returned —
 * plain webviews have no media.localhost to serve it.
 */
const MEDIA_BASE = "http://media.localhost";

export function mediaImageUrl(url: string): string {
  if (!/^https:\/\//i.test(url)) return url;
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return url;
  return `${MEDIA_BASE}/image?url=${encodeURIComponent(url)}`;
}
