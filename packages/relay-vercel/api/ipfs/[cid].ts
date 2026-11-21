import { handleBlockRaw } from "../../src/blocks";

// Edge runtime pre-requisite (Vercel docs: Edge Runtime / Configuring
// the Runtime). Verified 2026-11: the per-file export is the current
// documented mechanism; see README "Deploy" for the walkthrough.
export const config = { runtime: "edge" };

export default function handler(request: Request): Promise<Response> {
  // /ipfs/<cid> is the IPFS-gateway-path alias of /raw (§4.2).
  return handleBlockRaw(request, "ipfs");
}
