// Android APK build path contract (2026-10-30).
//
// The Android NDK's lld receives rustc's target paths as GBK bytes on Windows
// and cannot open them when the checkout lives under a non-ASCII directory
// (the maintainer's own D:\源代码\... tree): the link dies with
// "cannot find version script" / "cannot open ...rcgu.o". AGP's own path check
// is disabled in gen/android/gradle.properties; these pins keep the Rust half
// alive on BOTH entry points — the justfile's `just build android-apk` and
// Android Studio's Gradle build — by requiring an ASCII CARGO_TARGET_DIR from
// the shared resolver.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf-8");

const justfile = read("../../../justfile");
const resolver = read("../../../scripts/android_cargo_target.py");
const buildTask = read(
  "../../app/tauri/gen/android/buildSrc/src/main/java/com/langyo/wowsp/kotlin/BuildTask.kt",
);
const gradleProperties = read("../../app/tauri/gen/android/gradle.properties");

describe("Android build ASCII target-dir isolation", () => {
  it("routes the justfile android recipe through the ASCII resolver", () => {
    const start = justfile.indexOf("_build-android *FLAGS=");
    const end = justfile.indexOf("_build-android-apk", start);
    expect(start, "the _build-android recipe exists").toBeGreaterThanOrEqual(0);
    const recipe = justfile.slice(start, end === -1 ? undefined : end);
    expect(recipe).toContain("scripts/android_cargo_target.py");
    expect(recipe).toContain("CARGO_TARGET_DIR");
  });

  it("gives Android Studio the same ASCII target dir via BuildTask", () => {
    expect(buildTask).toContain('environment("CARGO_TARGET_DIR"');
    expect(buildTask).toContain("WOWSP_ANDROID_CARGO_TARGET");
    expect(buildTask).toContain("wowsp-android-target");
  });

  it("keeps the resolver's ASCII guard and override hook", () => {
    expect(resolver).toContain("WOWSP_ANDROID_CARGO_TARGET");
    expect(resolver).toContain('encode("ascii")');
    expect(resolver).toContain("wowsp-android-target");
  });

  it("keeps the AGP non-ASCII path override that the resolver complements", () => {
    expect(gradleProperties).toContain("android.overridePathCheck=true");
  });
});
