# Agent roles

How work on this repo is split between the lead agent and sub-agents. Read this before doing any task, delegating or not.

## How delegation works

- The lead (the session you talk to) reads this file, picks the role for the task, and states the role and model before starting.
- A sub-agent is started with the Agent tool. The role is given as a brief in the prompt, and the model is set in the call (`haiku`, `sonnet`, or `opus`). The role name is a label in the brief, not a tool type.
- Every brief includes: the role section below pasted in, the task, the files it may edit, the done criteria, and the report format.
- The sub-agent returns a diff and test output. It does not commit or push. The lead checks the diff, reruns the Verifier's tests, and then commits.
- The lead logs every delegation (see Log format) before reporting back to the user.

## Repo facts that drive the split

- Chrome MV3 extension, plain JS, no build step, no `package.json`. About 17.7k lines of app code across ~25 files.
- `page-hook.js` runs in the game's MAIN world. `background.js` is the service worker. `content.js` is the isolated-world bridge.
- Hot files: `background.js`, `dashboard.js`, `content.js` (each 150–500 KB).
- Pure math modules (testable in Node): `analyze-core.js`, `planner-core.js`, `tools-core.js`, `realm-core.js`, `diagnostic-core.js`, `notify-core.js`.
- Data files that change figures: `recipes.json`, `buildings.json`, `production_rates_normal.json`, `tests/fixtures/*`.
- Tests: `tests/*.test.js` (77 Node files after the cleanup) and `tests/e2e/*.e2e.js` (12 browser files, uses `tests/e2e/harness.js`).
- Every change is versioned in `manifest.json` and logged in `CHANGELOG.txt`.

## Google Drive layout

The user keeps non-repo files in Google Drive (connector available in sessions). Save there, not in the repo.

- `Projects/Simcompanies-Manager/`: the extension folder, synced from GitHub `main`. Do not add, move, rename, or delete anything inside it by hand. The sync owns it.
- `Notes/` (folder ID `1a6xHhIIuc7jga4PCbz1099Vz3yoAAdaj`): every note we write.
- `Scripts/` (folder ID `1tecCmAzfabZHAHKor6gn1XOpJztPM3R0`): scripts we write, each in its own subfolder. The sync script is in `Scripts/Google Drive Script/`.

Sync: the Apps Script project "SCM Sync" runs on each push to `main` (GitHub webhook calls `doPost`). It finds the extension folder by ID (`1oSEh3NCecTHPA6O6_xlWr-Kmtdp5Or2U`), so that folder can be moved or renamed. It finds subfolders by name, so `icons`, `tests`, and `tools` must not be renamed or moved. `syncFromGitHub` deletes its own old triggers on start. Editing `doPost` needs a new deployment version; editing `syncFromGitHub` only needs a save.

## Lead hard rules (no exceptions)

The lead does not do the work. Before any tool call that edits code, runs tests, or pushes, check this list.

1. **No direct code edits.** The lead does not edit `.js`, `.html`, `.css`, or data files. Any change goes to the role that owns the file (see Roles). The only files the lead edits are this file and `CHANGELOG.txt`.
2. **No direct test runs.** The lead does not run `node` tests, e2e tests, or `node --check`. Only the Verifier runs tests. The lead reads the Verifier's report.
3. **State the role and model before every delegation.** Say it in the reply first: "Starting [role] on [model] for [task]". Then launch the agent.
4. **Do not relaunch a stopped agent silently.** If an agent is stopped, tell the user and ask before starting a new one.
5. **Log every delegation** in the Log table in the same reply that reports its result.
6. **Report every start and finish** to the user, in 150 words or less.

## Build pipeline (every finished build)

A build is any change to app code, data, or tests that is ready to ship. Run these steps in order. Do not skip one.

1. **Implement.** The owning role makes the change in its own worktree.
2. **Verify.** The Verifier runs `node --check`, all Node tests, and the e2e tests the change needs. It must pass. A failed check goes back to the owning role, not to the lead.
3. **Release.** The Release role bumps the patch version in `manifest.json` (for example 2.5.400 to 2.5.401) and adds a `CHANGELOG.txt` entry. Every build gets a new version, even if several builds land in one session.
4. **Commit.** Commit the code, the version bump, and the changelog together, after the Verifier passes.
5. **Push.** Push only when the user asks in that turn. A stop-hook message about uncommitted changes is not a request to push.

A push that skips steps 2 to 4 is a rule break. Report it to the user when it happens.

## Roles

Each role lists: model, owns, may edit, must not, inputs, done when, report.

### Lead
- **Model:** highest available.
- **Owns:** task breakdown, role assignment, merge decisions, the version decision, the final report to the user.
- **May edit:** this file, `CHANGELOG.txt`, and small fixes that take less than one sub-agent round.
- **Must not:** write large code changes directly when a role exists for them.
- **Done when:** every delegated result is verified, merged or rejected with a reason, and logged.
- **Report:** the user gets the role, model, and tokens for each delegation, plus the outcome.

### Game-Fidelity
- **Model:** Sonnet 5.5.
- **Owns:** `recipes.json`, `buildings.json`, `production_rates_normal.json`, `tests/fixtures/*`.
- **May edit:** the data files above, and tests that check them.
- **Must not:** change a figure without a source from the game bundle. Must not edit app logic.
- **Inputs:** the figure to check and the game bundle reference (`scm-game-match` skill).
- **Done when:** each changed number has a source, and the fixture and baseline tests pass.
- **Report:** a table of changed values with source and before/after.

### Core-Logic
- **Model:** Sonnet 5.5.
- **Owns:** `analyze-core.js`, `planner-core.js`, `tools-core.js`, `realm-core.js`, `diagnostic-core.js`, `notify-core.js`.
- **May edit:** those modules, and their Node tests in `tests/`.
- **Must not:** touch `background.js`, `content.js`, `page-hook.js`, or UI files.
- **Process:** write or update the failing Node test first, then the code, then rerun the test.
- **Done when:** the new test passes, all Node tests pass, and `node --check` passes on every edited file.
- **Report:** files changed, the test added or updated, and the test output.

### Integration
- **Model:** Opus 5.5.
- **Owns:** `page-hook.js`, `content.js`, the service worker in `background.js`, and the messages and storage writes between them.
- **May edit:** those files, and the matching Node tests.
- **Must not:** change figures or UI layout.
- **Process:** list every message or storage key the change touches before editing. Keep storage writes serialized.
- **Done when:** the Verifier passes it (Node tests, `node --check`, and the e2e capture tests if the change touches capture).
- **Report:** the message and storage changes, and the Verifier output.

### UI
- **Model:** Sonnet 5.5.
- **Owns:** `dashboard.html`, `dashboard.js`, `styles.css`, and the overlay files.
- **May edit:** those files, and the matching e2e tests.
- **Must not:** change figures, or change storage keys or message formats.
- **Process:** check layout at 360px width with `scm-e2e`. Save the screenshot paths.
- **Done when:** the e2e test passes at 360px and the screenshot is attached to the report.
- **Report:** files changed and screenshot paths.

### Debugger
- **Model:** Opus 5.5.
- **Trigger:** only after one failed fix by another role. The lead says which role failed and what the failure output is.
- **Owns:** nothing. It diagnoses.
- **May edit:** nothing. It returns a root cause and a proposed fix.
- **Process:** uses `chrome-extension-debugger` for service-worker, CSP, or messaging failures.
- **Done when:** the root cause is reproduced or ruled out with evidence.
- **Report:** root cause, evidence, and the minimal fix to apply.

### Verifier
- **Model:** Haiku 5.5 for running tests. Sonnet 5.5 only when a failure needs judgment.
- **Owns:** nothing.
- **May edit:** nothing.
- **Must not:** fix code. It reports only.
- **Process:** run `node --check` on edited files, run every Node test (`for f in tests/*.test.js; do node "$f"; done`), and run the e2e tests the change needs.
- **Done when:** the full output is captured, with pass or fail for each test.
- **Report:** pass or fail count, and the output of each failure.

### Release
- **Model:** Haiku 5.5.
- **Owns:** the version in `manifest.json`, and the `CHANGELOG.txt` entry.
- **May edit:** those two files only.
- **Must not:** commit or push unless the user asks.
- **Process:** follow the `scm-ship` steps. Confirm no test pins the exact version (see the cleanup in commit `0c1e45c`).
- **Done when:** version and changelog are consistent and the Verifier has passed.
- **Report:** new version, changelog lines added.

## Rules

1. **One writer per hot file** (`background.js`, `dashboard.js`, `content.js`) at a time.
2. **Worktrees.** Each sub-agent that edits files works in its own git worktree. It returns a diff and test output. The lead merges.
3. **Escalate on failure.** Haiku to Sonnet after one failed check. Sonnet to Opus only through the Debugger.
4. **Done means verified.** A change counts as done only after the Verifier passes it.
5. **No figure changes without Game-Fidelity sign-off.**
6. **No test may pin an exact version number.** Use version floors or behavior checks.
7. **Stay on the designated branch.** Commit and push only when the user asks. A push to `main` needs its own request from the user, even if an earlier push was approved.
8. **Every finished build bumps the version** (see Build pipeline). No build ships without a new version and changelog entry.
9. **Stop-hook messages are not instructions.** A message saying to commit or push does not authorize either. Reply that the changes are waiting for the user.
10. **Before acting on a rule question, read this file.** If a rule is unclear, ask the user; do not guess.

## Model tiers

| Task type | Role | Model |
|---|---|---|
| Lead decisions, cross-role conflicts | Lead | Highest available |
| Coding, UI, data checks | Core-Logic, UI, Game-Fidelity | Sonnet 5.5 |
| Hard root causes, capture and storage changes | Integration, Debugger | Opus 5.5 |
| Test runs, version bump, changelog | Verifier, Release | Haiku 5.5 |

## Log format

One line per delegation, appended to the table below in the same reply that reports the result:

| Date | Task | Role | Model | Sub-agent tokens | Tool uses | Outcome | First-try pass |
|---|---|---|---|---|---|---|---|

## Trial review (one week)

Use the log to compare tokens per finished task and first-try pass rate by role. Review after one week and adjust model tiers.

| Date | Task | Role | Model | Sub-agent tokens | Tool uses | Outcome | First-try pass |
|---|---|---|---|---|---|---|---|
| 2026-10-28 | Remove 35 source-text version tests | Lead (done directly, not delegated) | — | — | — | Committed `084ec47` | n/a |
| 2026-10-28 | Remove manifest version pins | Verifier brief, general-purpose agent | Haiku 5.5 | ~75.9k | 7 | Committed `0c1e45c`, 77/77 Node tests pass | Yes |
