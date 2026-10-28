# Agent roles

How work on this repo is split between the lead agent and sub-agents. Read this before spawning any sub-agent.

## Repo facts that drive the split

- Chrome MV3 extension, plain JS, no build step, no `package.json`. About 19k lines across ~25 files.
- `page-hook.js` runs in the game's MAIN world. `background.js` is the service worker. `content.js` is the isolated-world bridge.
- Hot files: `background.js`, `dashboard.js`, `content.js` (each 150–500 KB).
- Pure math modules (testable in Node): `analyze-core.js`, `planner-core.js`, `tools-core.js`, `realm-core.js`, `diagnostic-core.js`, `notify-core.js`.
- Data files that change figures: `recipes.json`, `buildings.json`, `production_rates_normal.json`, `tests/fixtures/*`.
- Tests: `tests/*.test.js` (Node regression files) and `tests/e2e/*.e2e.js` (browser, uses `tests/e2e/harness.js`).
- Every change is versioned in `manifest.json` and logged in `CHANGELOG.txt`.

## Roles

### Lead (highest model available)
- Breaks tasks down, assigns roles, merges results, and makes the final call on conflicts.
- Owns the version decision. Writes little code directly.

### Game-Fidelity (Sonnet)
- Owns the data files and game constants.
- Checks every changed number against the game bundle (`scm-game-match` skill).
- Sign-off required before any figure-changing change merges.

### Core-Logic (Sonnet)
- Owns the pure modules listed above.
- Writes or updates the Node regression test first, then the code.

### Integration (Opus)
- Owns `page-hook.js`, `content.js`, the service worker in `background.js`, and message and storage handoffs between them.
- Any change here goes through the Verifier before merge.

### UI (Sonnet)
- Owns `dashboard.html`, `dashboard.js`, `styles.css`, and overlays.
- Checks layout at 360px width with `scm-e2e` screenshots. The user works on mobile.

### Debugger (Opus, on demand)
- Called only after one failed fix by any other role.
- Finds the root cause and reports it. No broad edits.
- Uses `chrome-extension-debugger` for service-worker, CSP, or messaging failures.

### Verifier (Haiku for runs, Sonnet for judgment)
- Runs `node` syntax checks, the Node regression tests, and e2e suites.
- Reports pass or fail with the output. Does not edit code.

### Release (Haiku)
- Mechanical release work: version bump in `manifest.json`, `CHANGELOG.txt` entry, and the `scm-ship` steps.

## Rules

1. **One writer per hot file** (`background.js`, `dashboard.js`, `content.js`) at a time.
2. **Worktrees.** Each sub-agent works in its own git worktree and returns a diff plus test output. The lead merges.
3. **Escalate on failure.** Haiku to Sonnet after one failed check. Sonnet to Opus only through the Debugger.
4. **Done means verified.** A sub-agent's work counts as done only after the Verifier passes it.
5. **No figure changes without Game-Fidelity sign-off.**
6. **Log each task:** role, model, token use, and outcome (for the one-week trial).
7. **Stay on the designated branch.** Commit and push only when the user asks.

## Model tiers

| Task type | Model |
|---|---|
| Lead decisions, cross-role conflicts | Highest available |
| Coding, UI, data checks | Sonnet 5.5 |
| Hard root causes, Integration work | Opus 5.5 |
| Test runs, version bump, changelog | Haiku 5.5 |

## Trial review (one week)

Track per task: role, model, tokens used, and whether the result passed verification on the first try. Review after one week and adjust tiers.
