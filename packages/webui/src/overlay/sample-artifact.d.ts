/** Ambient typings for the tests that touch the real file system — the
 *  overlay sample renderer (renderSample.test.ts, writes a reviewable
 *  artifact) and the live-calibration corpus bench
 *  (liveSelfCalibrationCorpus.test.ts, reads the gitignored ndjson
 *  fixture): the package is browser-typed (@types/node deliberately
 *  absent), so this declares just the node surface those tests use —
 *  nothing else should grow onto it. */
declare module "node:fs" {
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: string): string;
  export function writeFileSync(path: string, data: string, encoding?: string): void;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function dirname(path: string): string;
}

declare const process: {
  cwd(): string;
};
