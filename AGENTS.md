# AGENTS.md — WoWSP Repository Rules for AI Agents

Every AI agent / subagent working in this repository (langyo/wowsp) **must**
follow these rules. Real credentials and intranet details that live outside
this repository are **never** copied into it (red lines in §7).

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
- **Version bumps ride along with the main PR**: when the version changes,
  bump all seven places in the same feature/fix PR (`Cargo.toml` workspace
  version, `packages/app/tauri/tauri.conf.json`,
  `packages/installer-shell/tauri.conf.json`, root `package.json`, and the
  `version` field of `packages/webui`, `packages/website`, `packages/holo`);
  `scripts/check_versions.py` enforces consistency in CI. **Do not** open
  version-bump-only PRs (unless the user explicitly asks).
- **Version bump authorization tiers**: without explicit user consent, an
  agent may autonomously advance **at most the patch digit**. minor / major
  bumps must never be advanced unilaterally — first get the user's explicit
  approval of the target version, then bump all seven places in the same PR.
- **Create PRs only when asked, or as a step of an approved workflow**;
  never open unsolicited PRs.

## 6. Build & Test

- Rust: `cargo build` / `cargo test` / `cargo fmt` / `cargo clippy`
  (repo wrappers: `just check` / `just test unit` / `just lint rust`).
- Web: `pnpm build` / `pnpm lint` / `pnpm -r typecheck`
  (repo wrapper: `just lint webui`).
- Rust checks run on Windows (CI's rust job also runs on a Windows runner):
  the pinned `windows-future 0.2.1` does not compile on Linux (upstream bug,
  see the ci.yml comment). fmt/clippy target only the app crates
  (`wowsp_tauri` / `wowsp_tauri_shared`); the vendored `wowsunpack` /
  `wows-core` are dependency sources and keep their upstream formatting.
- **Cross-repo dependencies**: always consume published artifacts or
  vendored checkouts — never path dependencies pointing at local directories
  outside this repo. hikari comes from the npm package
  `@celestia-island/hikari` (components are built on its public exports;
  use granular style subpaths like `styles/theme/*` and
  `styles/admin-tokens.scss`, never the `styles` aggregate entry, which
  escapes the package), malkuth from its crates.io release, and
  `wowsunpack` / `wows-core` stay vendored.

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
   - `ci.yml` — web (ubuntu: typecheck / lint / website build / i18n /
     pnpm audit), rust (windows: fmt / clippy / check / test), deny
     (cargo-deny native binary: advisories / licenses / sources), versions
     (seven-version consistency via `scripts/check_versions.py`).
   - `commit-msg-lint.yml` — PR title + every commit subject in the PR
     (via `scripts/commit_msg_lint.py`, bot authors exempt).
   - `release.yml` / `site.yml` — tag-driven build & release / site
     deployment.

## 9. Large Download Discipline (mandatory)

1. **Confirm the volume with the user before starting any download over
   5GB**; without confirmation it must not start.
2. Failed retries must carry a total byte-budget cap; **unbounded retry
   loops are forbidden**.
3. Download scripts should support resumable transfers / content-addressed
   caching to avoid repeated full fetches. (In this repo this mainly
   concerns `scripts/fetch_models.py` for model downloads.)
