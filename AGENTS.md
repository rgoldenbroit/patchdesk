# PatchDesk

PatchDesk turns npm audit findings into human-approved, tested fix PRs, using the Cursor SDK (@cursor/sdk). Demo customer: Hudson Valley Medical Center (fictional). Demo target repo: ../hvmc-patient-portal.

## Rules
- TypeScript, ESM, run with tsx. Strict types. No new dependencies unless I name them.
- The Cursor SDK's real API is in node_modules/@cursor/sdk/README.md and node_modules/@cursor/sdk/dist/esm/ (stubs.d.ts, options.d.ts, run.d.ts, agent.d.ts). Read them before using the SDK. Never guess an SDK option.
- Keep set logic (scan, policy, tests, git, PR) in plain code. Agents only do judgment: reading code for reachability, and editing code for a fix.
- Run commands with child_process execFile and an args array. Never build shell strings.
- Validate anything an agent returns with zod before using it.
- Mark each real design choice with a comment: // DECISION: <choice>. Why: <reason>. Alternative: <what else I could have done>.
- After every change, run npm run typecheck and npm test and show me the output.
