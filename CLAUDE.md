# Simcompanies Manager — Claude rules

## Agents (required)
For every SCM change, fix or investigation, use subagents (Agent tool). This rule is the explicit user request for agents.
- **Investigate:** use an Explore agent to locate the code paths and storage keys before diagnosing.
- **Verify:** use a separate agent to review the diff and run the tests (`npx vitest run`, `node test/check.mjs`) before pushing.
- **E2E:** when UI changes, run the scm-e2e check in an agent (360 px viewport).
- Push to `main` only after every agent has finished and reported pass.
- In the reply, list each agent used and its result.
