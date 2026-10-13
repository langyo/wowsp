/** Ambient typings for the ONE overlay test that writes a reviewable
 *  artifact to disk (renderSample.test.ts): the package is browser-typed
 *  (@types/node deliberately absent), so this declares just the node
 *  surface that test uses — nothing else should grow onto it. */
declare module "node:fs" {
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
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
