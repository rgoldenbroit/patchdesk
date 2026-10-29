import { execFile } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, type Run as AgentRun, type RunResult } from "@cursor/sdk";
import { z } from "zod";
import { FIX_MODEL, MAX_FIX_ATTEMPTS } from "./config.js";
import type { Finding } from "./scan.js";
import type { Run } from "./state.js";
import type { TriageVerdict } from "./triage.js";

/** One package after the fix step. Saved on the run under `steps.fixes`. */
export const fixResultSchema = z.object({
  package: z.string().min(1),
  branch: z.string(),
  prUrl: z.string().optional(),
  attempts: z.number(),
  testsPassed: z.boolean(),
  agentId: z.string().optional(),
  runIds: z.array(z.string()),
  requestIds: z.array(z.string()),
  summary: z.string(),
  failure: z.string().optional(),
});

export type FixResult = z.infer<typeof fixResultSchema>;

/** npm exits with 1 when the audit worked and still found vulnerabilities. */
const AUDIT_FINDINGS_EXIT_CODE = 1;

/** How many lines of a failure we send back to the agent. */
const FAILED_OUTPUT_LINES = 80;

/** How many lines of passing test output go in the pull request. */
const PR_OUTPUT_LINES = 20;

// DECISION: allow up to 10 MiB from git, npm, and gh. Why: Node's default 1 MiB cap kills `npm install` and `npm test` before we can read the result. Alternative: keep the default and fail when the output is long.
const OUTPUT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/**
 * String fields we print from a tool call.
 * The stream types `args` as unknown, so we only read a field after checking it is a string.
 * These names are the ones the read, grep, glob, ls, and edit tools actually send.
 */
const TOOL_ARG_KEYS = ["pattern", "globPattern", "path", "targetDirectory"] as const;

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

/**
 * Fixes one approved package on its own branch and opens a pull request when the gates pass.
 * A failure leaves the worktree in place and returns `failure` instead of throwing.
 */
export async function fixOne(run: Run, finding: Finding, verdict: TriageVerdict): Promise<FixResult> {
  const result = blankResult(finding.package, branchName(finding.package, run.runId));
  const version = finding.fixVersion;
  if (version === null) {
    result.failure = `npm did not name a target version for ${finding.package}`;
    return finish(result);
  }

  const approved = run.steps.gate?.find(
    (decision) => decision.package === finding.package && decision.decision === "approved",
  );
  if (approved === undefined) {
    result.failure = `no approval on record for ${finding.package}`;
    return finish(result);
  }

  const worktree = worktreePath(result.branch);
  try {
    await mkdir(path.dirname(worktree), { recursive: true });
    // DECISION: do the fix in a new worktree on its own branch. Why: the customer's checkout on main stays untouched, and a failed fix can be inspected without mixing it into their files. Alternative: commit on the checkout they already have, which would move main.
    await runChecked("git", ["-C", run.repoDir, "worktree", "add", worktree, "-b", result.branch, "main"]);
  } catch (err) {
    result.failure = errorMessage(err);
    return finish(result);
  }
  console.log(`worktree ${worktree}`);

  let agent: Awaited<ReturnType<typeof Agent.create>> | undefined;
  try {
    // DECISION: give the fix agent read and edit tools only. Why: it should change source files, and a shell could run tests, rewrite the lockfile, or push before the gates run. Alternative: leave the default toolset, which includes shell, delete, and web search.
    agent = await Agent.create({
      model: FIX_MODEL,
      name: `patchdesk-fix-${finding.package}`,
      local: { cwd: worktree, settingSources: ["project"] },
      tools: ["read", "grep", "glob", "ls", "edit"],
    });
    result.agentId = agent.agentId;

    const repair = await repairUntilGreen(agent, result, finding, verdict, worktree, version);
    if (!repair.ok) {
      result.failure = repair.failure;
      return finish(result);
    }
    result.testsPassed = true;

    const stillPresent = await packageStillPresent(worktree, finding.package);
    if (stillPresent) {
      result.failure = `${finding.package} still appears in npm audit`;
      return finish(result);
    }
    console.log(`audit clear ${finding.package}`);

    // DECISION: commit only after npm test passes and the package is gone from npm audit. Why: a green test run and a clean audit are the proof the fix works, and the agent does not get to decide that for itself. Alternative: commit as soon as the agent says it is done.
    // DECISION: open a pull request and stop. Why: a person still has to review the fix before it reaches main. Alternative: merge the branch from here.
    const title = commitTitle(finding.package, version, finding.advisories.map((advisory) => advisory.ghsa));
    await runChecked("git", ["add", "-A"], worktree);
    await runChecked("git", ["commit", "-m", title], worktree);
    await runChecked("git", ["push", "-u", "origin", result.branch], worktree);
    const body = buildPrBody({
      finding,
      verdict,
      version,
      summary: result.summary,
      testOutput: repair.testOutput,
      attempts: result.attempts,
      agentId: result.agentId,
      requestIds: result.requestIds,
      by: approved.by,
      at: approved.at,
    });
    result.prUrl = await openPullRequest(worktree, result.branch, title, body);
    return finish(result);
  } catch (err) {
    if (result.failure === undefined) {
      result.failure = errorMessage(err);
    }
    return finish(result);
  } finally {
    if (agent !== undefined) {
      await agent[Symbol.asyncDispose]();
    }
  }
}

type RepairResult = { ok: true; testOutput: string } | { ok: false; failure: string };

/**
 * Asks the agent to edit, then checks the diff, installs, and runs tests.
 * A policy violation stops immediately. Test and install failures retry until `MAX_FIX_ATTEMPTS`.
 */
async function repairUntilGreen(
  agent: Awaited<ReturnType<typeof Agent.create>>,
  result: FixResult,
  finding: Finding,
  verdict: TriageVerdict,
  worktree: string,
  version: string,
): Promise<RepairResult> {
  let prompt = buildPrompt(finding, verdict, version);
  let failedAttempts = 0;
  let testOutput = "";

  while (failedAttempts < MAX_FIX_ATTEMPTS) {
    const sent = await sendFix(agent, result, prompt);
    if (!sent.ok) {
      return sent;
    }

    const forbidden = await forbiddenChanges(worktree);
    if (forbidden.length > 0) {
      const failure = `policy violation: ${forbidden.join(", ")}`;
      console.log(failure);
      return { ok: false, failure };
    }

    const install = await runCommand("npm", ["install"], worktree);
    if (install.code !== 0) {
      failedAttempts += 1;
      const output = commandOutput(install);
      console.log("npm install failed");
      if (failedAttempts >= MAX_FIX_ATTEMPTS) {
        return { ok: false, failure: `npm install failed after ${failedAttempts} attempts` };
      }
      // Drop the lockfile `npm install` just wrote so the next diff only judges the agent's files.
      await restoreLockfile(worktree);
      prompt = retryPrompt(
        "npm install failed. Fix package.json. Do not edit tests or package-lock.json.",
        output,
      );
      continue;
    }

    const tests = await runCommand("npm", ["test"], worktree);
    testOutput = commandOutput(tests);
    if (tests.code !== 0) {
      failedAttempts += 1;
      console.log("tests failed");
      if (failedAttempts >= MAX_FIX_ATTEMPTS) {
        return { ok: false, failure: `tests failed after ${failedAttempts} attempts` };
      }
      // Drop the lockfile `npm install` just wrote so the next diff only judges the agent's files.
      await restoreLockfile(worktree);
      prompt = retryPrompt("The tests failed. Fix the app code, not the tests.", testOutput);
      continue;
    }

    console.log("tests passed");
    return { ok: true, testOutput };
  }

  return { ok: false, failure: `stopped after ${MAX_FIX_ATTEMPTS} failed attempts` };
}

/** Sends one prompt, streams tool calls, and stores the run id and summary. */
async function sendFix(
  agent: Awaited<ReturnType<typeof Agent.create>>,
  result: FixResult,
  prompt: string,
): Promise<{ ok: true } | { ok: false; failure: string }> {
  const agentRun = await agent.send(prompt);
  result.attempts += 1;
  console.log(`attempt ${result.attempts}`);
  try {
    const watched = await watchRun(agentRun);
    result.runIds.push(watched.id);
    if (watched.requestId !== undefined) {
      result.requestIds.push(watched.requestId);
    }
    result.summary = readSummary(watched.result);
    return { ok: true };
  } catch (err) {
    if (!result.runIds.includes(agentRun.id)) {
      result.runIds.push(agentRun.id);
    }
    if (agentRun.requestId !== undefined && !result.requestIds.includes(agentRun.requestId)) {
      result.requestIds.push(agentRun.requestId);
    }
    return { ok: false, failure: errorMessage(err) };
  }
}

/**
 * Prints each finished tool call, then waits for the run.
 * Throws when the run did not finish, using the SDK's error message.
 */
async function watchRun(agentRun: AgentRun): Promise<RunResult> {
  for await (const event of agentRun.stream()) {
    if (event.type === "tool_call" && event.status === "completed") {
      const summary = summarizeToolArgs(event.args);
      console.log(summary.length > 0 ? `${event.name}  ${summary}` : event.name);
    }
  }

  const watched = await agentRun.wait();
  if (watched.status !== "finished") {
    const message = watched.error?.message;
    throw new Error(
      message !== undefined && message.length > 0 ? message : `fix ended with status ${watched.status}`,
    );
  }
  return watched;
}

/** Turns the finding and the verdict into the one prompt the agent sees. */
function buildPrompt(finding: Finding, verdict: TriageVerdict, version: string): string {
  const advisories = finding.advisories
    .map((advisory) => `- ${advisory.ghsa} (npm ${advisory.id}): ${advisory.title} (${advisory.url})`)
    .join("\n");
  const evidence =
    verdict.evidence.length > 0 ? verdict.evidence.map((spot) => `- ${spot}`).join("\n") : "- none";
  return [
    `Upgrade ${finding.package} in this repository.`,
    "",
    `Installed range: ${finding.installedRange}`,
    `Target version: ${version}`,
    `Major upgrade: ${finding.fixIsMajor ? "yes" : "no"}`,
    "",
    "Advisories:",
    advisories,
    "",
    "Triage evidence:",
    evidence,
    "",
    "Do these things:",
    `- Change only ${finding.package}'s version in package.json. Pin it exactly to ${version}.`,
    "- Update app code for the new version's breaking changes and for what the advisories recommend. Use the evidence files.",
    "- Keep behavior the same.",
    "- Never edit tests.",
    "- Never edit package-lock.json.",
    "",
    "Reply with a short summary of what you changed and why.",
  ].join("\n");
}

/** The follow-up prompt. `lead` says what failed. The tail is the last lines of output. */
function retryPrompt(lead: string, output: string): string {
  return [lead, "", lastLines(output, FAILED_OUTPUT_LINES)].join("\n");
}

/**
 * Files the agent is not allowed to touch.
 * `git diff` sees edits to tracked files. `git ls-files` sees new files the diff command skips.
 */
async function forbiddenChanges(worktree: string): Promise<string[]> {
  const tracked = await runChecked("git", ["diff", "--name-only"], worktree);
  const untracked = await runChecked("git", ["ls-files", "--others", "--exclude-standard"], worktree);
  return [...textLines(tracked), ...textLines(untracked)].filter(isForbiddenPath);
}

/** Puts `package-lock.json` back to the branch tip. The next diff can then see an edit the agent made. */
async function restoreLockfile(worktree: string): Promise<void> {
  await runChecked("git", ["checkout", "--", "package-lock.json"], worktree);
}

/** True for `package-lock.json` and anything inside a `test` directory. */
function isForbiddenPath(file: string): boolean {
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
  const parts = normalized.split("/");
  return parts.includes("package-lock.json") || parts.includes("test");
}

/** True when `npm audit` in the worktree still lists this package. */
async function packageStillPresent(worktree: string, packageName: string): Promise<boolean> {
  const result = await runCommand("npm", ["audit", "--json"], worktree);
  if (result.code !== 0 && result.code !== AUDIT_FINDINGS_EXIT_CODE) {
    throw new Error(commandFailure("npm", ["audit", "--json"], result));
  }

  let json: unknown;
  try {
    json = JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(`npm audit stdout was not JSON: ${errorMessage(err)}`);
  }
  return vulnerabilityNames(json).includes(packageName);
}

/** Package names in an audit report. Throws when npm reported an error instead of a report. */
function vulnerabilityNames(json: unknown): string[] {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error("npm audit stdout was not an object");
  }
  const record = json as Record<string, unknown>;
  if (!("vulnerabilities" in record)) {
    if ("error" in record) {
      throw new Error(`npm audit failed: ${npmErrorSummary(record.error)}`);
    }
    throw new Error("npm audit report has no vulnerabilities object");
  }
  const vulnerabilities = record.vulnerabilities;
  if (typeof vulnerabilities !== "object" || vulnerabilities === null || Array.isArray(vulnerabilities)) {
    throw new Error("npm audit report has no vulnerabilities object");
  }
  return Object.keys(vulnerabilities);
}

/** The summary string from an npm `{ error: { summary } }` report. */
function npmErrorSummary(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "summary" in error &&
    typeof error.summary === "string" &&
    error.summary.length > 0
  ) {
    return error.summary;
  }
  return "npm audit failed";
}

/** The commit subject and the pull request title. */
function commitTitle(packageName: string, version: string, ghsaIds: readonly string[]): string {
  return `fix(deps): upgrade ${packageName} to ${version} (${ghsaIds.join(", ")})`;
}

/** The pull request body. The last line is always `Opened by PatchDesk`. */
function buildPrBody(input: {
  finding: Finding;
  verdict: TriageVerdict;
  version: string;
  summary: string;
  testOutput: string;
  attempts: number;
  agentId: string | undefined;
  requestIds: readonly string[];
  by: string;
  at: string;
}): string {
  const advisories = input.finding.advisories
    .map((advisory) => `- [${advisory.ghsa}](${advisory.url}): ${advisory.title}`)
    .join("\n");
  const evidence =
    input.verdict.evidence.length > 0
      ? input.verdict.evidence.map((spot) => `- ${spot}`).join("\n")
      : "- none";
  const ghsaIds = input.finding.advisories.map((advisory) => advisory.ghsa).join(", ");
  const requests = input.requestIds.length > 0 ? input.requestIds.join(", ") : "none";
  return [
    "## Advisories",
    advisories,
    "",
    "## Triage",
    `Priority: ${input.verdict.priority}`,
    "Evidence:",
    evidence,
    "",
    "## What changed",
    input.summary.length > 0 ? input.summary : "The agent did not return a summary.",
    "",
    "## Tests",
    "```",
    lastLines(input.testOutput, PR_OUTPUT_LINES),
    "```",
    "",
    "## Audit",
    `Before: ${input.finding.package} ${input.finding.installedRange} (${input.finding.severity}), target ${input.version}. ${ghsaIds}`,
    `After: ${input.finding.package} does not appear in npm audit.`,
    "",
    "## Run",
    `Attempts: ${input.attempts}`,
    `Agent: ${input.agentId ?? "none"}`,
    `Requests: ${requests}`,
    "",
    `Approved by ${input.by} at ${input.at}`,
    "",
    "Opened by PatchDesk",
    "",
  ].join("\n");
}

/**
 * Opens the pull request from the worktree so `gh` uses the customer repo, not PatchDesk.
 * The body file sits in the temp directory so `git add -A` cannot commit it.
 */
async function openPullRequest(worktree: string, branch: string, title: string, body: string): Promise<string> {
  const bodyFile = path.join(os.tmpdir(), `patchdesk-${branch.replaceAll("/", "-")}-pr.md`);
  await writeFile(bodyFile, body, "utf8");
  try {
    const created = await runCommand(
      "gh",
      ["pr", "create", "--base", "main", "--head", branch, "--title", title, "--body-file", bodyFile],
      worktree,
    );
    const url = findUrl(created.stdout) ?? findUrl(created.stderr);
    if (created.code !== 0 || url === undefined) {
      throw new Error(commandFailure("gh", ["pr", "create"], created));
    }
    return url;
  } finally {
    await unlink(bodyFile).catch(() => undefined);
  }
}

/** The first https URL in a command's output. `gh pr create` prints the new pull request there. */
function findUrl(text: string): string | undefined {
  return text.split(/\s+/).find((part) => part.startsWith("https://"));
}

/** Branch name for this package and run. Slashes in a scoped name stay, because git allows them. */
function branchName(packageName: string, runId: string): string {
  return `patchdesk/${packageName}-${runId}`;
}

/** Absolute path of the worktree. It lives under PatchDesk, not inside the customer repo. */
function worktreePath(branch: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "worktrees", branch);
}

/** An empty result. Callers fill in the failure or the pull request. */
function blankResult(packageName: string, branch: string): FixResult {
  return {
    package: packageName,
    branch,
    attempts: 0,
    testsPassed: false,
    runIds: [],
    requestIds: [],
    summary: "",
  };
}

/** Checks the object we are about to save. */
function finish(result: FixResult): FixResult {
  return fixResultSchema.parse(result);
}

/**
 * Keeps the agent's reply when it is a non-empty string.
 * Anything else becomes a sentence we can still put in the pull request.
 */
function readSummary(text: string | undefined): string {
  const parsed = z.string().safeParse(text ?? "");
  if (!parsed.success) {
    return "The agent did not return a summary.";
  }
  const trimmed = parsed.data.trim();
  return trimmed.length > 0 ? trimmed : "The agent did not return a summary.";
}

/** The last `count` lines of command output. */
function lastLines(text: string, count: number): string {
  return textLines(text).slice(-count).join("\n");
}

/** Splits command output into non-empty lines. */
function textLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Stdout and stderr together, so a failure is not hidden on the other stream. */
function commandOutput(result: CommandResult): string {
  return [result.stdout, result.stderr].filter((part) => part.trim().length > 0).join("\n");
}

/**
 * Picks a few string fields out of a tool call's args.
 * Returns an empty string when args is missing or not a plain object.
 */
function summarizeToolArgs(args: unknown): string {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return "";
  }

  const record = args as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of TOOL_ARG_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      parts.push(value);
    }
  }
  return parts.join(" ");
}

/** Runs a command and throws when the exit code is not 0. Returns stdout. */
async function runChecked(command: string, args: readonly string[], cwd?: string): Promise<string> {
  const result = await runCommand(command, args, cwd);
  if (result.code !== 0) {
    throw new Error(commandFailure(command, args, result));
  }
  return result.stdout;
}

/** A one-line description of a command that exited non-zero. */
function commandFailure(command: string, args: readonly string[], result: CommandResult): string {
  const detail = commandOutput(result).trim();
  const what = [command, ...args].join(" ");
  return detail.length > 0 ? `${what} failed (${result.code}): ${detail}` : `${what} failed (${result.code})`;
}

/**
 * Runs a command without a shell. Args are a list, so a path with spaces cannot be read as extra commands.
 * A numeric exit code resolves. A spawn failure (the command is missing) rejects.
 */
function runCommand(command: string, args: readonly string[], cwd?: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: OUTPUT_MAX_BUFFER_BYTES,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        if (typeof error.code === "number") {
          resolve({ code: error.code, stdout, stderr });
          return;
        }
        reject(error);
      },
    );
  });
}

/** The message from an unknown thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
