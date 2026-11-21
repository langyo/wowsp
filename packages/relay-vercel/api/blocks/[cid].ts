import { handleBlockEnvelope } from "../../src/blocks";

// Edge runtime pre-requisite (Vercel docs: Edge Runtime / Configuring
// the Runtime). Verified 2026-11: the per-file export is the current
// documented mechanism; see README "Deploy" for the walkthrough.
export const config = { runtime: "edge" };

export default function handler(request: Request): Promise<Response> {
  // Vercel passes no route params to plain api handlers: the dynamic
  // segment is read back off request.url (src/blocks.ts).
  return handleBlockEnvelope(request);
}
