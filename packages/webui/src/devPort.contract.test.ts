// Dev-server port isolation contract (2026-10-30 incident).
//
// The WoWSP window loaded a FOREIGN app: a neighboring project's Vite dev
// server held Vite's shared default :5173, WoWSP's Vite silently fell back to
// :5174 while packages/app/tauri/tauri.conf.json's devUrl stayed on :5173, and
// the Tauri webview pointed at the neighbor's page. WoWSP therefore moved to
// its own dedicated dev port (127.0.0.1:5199), and these pins keep the places
// that name it in lockstep and force the fail-LOUD behavior that makes the bug
// impossible:
//   - vite.config.ts: server.host 127.0.0.1, server.port 5199 AND
//     strictPort: true (no silent fallback),
//   - tauri.conf.json: build.devUrl is exactly http://127.0.0.1:5199,
//   - scripts/dev.py: VITE_PORT = 5199 and the port guard runs on BOTH the
//     Vite-launching path and the default native `cargo tauri dev` path
//     (`just dev`), so a held port aborts before Tauri can open at all.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf-8");

const viteSource = read("../vite.config.ts");
const tauriConfig = JSON.parse(read("../../app/tauri/tauri.conf.json")) as {
  build: { devUrl: string; beforeDevCommand: string };
};
const devPySource = read("../../../scripts/dev.py");

/** One Python function body (from `def name(` up to the next top-level def). */
function pyFunction(source: string, name: string): string {
  const start = source.indexOf(`def ${name}(`);
  expect(start, `${name} exists in scripts/dev.py`).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start);
  const next = rest.indexOf("\ndef ", 1);
  return next === -1 ? rest : rest.slice(0, next);
}

/** The `server: { ... }` block of the Vite config (up to `build: {`). */
function viteServerBlock(source: string): string {
  const start = source.indexOf("server: {");
  expect(start, "vite.config.ts declares a server block").toBeGreaterThanOrEqual(0);
  const end = source.indexOf("build: {", start);
  return end === -1 ? source.slice(start) : source.slice(start, end);
}

describe("dev server port isolation", () => {
  it("pins the WoWSP dev port in all three declarations", () => {
    expect(viteServerBlock(viteSource)).toMatch(/port:\s*5199\b/);
    expect(viteServerBlock(viteSource)).toMatch(/host:\s*["']127\.0\.0\.1["']/);
    expect(tauriConfig.build.devUrl).toBe("http://127.0.0.1:5199");
    expect(devPySource).toMatch(/^VITE_PORT\s*=\s*5199$/m);
  });

  it("makes Vite fail instead of silently moving to a fallback port", () => {
    // Without strictPort Vite auto-increments while the Tauri devUrl stays on
    // the pinned port — that is exactly how the foreign page got loaded.
    expect(viteServerBlock(viteSource)).toMatch(/strictPort:\s*true/);
  });

  it("guards the default native dev path before launching Tauri", () => {
    expect(devPySource).toMatch(/def _require_vite_port_free\(/);
    expect(pyFunction(devPySource, "run_native")).toContain("_require_vite_port_free()");
    expect(pyFunction(devPySource, "start_vite")).toContain("_require_vite_port_free()");
  });

  it("keeps the guard's error message actionable (names the pid/process)", () => {
    const guard = pyFunction(devPySource, "_require_vite_port_free");
    expect(guard).toContain("NOT WoWSP's dev server");
    expect(pyFunction(devPySource, "_port_occupied_by")).toContain("_describe_pid(pid)");
  });
});