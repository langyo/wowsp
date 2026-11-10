# AI model distribution: Hugging Face channel and multi-provider mirrors (design contract)

> Status: DRAFT — the implementation contract for the `feat/ai-models` wave.
> Scope: publish the built-in decision/scoring models (ONNX weights, the
> ship-attribute routing table and the per-map terrain-LOS rasters) plus
> their training/deployment scripts to a public Hugging Face model
> repository; serve them to clients through a new signed `ai` resource
> channel with per-file downloads; and generalize the GitHub-only mirror
> ladder into a provider-aware mirror context shared by every downloadable
> resource.
>
> Out of scope: the frozen app-update channel, the `res-latest` resource
> pack (it stays on GitHub Releases), the training pipeline itself, and
> replay-dataset publication.

## 1. Problem and goals

The built-in decision models (the ONNX fire/move scoring heads, the
attribute-routed advice model, the optional torpedo model, the routing
table and the per-map terrain line-of-sight rasters) have **no distribution
channel at all**. They exist as gitignored training outputs under
`scripts/experiments/out/`; the installed `<cache>/decisions` pack is a
hand-copied directory that the app can only inventory and clear. There is
no publisher script, no manifest, no digest, no downloader, no version
stamp and no coverage guarantee — today 35 of the 96 known map ids carry a
LOS raster, the two installed models are older and roughly half the size
of the current fp32 exports, and the advice/torpedo slots are simply empty.

At the same time the app already knows how to serve a richer pack: the
`res-latest` resource pack is published from this repository, mirrored
through a ghproxy-style ladder for mainland-China networks, verified
against official sha256 digests and applied atomically. The decision-model
channel should reach the same engineering standard without inheriting the
1.3 GB resource pack's constraints.

Goals:

1. **One public, reproducible artifact.** Every model release is generated
   by a checked-in script from a named repository commit and published to
   a public Hugging Face model repository together with its training and
   deployment scripts.
2. **Updates independent of app releases — within a feature contract.**
   A retrained model can reach installed clients without a new app build
   as long as its input/feature schema matches the running featurizer; a
   schema change is an app release by definition.
3. **Integrity before execution.** The model files are parsed and
   executed by ONNX Runtime, so the channel is fail-closed: a signed
   manifest pins every file's sha256 and the Hugging Face commit, and an
   unsigned or mismatched payload is never installed.
4. **Mainland reachability.** The runtime ladder must work where
   `huggingface.co` is unreachable (verified from the maintainer network)
   without hard-coding a single third-party mirror.
5. **One mirror framework.** GitHub, Hugging Face and (later) ModelScope
   share one provider-aware context — candidate rewriting, probing,
   health/sticky selection and drift-checked endpoint lists — instead of
   five copies of a ghproxy prefix list.
6. **No secrets in the tree.** Hugging Face credentials live in the
   environment or the user token store; never in a tracked file.

### 1.1 Measured inputs

| Artifact | Source (dev checkout) | Size |
| --- | --- | --- |
| fire model (fp32, v2 ablate NONE) | `scripts/experiments/out/fire_model/v2plain_std/fp32.onnx` | 2,592,543 B |
| movement model (fp32, 17-class, ablate E11) | `scripts/experiments/out/move_model/node3/main/fp32.onnx` | 2,652,542 B |
| advice fire model (fp32, E24 attribute-routed) | `scripts/experiments/out/fire_model/e24_attrs/fp32.onnx` | 2,595,135 B |
| torpedo T4 model (fp32, 49-wide global block, three heads A/B/C, calibrated temperatures baked at export) | `scripts/experiments/out/torpedo_model/final_torp4/fp32.onnx` | 502,518 B |
| legacy torpedo model (fp32, 38-wide global block, two heads; older releases only) | `scripts/experiments/out/torpedo_model/final/fp32.onnx` | 492,411 B (int8 136,214 B) |
| ship-attribute routing table | `scripts/experiments/ship_attributes.json` | 261,507 B |
| terrain-LOS rasters | `bake_terrain_los.py` output, one `terrain_los.npz` per map | 5,986-221,638 B each (35 maps installed) |

Every file is far below the 10 MB update-size budget. The Hub still stores
binary blobs through Xet/LFS, so `/resolve/` answers a signed CDN redirect
rather than 200; the downloader follows it (Range/resume on the final host)
without an Xet client, and the signed manifest plus the per-file sha256
keep the bytes authoritative (see 4.2 and 7.8).

## 2. Current state

| Area | Today | Consequence |
| --- | --- | --- |
| Model publication | none | models cannot reach users except by a manual copy |
| Installed pack | `<LOCALAPPDATA>/WoWSP/decisions`, hand-copied | stale/partial; no stamp; wrong-generation models undetectable |
| Model loading | `decision_serve` ladder env -> pack slot -> dev output; `ship_attrs` uses a compile-time `include_str!` table | a routing-table change needs an app release; the "pack overrides the embedded table" comment is not implemented |
| Resource pack | GitHub `res-latest` + delta chain + relay-signed digests | mature; stays as-is |
| Mirror ladder | GitHub-only host list with ghproxy prefix concatenation; copies in Rust, Cargo metadata, Python, website, webui mock and relay CSP | cannot front `huggingface.co`; drift is only tested for one copy |
| Mobile | ONNX Runtime is a default feature, so Android/iOS builds ship ONNX; the decisions pack is not bundled | mobile would benefit from the same channel |
| Registry row | `decisions-pack`, channel empty, trigger `manual` | no check/download buttons, no freshness ledger entry |

This wave therefore **creates a channel**; it does not migrate one.

> **Implementation status.** The channel is live. Seq 2 was the original four-model release (with 35 terrain-LOS rasters baked against resource-pack tree `6855322b…`). **Seq 3 is now published** (2026-11-10, revision `366b2b58…`, tree `0882c879…`): fire/move/advice/**T4 torpedo4_model.onnx** + ship_attributes, no LOS. The retired T2 `torpedo_model.onnx` is archive-only on the previous artifact commit under `legacy-2-20261110` and `legacy-torpedo-e26d-20261110`. The publish was written through `hf-mirror.com` because the host's official endpoint was TLS-unreachable.
>
> **Migration.** A T4-aware client accepts the new slot and prefers it at runtime; older clients refuse the seq 3 manifest at the contract check and keep their installed seq 2 pack (the `seq` ratchet never downgrades). **The client release carrying the T4 slot must ship before ordinary users can update through seq 3**; until then the published model release is ahead of the stable client.
>
> **Architecture/weight rule.** Post-training updates bump the manifest seq and archive the previous artifact commit under date-suffixed `legacy-*` tags; without a new architecture, slots/kinds/featureSets do not change. The GitHub registry `scripts/experiments/model_registry.json` is the source of truth.

## 3. Architecture overview

Three layers, each with one job:

```text
  GitHub repo (source of truth)
      |  python scripts/publish_ai_models.py  (hash -> sign -> upload)
      v
  Hugging Face model repo  wowsp-d1  (generated release artifact + scripts snapshot)
      |  signed manifest.json + per-file resolve/<commit-sha>/<path>
      v
  client  commands/ai_pack.rs  --->  commands/mirror/ (MirrorContext)
      |      per-file download via download_hub        GitHub | Hugging Face | ModelScope
      v
  <cache>/decisions  (fire/move/advice/torpedo4 (+ legacy torpedo) + attrs + <map>/terrain_los.npz)
```

| Decision | Choice | Why |
| --- | --- | --- |
| Download source | Hugging Face only in v1 (plus built-in `hf-mirror.com`); GitHub Release fallback and ModelScope are later providers | one publication path to verify; the mirror context makes adding a provider cheap |
| Manifest trust anchor | self-signed manifest using the existing pinned Ed25519 keys and a `seq` ratchet | Hugging Face exposes no official per-asset digest; a relay digest channel would add a deploy step per model release for no extra assurance |
| Transfer unit | one file per artifact, atomic staging install | all files < 10 MB; incremental updates; the hub already supports per-segment progress, sha256, caps, resume and cancel |
| Mirror selection | provider-aware ladder with cold-start hedging, per-pass sticky endpoint and health cooldown | official hosts are unreachable for part of the audience; deterministic user-listed order must be preserved |
| Resource pack | unchanged, GitHub-only | 5.7k files, delta chain and GitHub asset digests remain the better fit |

## 4. Hugging Face repository

### 4.1 Layout

```text
wowsp-d1/                          public model repository (owner/repo TBD, see 11)
  README.md                        model card: purpose, provenance, metrics, file table, licence
  LICENSE                          Synthetic Source License 1.0 (same as the app repo)
  manifest.json                    signed runtime manifest (section 5)
  NOTICE.md                        game-data provenance and redistribution note (section 4.5)
  onnx/fire_model.onnx
  onnx/move_model.onnx
  onnx/advice_fire_model.onnx
  onnx/torpedo4_model.onnx          current T4 three-head torpedo diagnostic
  onnx/torpedo_model.onnx           legacy two-head slot (older releases only)
  onnx-int8/                       optional quantized variants, never installed by default
  attrs/ship_attributes.json
  los/<mapId>/terrain_los.npz
  training/                        generated snapshot: scripts/experiments training/deployment scripts
  SOURCE.json                      {"repo","commit","generatedAt","tool":"scripts/publish_ai_models.py"}
```

`manifest.json` is the only file the app treats as the channel entry
point. Individual files are also individually downloadable by humans and
by the model card's file table.

### 4.2 File-size rule

Each repository file stays **below 10 MB** so updates stay small and
incremental. The Hub still stores binary blobs through Xet/LFS even below
that mark (a plain-Git binary push is rejected), so `/resolve/` answers a
signed CDN redirect rather than 200; the downloader follows it and keeps
Range/resume on the final host, and no Xet client is involved. LOS rasters
are one file per map today (all well below the limit); if a future pack
would exceed the limit per file, split LOS into numbered bundles that each
stay below it. The publisher refuses a staged file above 10 MB and prints
the offending path.

### 4.3 Revision model

Hugging Face revisions are commits; branches/tags can move, commit SHAs
cannot. Publication therefore uses two commits:

1. upload the artifact files (weights, attrs, LOS, scripts snapshot) ->
   commit `A`;
2. upload `manifest.json`, `README.md`, `LICENSE`, `NOTICE.md` and
   `SOURCE.json` with `"revision": "A"` inside the manifest -> commit `B`.

The app fetches `manifest.json` from the branch head (`main`), verifies
its signature, then downloads every file from
`/{repo}/resolve/{A}/{path}` — an immutable pin. A client that cached an
older manifest keeps using the older commit even after `main` advances.
Annotations (`models-<seq>` tags) are for humans only.

### 4.4 Publishing workflow and operations

`scripts/publish_ai_models.py` (modelled on `scripts/release_models.py`):

1. collect inputs (weights, `ship_attributes.json`, baked LOS directory,
   scripts snapshot from `git archive` of the named commit);
2. hash every file, build the signed manifest (section 5), compute the
   tree hash;
3. upload artifacts (commit A), then upload the manifest and docs (commit
   B, pinned to A);
4. print the release summary (seq, manifest sha256, HF commits, file
   table). `--dry-run` performs every local step without uploading.

**Account, token and repository creation.** Hugging Face has no anonymous
write path: publishing needs an account and a write token. The token is
created in the web UI (Settings -> Access Tokens, preferably a
fine-grained token limited to this repository's write scope) and is
supplied through `HF_TOKEN` or the standard user token store
(`~/.cache/huggingface/token`). The repository itself can be created by
the script through `huggingface_hub.create_repo` (REST
`POST /api/repos/create`), by the web UI, or by the optional `hf repo
create` CLI — all three are equivalent; **the CLI is not a prerequisite**.
The publisher uses the `huggingface_hub` Python API, which is also what
the official `huggingface/hub-sync` GitHub Action wraps; a CI lane may
later run the same script with `HF_TOKEN` as a repository secret (never
tracked).

**Network reality.** Only `huggingface.co` accepts writes. From mainland
China that host is not reachable directly (verified: connection timeout),
so a local publish run needs the maintainer's HTTP(S) proxy
(`HTTPS_PROXY`), or publishing runs on CI. The mirror is a read-only
proxy: runtime reads do not need a proxy, writes do. Verification after
upload can be done through the mirror (section 7.8).

**Versioning.** `seq` is a strictly increasing publish counter stored in
`manifest.json` (the publisher warns if the value does not exceed the
currently published manifest's). `version` is the UTC publish timestamp;
the content identity is `treeSha256` (section 5.4).

### 4.5 Documentation and provenance

- `README.md` is a model card: what each model does, the featurizer
  contract, evaluation numbers from `scripts/experiments/README.md`
  (auPRC/AUC/ECE/decile lift as applicable), input/output tensor shapes,
  how to reproduce, links to the exact GitHub commit, and the licence.
- `SOURCE.json` records the repository, commit, generation time and the
  exact tree hash, so a released artifact is traceable to code.
- `training/` is a **generated snapshot** of `scripts/experiments/`
  (scripts, build helpers, research log). The model card states that the
  authoritative source is the GitHub repository at the recorded commit and
  that the snapshot must not be edited on Hugging Face.
- Raw replay corpora are never published: they are user-contributed
  session data. The model card describes the corpus shape and the
  filtering/consent basis in aggregate terms only.
- `NOTICE.md` records that LOS rasters are baked from the published map
  geometry and that the attribute table is derived from game data, and
  restates the Synthetic Source License disclosure requirement. Weights
  are trained from replay-derived features. This is the same data class
  the public `res-latest` channel already ships; publishing to a second
  public host does not change the licence, but it does change visibility,
  so it is called out explicitly (section 11, decision 2).

### 4.6 Synchronization policy

GitHub is the only source of truth. Hugging Face is a generated release
artifact: no hand edits, no second development branch, no back-sync. A
model change starts in this repository (training scripts + artifacts
committed to the publisher's inputs), then a maintainer runs the publisher.
Differences between the two hosts are therefore explained by commit
provenance, not by parallel maintenance.

## 5. The signed manifest

### 5.1 Example

```json
{
  "format": 1,
  "seq": 7,
  "version": "2026-11-08T14:22:03Z",
  "revision": "0123456789abcdef0123456789abcdef01234567",
  "source": { "repo": "langyo/wowsp", "commit": "89abcdef0123456789abcdef0123456789abcdef" },
  "resTreeSha256": "3f2a...",
  "files": [
    { "path": "fire_model.onnx", "sha256": "8ba9...", "size": 2592543,
      "kind": "fire-two-head", "featureSet": "fire-v1", "quant": "fp32" },
    { "path": "move_model.onnx", "sha256": "bc91...", "size": 2652542,
      "kind": "move-sectors-17", "featureSet": "move-v1", "quant": "fp32" },
    { "path": "advice_fire_model.onnx", "sha256": "b98f...", "size": 2595135,
      "kind": "advice-fire-attrs", "featureSet": "advice-e24", "quant": "fp32" },
    { "path": "torpedo4_model.onnx", "sha256": "0b1f...", "size": 502518,
      "kind": "torpedo-t4-three-head", "featureSet": "torp4-v1", "quant": "fp32" },
    { "path": "ship_attributes.json", "sha256": "2bbd...", "size": 261507 },
    { "path": "50_Gold_harbor/terrain_los.npz", "sha256": "9c1d...", "size": 172432 }
  ],
  "treeSha256": "d41d...",
  "metrics": { "fire": { "auprc": 0.32, "auc": 0.72 } },
  "key_id": "main",
  "sig": "MEUCIQ..."
}
```

### 5.2 Fields

| Field | Meaning |
| --- | --- |
| `format` | manifest schema version (1) |
| `seq` | strictly increasing publish counter; the app refuses a value below the last one it installed |
| `version` | UTC publish timestamp, display only |
| `revision` | Hugging Face commit SHA that contains exactly the listed files |
| `source` | GitHub repository + commit the release was generated from |
| `resTreeSha256` | tree hash of the resource pack the LOS rasters were baked against (optional; absent when no LOS is shipped) |
| `files[].path` | destination path inside `<cache>/decisions`; plain relative path, segments validated (`[A-Za-z0-9._-]`, no `..`, no separators inside a segment) |
| `files[].sha256` | lowercase sha256 of the exact bytes |
| `files[].size` | byte size, used as a transfer floor/ceiling |
| `files[].kind`, `featureSet`, `quant` | model contract metadata; required for `.onnx` entries, absent for data files |
| `treeSha256` | content identity: sha256 over the sorted `path\0sha256\n` lines (identical formula to the resource pack, so the same tooling can hash both) |
| `metrics` | display metadata copied from the training report |
| `key_id`, `sig` | Ed25519 signature layer |

### 5.3 Signing and anti-rollback

The signature covers the canonical JSON of the manifest **without the
`sig` member** — keys sorted, compact separators, UTF-8 — the same
canonical form already implemented by `scripts/catalog_signing.py` and
verified by the app against compile-time pinned public keys
(`packages/app/tauri/res/keys/*.pub`). Signing reuses the existing
release-digest key ceremony; no new key pair is introduced.

The app verifies the signature before parsing fields, then applies the
`seq` ratchet: an authenticated manifest whose seq is below the locally
stored one is refused (replay/downgrade guard). A mirror can thus re-serve
an old signed manifest at worst; it can never forge one. Manifest fetch
failure or an invalid signature is a hard failure for this check — the
channel deliberately has **no** "accept an unverified mirror manifest"
fallback, because the payload is executable model content.

### 5.4 Freshness and staleness

`manifest.json` is fetched from the Hugging Face branch head. Mirror
caches may serve a stale copy for a short window; a stale manifest is
authentic but older, so the check either reports "up to date" with the old
seq or waits for the next check. The publisher's upload ordering
(artifacts first, manifest last) guarantees a manifest never names files
that are not already resolvable at its pinned revision. A cached file is
accepted only when its sha256 matches the manifest.

## 6. The runtime channel (`ai`)

### 6.1 Registry and RPC surface

| Item | Change |
| --- | --- |
| `resources.rs` registry row | `decisions-pack` becomes channel `ai`, trigger `boot` (silent check) + manual, progress kind `ai-models` |
| state ledger | add `decisions-pack` to `STAMPED_ROWS` so `<data>/resources/decisions-pack.json` records installed/checked timestamps |
| new commands | `ai_pack_status`, `ai_pack_check`, `ai_pack_download`, `ai_pack_cancel`; clearing reuses `clear_decisions_pack` (extended to remove the stamp) |
| progress | `wowsp://download-progress`, kind `ai-models`, one job per pass, per-file segments in `detail` |
| webui | Settings -> resources card (section 6.8), api module, `rpc.ts`, webMock, parity test |

### 6.2 Check sequence

1. Resolve the manifest URL through the mirror context and fetch
   `manifest.json` (small file; cold-start hedge, then sticky endpoint).
2. Verify the Ed25519 signature and canonical form; parse; apply the seq
   ratchet.
3. Compare `seq` / `treeSha256` with `<cache>/.ai-version.json` (the
   stamp lives beside `decisions/`, not inside it, so the tree hash stays
   pure). No difference -> report current.
4. When the manifest declares models the running build cannot load (see
   6.6), mark the release incompatible rather than downloading it.

The check is silent at boot behind a TTL (24 h) and always available from
the card. It never downloads; downloading stays a user action.

### 6.3 Per-file download

All files ride `download_hub::transfer` with `kind = "ai-models"`:

- candidates come from the mirror context (Hugging Face provider, pinned
  revision from the manifest), mirror prefixing never applies;
- `expected_sha256` = manifest hash, `min_bytes = max_bytes = size`,
  `total_hint = size`, `resume = true` with a per-file part name;
- one file failing falls back to the next endpoint for that file only;
  the pass keeps its already-verified bytes in the staging tree;
- progress reports aggregate bytes across the pass
  (`base_received`/`base_total`) plus `detail: {file, index, files}`;
  cancellation follows the hub's standard scope;
- files are written under `<cache>/.ai-staging/<path>`; nothing touches
  the live pack until every file is present and verified.

### 6.4 Validation before install

Before the swap, in a blocking task:

1. recompute `treeSha256` over the staged files and compare to the
   manifest (any extra/missing file fails the pass);
2. for each `.onnx` file, load it through the existing ONNX Runtime
   wrappers and classify it: kind, input widths and output heads must
   match the declared `kind`/`featureSet` (fire: 24 x `ENTITY_DIM_V2` x
   `GLOBAL_DIM_V2`; movement: 17 classes; advice: attribute-routed head;
   torpedo: `TORP_GLOBAL_DIM_V2` global block with two heads in the legacy
   slot, `TORP_GLOBAL_DIM_V4` with three heads in the T4 slot);
3. reject the pass if a required model fails; optional models (advice,
   torpedo) may be dropped with a warning only when the manifest marks
   them optional. A loaded model already cached in the process keeps
   serving until restart.

This kills the "wrong-generation pack" failure mode the current manual
pack cannot detect, at the cost of parsing a few megabytes before swap.

### 6.5 Install, stamp and rollback

1. rename `decisions` -> `.decisions-backup`, staging -> `decisions`;
2. write `<cache>/.ai-version.json` with `{schema, seq, version, revision,
   treeSha256, manifestSha256, keyId, installedAt}`;
3. record the freshness ledger row; delete the backup on success;
4. on any failure (swap, stamp, ledger) restore the backup and fail the
   command; a cancelled pass leaves the old pack untouched.

A failed validation, a crashed pass or a user cancel therefore always
falls back to the last good pack. The card offers "clear" once
`decisions` exists; the loaded session stays until restart (existing
behaviour).

### 6.6 Feature contract

Model files are coupled to the Rust featurizers that mirror the Python
training scripts. The manifest's `featureSet` values are the contract:

| Model | Kind | Feature set | Required |
| --- | --- | --- | --- |
| fire_model.onnx | fire two-head (24-entity deep sets) | `fire-v1` | yes |
| move_model.onnx | 17-class movement sectors | `move-v1` | yes |
| advice_fire_model.onnx | attribute-routed advice head | `advice-e24` | no |
| torpedo4_model.onnx | T4 three-head torpedo diagnostic (49-wide global, heads A/B/C) | `torp4-v1` | no |
| torpedo_model.onnx | LEGACY two-head torpedo model (38-wide global) | `torpedo-e26d` | no (older packs only) |

The app accepts a release only when every required model's feature set is
in its supported set and every optional model's set is either supported or
absent. A featurizer change bumps the set name in the same PR that changes
the Rust featurizer, so a stale app can never feed new weights the wrong
tensors.

**Torpedo generation migration.** The runtime ladder prefers the T4 slot
(`torpedo4_model.onnx`) and falls back to the legacy two-head file, so both
slots stay in the accepted contract and neither is required. A release that
carries only T4 is therefore installable by a client that knows the slot;
an older client (one that predates `torp4-v1`) refuses that manifest at the
contract check — it lists an unknown model file — and keeps its installed
seq 2 pack running, since the whole release is rejected before a byte is
downloaded and the `seq` ratchet never downgrades. Shipping the T4 model to
existing users therefore needs a client release first; the model release
alone only reaches clients that already understand the slot.

### 6.7 LOS rasters and the resource pack

LOS rasters are baked from the map geometry in the resource pack. When the
pack's map GLBs change (game-version bump), old rasters describe old
terrain. The manifest's optional `resTreeSha256` records the pack tree
the rasters were baked against; the app compares it with the installed
pack's stamp and, on mismatch, installs the models but skips the LOS
files (the existing per-map lookup already tolerates missing rasters) and
tells the user to update the resource pack first. The publisher bakes LOS
after the pack publish and records the same tree hash.

### 6.8 UI, i18n and mobile

- The Settings -> resources card gains: current version (published-at and
  tree hash suffix), per-model rows with presence/size/sha prefix, LOS
  coverage (`x/known maps`), total size, check/download/cancel buttons,
  restart hint, and the mirror ladder group (section 7.6).
- i18n: the existing 13 `settings.resourcesDecisions*` keys are extended
  with check/download/progress/version/LOS-coverage strings across the
  eight settings locales (en-US, zh-CN, zh-TW, ja-JP, ko-KR, fr-FR, es-ES,
  ru-RU); the correctness limit is `scripts/check_i18n.py`.
- Mobile uses the same channel (ONNX Runtime is already a default
  feature). The slim APK downloads models on demand; bundling a baseline
  into the installers/APKs is a later option (section 10, PR4).
- A build without the `ai` feature (portable flavour) does not link ONNX
  Runtime: the channel is either hidden or shown as unavailable, and
  never downloads unloadable models.

### 6.9 Failure modes

| Failure | Behaviour |
| --- | --- |
| No mirror reachable / manifest 4xx-5xx | check fails, current pack keeps serving, reason logged and shown in the card |
| Signature invalid / seq regression | hard failure; no install, no fallback to unverified content |
| File sha mismatch | that candidate is discarded; the next endpoint is tried; the pass fails if all fail |
| Model load/kind/width mismatch | pass rejected before swap; old pack restored |
| LOS mapped to a different resource-pack tree | models installed, LOS skipped with an explanatory warning |
| Disk full / cancel | staging cleaned or kept for resume; live pack untouched |
| App updated, feature set bumped | old models stay installed but are not loaded by the new build until a compatible release is installed |

## 7. The mirror context

### 7.1 Current pain

`github_mirror.rs` knows only `github.com`/`api.github.com` and rewrites
with `{prefix}/{full-url}`. Hugging Face mirrors instead substitute the
endpoint base and keep the path; ModelScope has a different path template.
The built-in list is duplicated in the app, `Cargo.toml`'s shun metadata,
`scripts/fetch_models.py`, the website download page, the webui mock and
the relay CSP; only the Cargo copy is drift-tested. Six consumers
(`update`, `model_pack`, `data_pack`, `mod_catalog`, `changelog`,
`media`) each walk their own loop.

### 7.2 Provider model

New module `packages/app/tauri/src/commands/mirror/`:

```rust
pub enum ProviderId { GitHub, HuggingFace, ModelScope }

pub enum Rewrite {
    UrlPrefix,                                  // GitHub: {prefix}/{official_url}
    Endpoint { template: &'static str },        // HF: {base}/{repo}/resolve/{rev}/{path}
                                                // MS: {base}/models/{repo}/resolve/{rev}/{path}
}

pub struct HfResource<'a> {
    pub repo: &'a str,      // "owner/name"
    pub revision: &'a str,  // pinned commit sha (validated as a plain segment)
    pub path: &'a str,      // repository-relative file path (validated segment by segment)
}

pub struct MirrorContext { /* config snapshot, provider ladders, health/last-good cache */ }

impl MirrorContext {
    pub fn candidates(&self, target: Target<'_>) -> Vec<Candidate>;
    pub fn probe(&self, provider: ProviderId) -> Vec<ProbeRow>;
    pub fn sticky(&self, provider: ProviderId) -> Option<Endpoint>;
}
```

The download hub keeps taking `Vec<String>` sources: provider resolution
is a pure function of (config, target). Digest/signature policy stays in
each channel, preserving the invariant that a mirror URL is a transport,
never a content identity.

### 7.3 URL matrix

| Provider | Official | Mirror rewrite | Probe |
| --- | --- | --- | --- |
| GitHub | `https://github.com/langyo/wowsp/releases/download/<tag>/<asset>` | `{ghproxy-prefix}/{official-url}` | repo `releases/latest` page (existing) |
| Hugging Face | `https://huggingface.co/{repo}/resolve/{rev}/{path}` | `{endpoint}/{repo}/resolve/{rev}/{path}` (e.g. `https://hf-mirror.com/...`) | pin a small file: `{endpoint}/{repo}/resolve/{rev}/manifest.json`, HEAD or `Range: bytes=0-1023`, accept 200/206 |
| ModelScope (later) | `https://www.modelscope.cn/models/{repo}/resolve/{rev}/{path}` | endpoint substitution, same template | HEAD `resolve/{rev}/manifest.json` |

Hugging Face API endpoints (`/api/models/...`) are never on the download
path; if a probe wants metadata it uses a pinned file, because the
anonymous API bucket is far tighter than the resolver bucket.

### 7.4 Selection, health and hedging

- Candidate order is per-provider policy: GitHub keeps the existing
  user endpoints -> official route -> built-ins order; Hugging Face uses
  user endpoints -> built-ins -> official route (mainland-first). The
  settings panel displays official, built-in and user rows in the same shape
  as today's GitHub ladder.
- **Cold start**: probe/hedge small-file requests across the configured
  candidates with staggered starts (official + built-ins), first verified
  response wins; losers are cancelled. This avoids the current
  "official first, wait 8-15 s, then fall back" behaviour that mainland
  users would otherwise always pay.
- **Sticky endpoint per pass/provider**: once a candidate answers, the
  rest of the pass (all files) uses it first; failures fail over within
  the ladder from the committed offset (hub behaviour).
- **Health cache**: per endpoint, last result, latency and a short failure
  cooldown, session-scoped plus a persisted last-good endpoint per
  provider (appdata, not user-facing config). A user-initiated probe
  clears cooldowns.
- Big-file transfers keep using the hub's existing race/failover; the
  context only orders sources.

### 7.5 Configuration and IPC

`network-config.toml` gains an additive, optional field (camelCase like
the rest):

```toml
githubMirrors = ["https://ghfast.top"]
huggingfaceMirrors = ["https://hf-mirror.com", "https://hf-mirror.example"]
```

- Base endpoints only (scheme required, https only, no query/fragment,
  trailing slash stripped, <= 8 entries, deduplicated); the official
  route is implicit and never stored.
- `githubMirrors` semantics are untouched; the legacy single
  `githubMirror` string keeps folding into its head.
- A future `providerMirrors` map can replace the per-provider fields
  without breaking the old spelling.
- IPC: `mirror_ladder(provider)` and `mirror_probe(provider)` return
  provider-tagged DTOs; the old GitHub-named commands remain as thin
  wrappers for one release so the webui/api parity test flips cleanly.
- The webui extracts a per-provider `useMirrorLadder(provider)` hook and a
  shared ladder/probe component; the GitHub group stays on the updates
  page, the Hugging Face group sits next to the model card.

### 7.6 Endpoint catalogue and drift checks

One tracked source of truth: `res/config/mirror-endpoints.json` (providers
-> official endpoint + built-in endpoint list + probe target kind). Rust
embeds it with `include_str!`; Python (`fetch_models.py`), the website and
the relay CSP allowlists consume or are checked against it by a new
`scripts/check_mirror_endpoints.py` wired into CI and `just lint` —
replacing the current situation where only the Cargo shun metadata is
tested. `res/config/upstream-endpoints.json` (the transport-health
catalogue) gains the new hosts so proxy/direct fallback and the
upstream-health page know them.

### 7.7 Observed China behaviour (2026-11-08, maintainer network)

| Target | Result |
| --- | --- |
| `https://huggingface.co/api/models/...` | connection timeout (direct route unusable) |
| `https://hf-mirror.com/api/models/...` | 200, full Hub API JSON including the commit sha |
| `hf-mirror.com/<repo>/resolve/main/<file>` | 307 -> `/api/resolve-cache/models/<repo>/<sha>/<file>` -> 200, `Accept-Ranges: bytes` |
| pinned commit resolve | 200 |
| LFS/Xet file through the mirror | 302 -> signed `cas-bridge.xethub.hf.co` URL -> 200/206 (mirror does not store blob bytes) |
| `www.modelscope.cn/models/<repo>/resolve/master/<file>` | 200 JSON, independent CN CDN |

This is why the default Hugging Face ladder for mainland users is
built-in mirror first, official last, and why the runtime never depends
on `huggingface.co` being reachable.

### 7.8 Mirror caveats

- Third-party mirrors are best-effort public services with no formal SLA
  or terms (hf-mirror.com is a community project; ModelScope's
  redistribution terms and quotas are unverified). They are transports
  only: every byte is signature/sha256-verified, and endpoints are user
  configurable.
- Large files may be served from Hugging Face's CDN after a signed
  redirect; the channel pins commits and verifies sha256, so a stale or
  wrong file fails, it is never accepted.
- Signed CDN URLs expire (about an hour); the downloader re-resolves on
  403/expiry instead of caching them.
- No token is ever embedded in the client: public repositories only.

## 8. Compatibility, security and invariants

- **Frozen app-update channel untouched**: the `v*` updater, its shun
  metadata and its digest flow are not modified by this wave.
- **Resource pack unchanged**: still GitHub `res-latest` with deltas and
  signed digests; the mirror context only changes how its candidates are
  produced (identical order and URLs for GitHub).
- **Old clients are unaffected**: no existing client downloads the
  decisions pack, so a new channel adds no compatibility obligation; the
  resource-pack wire format is not reformatted.
- **Config compatibility**: new TOML fields are optional and ignored by
  older builds; a downgrade that heals the config drops them (documented),
  and the app re-adds defaults on the next upgrade.
- **Security invariants**: official-only truth for version and digests;
  mirrors are transports; an obtained official anchor binds; executable
  payloads fail closed; no secrets in the tree; ONNX files are validated
  (kind/width) before the swap.
- **Threat model**: compare with `docs/en/designs/threat-model.md`; the
  new surface is the model channel (public unsigned-in-transit content
  protected by signature) and the third-party mirror endpoints (read-only
  transport).

## 9. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Game-derived LOS/attribute data redistributed publicly (licensing) | keep the current public-pack precedent; `NOTICE.md` provenance; decision 2 in section 11 |
| Third-party mirror disappears or turns hostile | signature + sha256 verification; user-configurable endpoints; official route remains a candidate |
| Hugging Face rate limits / policy changes | 46-120 requests per install, far below the anonymous resolver budget; manifest-first design; retries honour `RateLimit`/`Retry-After` |
| Hugging Face switches small files to Xet | downloader follows redirects and Range/resume; if that happens, verify end-to-end before shipping a built-in endpoint |
| Feature drift (weights vs Rust featurizer) | explicit `featureSet` contract; app-side validation; featurizer change bumps the set |
| LOS/game-version mismatch | `resTreeSha256` comparison; skip LOS with a prompt |
| Stale mirror manifest | authenticated content + seq ratchet; publisher upload order; retry next check |
| Unsigned/malicious manifest | fail closed; pinned Ed25519 keys; no cleartext fallback |
| Publishing accidentally leaks a token | `HF_TOKEN` only from env/CI secret; pre-commit grep per repository rules |

## 10. Rollout

Each step is its own worktree + PR under the repository workflow; **the
design document ships in all nine documentation locales** (en, zh-CN,
zh-TW, ja, ko, fr, es, ru, ar).

1. **PR1 - mirror context (behaviour-neutral).** Extract
   `commands/mirror/`, GitHub provider with identical semantics, config
   field + sanitize + IPC wrappers, webui generic hook, endpoint catalogue
   and drift check. Gate: existing ladder/config/hub/upstream tests stay
   green; no wire change.
2. **PR2 - Hugging Face provider + publisher.** HF provider
   (rewrite/hedge/probe), `scripts/publish_ai_models.py`, model-card and
   licence templates, `just publish-ai-models`. Gate: dry-run manifest
   fixtures, provider unit tests, publish rehearsal against a private test
   repository.
3. **PR3 - the `ai` channel.** `commands/ai_pack.rs`, registry/ledger
   rows, install-time ONNX validation, `ship_attrs` pack override,
   Settings card + i18n + RPC/webMock parity, `docs/{en,zh-CN}/designs/resources.md`
   updates (translated rows where the locale carries the file). Gate:
   end-to-end rehearsal (offline mirror, bad sha, bad ONNX, cancel,
   rollback), full lint/test matrix.
4. **PR4 - optional.** ModelScope provider/publication, GitHub Release
   fallback source, bundled baseline in installers/APKs, per-map lazy LOS.

## 11. Open decisions

1. **Hugging Face owner/repo name** — DECIDED: `langyo/wowsp-d1`
   (public). The account and write token are maintainer-owned; the
   publisher creates the repository on first use.
2. **Redistribution statement** for game-derived LOS rasters and the
   attribute table: publish them together with the weights under the
   existing licence plus a provenance notice (recommended, consistent
   with the public resource pack), or keep them out of the public model
   repository and serve them only through the app's GitHub pack.
3. **Training-script snapshot scope**: whole `scripts/experiments/`
   (recommended) or a curated subset; whether to include the research log.
4. **Update policy**: silent boot check behind a 24 h TTL and a manual
   download (recommended) versus automatic download of the ~12 MB pack;
   whether to expose an "auto-update models" switch.
5. **Second providers**: ModelScope as a first-class provider (needs an
   account, key and terms review) and/or a GitHub Release fallback source.
6. **Optional artifacts**: ship `onnx-int8/` variants and the
   `checkpoint.pt` files, or weights only (recommended: int8 optional,
   checkpoints not published).
