# AGENTS.md — WoWSP Repository Rules for AI Agents

Every AI agent / subagent working in this repository (langyo/wowsp) **must**
follow these rules. Real credentials and intranet details that live outside
this repository are **never** copied into it (red lines in §7). **§0 is a
hard safety gate and overrides every workflow convenience below.**

---

## 0. Game Client & Live-Session Safety (READ FIRST; mandatory)

**Static analysis first, always. Never launch the game.** No agent may
start, stop, restart, reconnect, or otherwise control the World of
Warships client, its launcher, Steam, or any process/account that can
enter or affect a live battle, and no agent may install, copy, remove,
or edit files under a game installation (`res_mods/`, `profile/`,
`bin/`, `replays/`, …), in order to analyze the game client. This applies
to every route into the client, including but not limited to:

- `WorldOfWarships.exe`, `WorldOfWarships64.exe`, launchers, and direct
  executable calls;
- Steam `-applaunch`, `steam://` URIs, replay file associations, and
  double-click-style launch paths;
- replay playback, training rooms, port/offline sessions, and even a
  "quick" windowed smoke test;
- `taskkill` / any process termination, including a client the agent
  itself started;
- copying probe/mod files into or out of the game directory.

**Analysis of the game client is static by default:** read the repo,
decompile `scripts.zip` with the vendored tooling, inspect SWF/assets,
and read logs/telemetry artifacts the developer already produced. A live
client experiment requires **explicit, per-action permission from the
developer (including the user)** — a standing instruction to work on the
plugin, a previous approval, or an apparently idle client is not
permission. Even with permission, the developer must confirm the game is
closed and no account is in a live match, and the experiment must be
scheduled with them.

Subagents inherit this rule and receive no independent authority to run
a client; the orchestrating agent is responsible for every subagent's
actions. If a task seems to require a live client and permission is not
explicitly present, stop and report the static-analysis blocker instead
of improvising a launch.

---

## 1. Commit Message Format

```
<gitmoji> <Capitalized English summary ending with period.>
```

- Must start with a gitmoji. Whitelist = the full gitmoji.dev spec plus
  organizational additions (🔗 sync/copilot, 🔄 sync/refresh, 📜 license,
  🛡️ shield). Commonly used: ✨ 🐛 🔧 ♻️ 🔥 📝 🎨 ✅ 🚀 🌐 ⬆️ 🎉 📦.
  **The authoritative implementation is `scripts/commit_msg_lint.py`**
  (CI enforces it; run `just lint-msg` locally) — the whitelist in that
  script wins over this list.
- The summary is English, capitalized, ends with `.`; **CJK characters are
  forbidden**.
- **Conventional Commits prefixes are forbidden** (`feat:` / `fix:` etc.) —
  the emoji itself is the type marker.
- **Any colon-prefix phrasing is forbidden** (`Topic phrase: details`), even
  capitalized like `🔧 Fix compliance: nonce handshake`; the correct form is
  `🔧 Fix nonce handshake and embed path.` (linter rule 7 rejects colon
  prefixes). Put detail in the commit BODY (blank line + bullets), never in
  the summary line.
- Never start with a bare version number or filler phrases (`v1.2.3` /
  `Bump version` / `Update to`).
- **Merge commit subjects are forbidden** (`Merge branch ...` /
  `Merge pull request ...`): this repo only uses squash merge.
- Exemptions: `Revert "..."` (git revert output) is exempt from the gitmoji
  requirement; bot commits (dependabot etc.) are exempt by author filtering
  (see the workflow).
- **PR titles follow exactly the same rules** (after squash merge the PR
  title becomes the commit subject): `<gitmoji> <one-line English.>`, no
  colon prefix; bot PRs (dependabot) are exempt.

## 2. CHANGELOG Policy (mandatory)

- **Never maintain a CHANGELOG / revision-history file in this repository,
  under any circumstances.** Merged PRs are the changelog: the squash commit
  (gitmoji + one-line summary) plus the PR description form the complete
  change history; filter `git log` at any granularity.
- Release notes are written on **git tags + the GitHub Releases page** (one
  entry per release), never in tracked files.
- No CHANGELOG file exists in the repo; do not create one. If a changelog
  reference reappears in the PR template / workflows, remove it in the PR
  that touches it.

## 3. PR Workflow

Every unit of work follows this pattern:

1. **Branch off master** (`feat/<name>` / `fix/<name>`). For parallel tasks
   use separate `git worktree`s so multiple agents never mutate the main
   checkout at once.
2. **3-round verification loop**, for every change:
   - Round 1: analyze → improve → verify (use a subagent for verification)
   - Round 2: analyze again → improve → verify
   - Round 3: final analysis → polish → verify
   - **Any failed round restarts the count from zero.**
3. **Commit** in gitmoji format.
4. **Push** the branch.
5. **Create the PR** with `gh pr create` (title follows §1).
6. **Squash merge** (autonomous once the §5 gates pass): the subject becomes
   `<gitmoji> Summary. (#PRID)`.
7. **Delete** the feature branch after merging.

### Subagent usage

- All non-trivial tasks **must use subagents** (general / explore types) to
  avoid context pollution.
- Subagent task descriptions must be self-contained: exact file paths, a
  look at existing code patterns first, verification criteria, and the
  commit message format.
- Launch independent subtasks in parallel; wait for results before
  continuing serial ones.
- Every subagent must verify its own work before returning; important work
  is cross-verified by another subagent.

### Worktree-based PR workflow

The main checkout stays on master. Use a separate `git worktree` whenever
there are parallel tasks, or the task could interfere with the main
checkout's build state:

1. **Create**: `git worktree add ../<repo>-wt-<task> -b <type>/<name>
   master` — sibling directory, `-wt-` prefix naming (e.g.
   `wowsp-wt-detect`). Do all edits, commits, pushes and `gh pr create`
   inside the worktree; keep the main checkout untouched on master.
2. **Dependencies are not shared**: the worktree's `node_modules` is empty —
   run `pnpm install` on entry (the pnpm store is global, so it is fast).
   Rust `target/` is likewise independent; the first `cargo check` /
   `cargo test` is a full build, which is expected.
   - `tauri::generate_context!()` embeds `dist/webui` at compile time; in a
     fresh worktree the Rust build fails outright while that directory is
     missing — run `pnpm build` for real artifacts before running Rust
     tests locally, or drop in a placeholder `dist/webui/index.html` the
     way CI does (`dist/` is gitignored and never committed).
   - Optional speedup: point `CARGO_TARGET_DIR` at the main checkout's
     `target/` to reuse dependency artifacts (cargo's file lock makes serial
     use safe; never share it between two worktrees building in parallel,
     and note it makes the main checkout rebuild crates the worktree
     touched).
3. **Cleanup after merge**: once the PR is squash-merged and the remote
   branch deleted, return to the main checkout and run
   `git worktree remove ../<repo>-wt-<task>` (if uncommitted changes remain,
   confirm they landed in the PR before adding `--force`); clean stale
   worktrees with `git worktree prune` and delete the local branch with
   `git branch -d <type>/<name>`.
4. Never nest a second-level worktree inside a worktree; one worktree serves
   one branch.

### Verification gates

Before submitting, the relevant subset of `just lint` (or scoped
`just lint rust` / `just lint webui`), `cargo check` / `cargo test`, and
`pnpm build` must pass, chosen by what the change touches.

## 4. Branch Naming & Git Push Rules

- `master` — production branch. **Accepts squash-merged PRs only**; direct
  pushes are forbidden; urgent fixes go through a `fix/<name>` branch + PR.
- `feat/<name>` — new features; `fix/<name>` — bug fixes; `chore/<name>` —
  maintenance; `refactor/<name>` — behavior-preserving refactors.
- `dev` — **deprecated, do not use.**

### Git push hard rules

- **Bare `git push --force` is forbidden** without explicit human
  authorization. No exceptions.
- On feature branches, prefer `git push --force-with-lease` for
  rebase/amend recovery.
- If `--force-with-lease` is rejected (stale remote-tracking ref) **stop
  immediately and never fall back to `--force`**: fetch first, review both
  sides with `git log origin/<branch>..HEAD` and
  `git log HEAD..origin/<branch>`, and only after confirming there are no
  unknown commits, consult the user.
- **Any form of force push to master is absolutely forbidden** — master only
  advances via squash merge.
- When in doubt, do not force push: open a new branch, re-commit, or ask
  the user.
- **Autonomous tag pushes are forbidden (mandatory).** Never create or
  push any git tag without an explicit user instruction naming the tag —
  especially `v*` release tags. Pushing a `v*` tag **is** cutting a
  release: release.yml then builds and publishes it `--draft=false
  --latest` with no human gate, so the tag push itself is the release
  decision. Agents may prepare a release (release-prep PR,
  release-notes draft); pushing the tag is reserved for the user.
  Designed exception: the `res-delta-*` tags the app itself pushes when
  the maintainer publishes a resource pack from the app UI.
- These rules apply to all agents, subagents, and interactive sessions,
  without exception.

## 5. Merge & Release Rules

- **A PR may be merged autonomously (no per-PR human confirmation) when all
  of the following hold:**
  1. **Message compliance**: squash subject is `<gitmoji> <one English
     sentence.>` with no colon prefix; the PR title follows the same rule.
  2. **Check gates**: merge only after the required checks pass.
     **Code-level failures** (compile / test / clippy / lint) must be fixed —
     never merge around them; **environmental failures** (runner quota,
     external service flakiness, etc.) may be waived after being recorded in
     the PR and verified locally (`cargo test` / `pnpm build` / lint).
  3. **PR economy**: do not open a separate PR for every trivial change and
     merge it immediately — PR numbers are a finite resource. One PR should
     bundle a coherent batch of mergeable work (a feature/fix wave); small
     PRs are allowed only when there is genuinely nothing to bundle (urgent
     hotfix, an isolated single-rule change).
- **Version bumps ride along with the main PR**: when the user explicitly
  instructs a version change (see the authorization rule below), edit the
  SINGLE source of truth — the root `package.json` `version` field — and
  run `python scripts/sync_versions.py` (or `just sync-versions`), which
  propagates it into the six derived slots in the same feature/fix PR
  (`Cargo.toml` `[workspace.package]` version,
  `packages/app/tauri/tauri.conf.json`, the `version` fields of
  `packages/webui`, `packages/website`, `packages/holo`, and
  `packages/pairing-relay/wrangler.toml`'s `[vars] FEEDBACK_LATEST_VERSION`
  — the /feedback form's browser-side version default); commit every
  touched manifest together. The installers take their version from the
  stamped shun.toml manifest (see packages/installer), so no separate
  slot. CI runs `scripts/sync_versions.py --check` and fails on drift.
  **Do not** open version-bump-only PRs (unless the user explicitly asks).
- **Version bump authorization — no autonomous version changes at all
  (mandatory; patch included)**: agents must never advance the release
  version on their own initiative — **the patch digit included**.
  Riding a bump into a feature/fix PR and opening a bump PR both require
  the user's explicit instruction naming the target version (in effect, an
  explicit release request — the version only moves when the user has asked
  for the next version to come out), and then the root bump plus its six
  derived slots land together in a single PR (one `sync_versions.py` run). Minor/major target versions additionally need
  the user's explicit approval of the number itself, per the
  release-versioning rule below.
- **Release versioning — no skipped versions (mandatory)**. The release
  version on master stays put until an explicit user instruction
  moves it (see the authorization rule above), but release tags must
  follow the published sequence
  strictly: the next release tag is always the latest published `v*`
  release tag plus one patch increment. A minor/major jump is allowed only
  with the user's explicit approval of the target version (see the
  authorization rule above); after such an approved jump the patch
  sequence resumes from it. Before cutting a release tag, if the seven
  slots do not already equal the version to publish, a release-prep PR
  MUST first reset the root package.json version to it and run
  `scripts/sync_versions.py` (this is the one sanctioned
  version-bump-down; the target is either the next sequential patch or the
  user-approved jump); `scripts/sync_versions.py --check` still enforces
  seven-place agreement. Never tag a version that skips numbers, and never
  let the tag and the built version string disagree. Per §4, pushing a
  release tag is reserved for the user.
- **Create PRs only when asked, or as a step of an approved workflow**;
  never open unsolicited PRs.

## 6. Build & Test

- Rust: `cargo build` / `cargo test` / `cargo fmt` / `cargo clippy`
  (repo wrappers: `just check` / `just test unit` / `just lint rust`).
- Web: `pnpm build` / `pnpm lint` / `pnpm -r typecheck`
  (repo wrapper: `just lint webui`).
- Rust checks run on Windows (CI's rust job also runs on a Windows runner):
  the pinned `windows-future` crate does not compile on Linux (upstream bug;
  see the ci.yml comment). fmt/clippy target only the app crates
  (`wowsp_tauri` / `wowsp_tauri_shared`); the `game-assets` /
  `game-assets-core` tool packages are dependency sources and keep their
  historical formatting (in-tree forks of wows-toolkit, flattened under
  `packages/tools/` — no upstream sync; dependency bumps and fixes there
  are WoWSP's own, see the packages' header comments). The ship GLB
  exporter is the Rust tool package `packages/tools/model-exporter`
  (a thin CLI over the game-assets library's ship-export API; build via
  `just build model-exporter`) — it replaced the vendored C++
  wows-model-exporter, which is gone together with its CMake/vcpkg chain.
- **Cross-repo dependencies**: always consume published artifacts or
  vendored checkouts — never path dependencies pointing at local directories
  outside this repo. hikari comes from the npm package
  `@celestia-island/hikari` (components are built on its public exports;
  use granular style subpaths like `styles/theme/*` and
  `styles/admin-tokens.scss`, never the `styles` aggregate entry, which
  escapes the package), malkuth from its crates.io release, and
  `game-assets` / `game-assets-core` stay vendored in-tree.
- **Error policy (mandatory)**: app-crate error flow is anyhow end-to-end —
  helpers return `anyhow::Result`, Tauri commands return
  `wowsp_tauri_shared::CommandResult` (the `CommandError(anyhow::Error)` IPC
  shim whose `Serialize` emits the Display string, preserving the webui's
  plain-string rejection contract). Never add `Result<_, String>` signatures
  or new custom error types in the app crates (`scripts/check_anyhow.py`
  enforces; the pre-existing structured wire errors `LookupError` /
  `ElevateErr` are the only exceptions). Files importing anyhow put its
  `use` statement first. `.context()` changes the frontend-visible message —
  weigh it deliberately.

## 7. Sensitive Information Red Lines (mandatory; violations are incidents)

1. **Never write any real password / key / token / intranet IP into the git
   tree** (any branch, any file — including comments, examples, defaults,
   test data, README, docs).
2. When code needs a secret: use environment variables / a git-ignored
   config file, or placeholders (`<your-password>` / `CHANGE_ME`); example
   IPs must use RFC 5737 documentation addresses (192.0.2.x / 198.51.100.x /
   203.0.113.x), and example values must be obviously fake
   (`test-password` / `sk-xxx`).
3. In the rare case where real credentials are genuinely required: **ask
   the user first**, and weigh repository visibility (a public repo does not
   make secrets writable; leaked history cannot be undone).
4. **Pre-commit self-check**: for changes touching config / deployment /
   install scripts / sample data, grep for `password|secret|token|api_key`
   and confirm there are no real values; replace intranet IPs
   (192.168.x / 10.x) with documentation addresses.
5. Real credentials in local files outside this repository **stay local
   only**; never copy them into any repository file (including this one).
6. Leak handling: delete immediately → assess the leak surface (tags /
   branches / downstream references) → report to the user, who decides
   whether to rewrite history (force-pushing master requires explicit
   authorization) → **regardless of any rewrite, treat the credential as
   public and rotate it**.

## 8. CI Usage Policy

1. **Do not over-rely on CI status**: local verification (the relevant parts
   of `just lint` / `cargo test` / `pnpm build`) plus a passing commit/PR
   title lint is enough to merge; environmental failures are recorded in the
   PR and waived (§5.2).
2. **CI is a reference, not a gate**: before merging, glance for
   **code-level failures** (compile / test / clippy) — fix those; purely
   environmental ones do not block. **Do not babysit CI** — queued or hung
   for more than ~15 minutes counts as environmental.
3. **Cancel stale runs**: when repeated pushes retrigger a PR, old runs may
   be cancelled (`gh run cancel <id>`) to free quota; every workflow already
   carries `concurrency` + `cancel-in-progress` dedup (wowsp is a public
   repo on hosted runners, so PRs keep full triggering with concurrency
   dedup).
4. CI structure (`.github/workflows/`):
   - `ci.yml` — web (ubuntu: typecheck / unit tests / lint / website,
     console and webui builds / rpc parity / i18n / docs check / in-game
     probe / npm audit), rust (windows: fmt / clippy / anyhow policy /
     check / portable check / workspace tests), deny (cargo-deny native
     binary: advisories / licenses / sources), relay (wasm32 check +
     relay-core tests), versions (seven-version consistency via
     `scripts/sync_versions.py --check`). Every action is pinned to a full
     commit SHA.
   - `commit-msg-lint.yml` — PR title + every commit subject in the PR
     (via `scripts/commit_msg_lint.py`, bot authors exempt).
   - `release.yml` — tag-driven build & release. Its `preflight` job first
     requires the tagged commit's `ci.yml` run to be green (repository
     variable `RELEASE_SKIP_PREFLIGHT=true` waives it for an emergency
     hotfix and records the waiver in the job summary); then build /
     installers → notes → publish → the signed app digest.
   - `site.yml` — docs / website / worker deployment.

## 9. Large Download Discipline (mandatory)

1. **Confirm the volume with the user before starting any download over
   5GB**; without confirmation it must not start.
2. Failed retries must carry a total byte-budget cap; **unbounded retry
   loops are forbidden**.
3. Download scripts should support resumable transfers / content-addressed
   caching to avoid repeated full fetches. (In this repo this mainly
   concerns `scripts/fetch_models.py` for model downloads.)
