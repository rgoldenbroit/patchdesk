import { stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fixOne, type FixResult } from "./fix.js";
import { gate, type ApprovalAsk, type GateDecision } from "./gate.js";
import { writeReport } from "./report.js";
import { scan, type Finding } from "./scan.js";
import { newRun, saveRun, type Run } from "./state.js";
import { triage, type TriageVerdict } from "./triage.js";

const USAGE = "usage: npm run patchdesk -- run --repo <path> [--triage-only] [--yes]";

const TABLE_HEADERS = ["package", "severity", "advisories", "fix version", "major upgrade"] as const;

/** Gap between table columns. Two spaces keeps the header readable without a library. */
const COLUMN_GAP = "  ";

/**
 * `npm run patchdesk -- run --repo <path> [--triage-only] [--yes]`
 * Resolves the repo, scans it, asks the triage agent for a verdict on each finding,
 * then asks a person which of those fixes to approve.
 * Each approved package is fixed on its own branch. A pull request is opened when the tests and the audit pass.
 * Each step is saved, with the time it started and the time it finished.
 * At the end, a markdown report is written to `runs/<runId>.md` and that path is printed as the last line.
 * `--triage-only` stops before the approval questions. It still writes the report.
 * `--yes` approves fixes that are not major upgrades without asking. A major upgrade still asks.
 */
async function main(): Promise<void> {
  const { repo, triageOnly, yes } = parseArgs(process.argv.slice(2));
  const repoDir = await resolveRepo(repo);
  const run = newRun(repoDir);

  const scanStartedAt = stamp();
  run.steps.scan = await scan(repoDir);
  run.timings.scan = { startedAt: scanStartedAt, endedAt: stamp() };
  await saveRun(run);
  printTable(run.steps.scan);

  const triageStartedAt = stamp();
  const triageResult = await triage(repoDir, run.steps.scan);
  run.timings.triage = { startedAt: triageStartedAt, endedAt: stamp() };
  run.steps.triage = triageResult;
  await saveRun(run);
  console.log("");
  printTriageTable(run.steps.scan, triageResult.verdicts);
  console.log("");
  console.log(`run id: ${run.runId}`);

  if (triageOnly) {
    // DECISION: write the report for a triage-only run too. Why: that run still finished a scan and a triage, and the last line should still be the report path. Alternative: write the file only after the gate and the fixes.
    await writeAndPrintReport(run);
    return;
  }

  // DECISION: pass --yes into the gate instead of answering inside readline. Why: the gate is the only place that knows whether this fix is a major upgrade, and a major upgrade still has to be asked. Alternative: answer "y" inside createAsk whenever --yes is set, which would also auto-approve a major upgrade.
  const gateStartedAt = stamp();
  const prompts = createAsk();
  let decisions: GateDecision[];
  try {
    decisions = await gate(run.steps.scan, triageResult.verdicts, prompts.ask, { yes });
    run.timings.gate = { startedAt: gateStartedAt, endedAt: stamp() };
    run.steps.gate = decisions;
    await saveRun(run);
    console.log("");
    printDecisions(decisions);
  } finally {
    prompts.close();
  }

  const findings = run.steps.scan;
  if (findings === undefined) {
    throw new Error("run is missing its scan");
  }
  run.steps.fixes = [];
  run.timings.fixes = [];
  for (const decision of decisions) {
    if (decision.decision !== "approved") {
      continue;
    }
    const finding = findings.find((item) => item.package === decision.package);
    const verdict = triageResult.verdicts.find((item) => item.package === decision.package);
    if (finding === undefined || verdict === undefined) {
      throw new Error(`approved package ${decision.package} is missing from the scan or triage`);
    }
    const fixStartedAt = stamp();
    const result = await fixOne(run, finding, verdict);
    run.timings.fixes.push({ package: decision.package, startedAt: fixStartedAt, endedAt: stamp() });
    run.steps.fixes.push(result);
    await saveRun(run);
    console.log("");
    printFixResult(result);
  }

  await writeAndPrintReport(run);
}

/** The current time as an ISO string. This is a step's start or end. */
function stamp(): string {
  return new Date().toISOString();
}

/**
 * Writes the markdown report and prints its path.
 * Nothing is printed after this, so the path is the last line of a finished run.
 */
async function writeAndPrintReport(run: Run): Promise<void> {
  // DECISION: print only the path, with no label. Why: the last line of output is the report path, and a label would make that line harder to copy. Alternative: print "report: <path>".
  console.log(await writeReport(run));
}

/**
 * Reads `run --repo <path> [--triage-only] [--yes]` from the argument list.
 * `--triage-only` and `--yes` take no value. Anything else is a usage error.
 */
function parseArgs(argv: readonly string[]): { repo: string; triageOnly: boolean; yes: boolean } {
  if (argv[0] !== "run") {
    throw new Error(USAGE);
  }

  let repo: string | undefined;
  let triageOnly = false;
  let yes = false;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--triage-only") {
      triageOnly = true;
      continue;
    }
    if (token === "--yes") {
      yes = true;
      continue;
    }
    if (token !== "--repo") {
      throw new Error(USAGE);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("-")) {
      throw new Error(USAGE);
    }
    repo = value;
    index += 1;
  }

  if (repo === undefined) {
    throw new Error(USAGE);
  }
  return { repo, triageOnly, yes };
}

/**
 * Builds the `ask` function the gate calls.
 * The terminal opens on the first question and closes when the gate is done.
 * Tests never call this. They pass their own `ask`.
 */
function createAsk(): { ask: ApprovalAsk; close: () => void } {
  let rl: ReturnType<typeof createInterface> | undefined;
  return {
    ask(prompt: string): Promise<string> {
      // DECISION: open the terminal on the first question. Why: --yes can finish without a prompt, and opening stdin early would hold the terminal for no reason. Alternative: open it as soon as the gate starts, even when nobody is asked.
      rl ??= createInterface({ input: process.stdin, output: process.stdout });
      return rl.question(prompt);
    },
    close(): void {
      rl?.close();
    },
  };
}

/**
 * Makes the repo path absolute and checks that it is a directory.
 * Later steps reuse this path, so it must not depend on the shell's current folder.
 */
async function resolveRepo(repo: string): Promise<string> {
  // DECISION: store the absolute path from `path.resolve`, without resolving symlinks. Why: later steps need a stable folder even if the command is started somewhere else, and the path the user typed should stay recognizable. Alternative: `realpath`, which rewrites symlinks to the canonical folder.
  const repoDir = path.resolve(repo);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(repoDir);
  } catch (err) {
    const code = typeof err === "object" && err !== null && "code" in err ? err.code : undefined;
    if (code === "ENOENT") {
      throw new Error(`repo not found: ${repoDir}`);
    }
    throw err;
  }
  if (!info.isDirectory()) {
    throw new Error(`repo path is not a directory: ${repoDir}`);
  }
  return repoDir;
}

const TRIAGE_HEADERS = ["package", "npm severity", "PatchDesk priority", "evidence"] as const;

/** Prints the pull request URL, or the reason the fix stopped. */
function printFixResult(result: FixResult): void {
  if (result.prUrl !== undefined) {
    console.log(`${result.package}  ${result.prUrl}`);
    return;
  }
  console.log(`${result.package}  ${result.failure ?? "fix failed"}`);
}

/** Prints one row per approval decision, in scan order. */
function printDecisions(decisions: readonly GateDecision[]): void {
  const rows = decisions.map((decision) => [decision.package, decision.decision]);
  printAlignedTable(["package", "decision"], rows);
}

/** Prints one row per finding. The advisories cell is a count, not the full list. */
function printTable(findings: readonly Finding[]): void {
  const rows = findings.map((finding) => [
    finding.package,
    finding.severity,
    // DECISION: print how many advisories, not each GHSA id. Why: the ids and titles are long, and the full list is already in the run file. Alternative: print every id in the cell.
    String(finding.advisories.length),
    finding.fixVersion ?? "none",
    finding.fixIsMajor ? "yes" : "no",
  ]);
  printAlignedTable(TABLE_HEADERS, rows);
}

/**
 * Prints one row per finding after triage.
 * Evidence is the file:line list, or `none` when the app never imports the package.
 */
function printTriageTable(findings: readonly Finding[], verdicts: readonly TriageVerdict[]): void {
  const byPackage = new Map(verdicts.map((verdict) => [verdict.package, verdict]));
  const rows = findings.map((finding) => {
    const verdict = byPackage.get(finding.package);
    const evidence = verdict?.evidence.join("; ") ?? "";
    return [
      finding.package,
      finding.severity,
      verdict?.priority ?? "",
      evidence.length > 0 ? evidence : "none",
    ];
  });
  printAlignedTable(TRIAGE_HEADERS, rows);
}

/** Prints a header and one row per record, padding each column to the widest cell. */
function printAlignedTable(headers: readonly string[], rows: readonly (readonly string[])[]): void {
  const widths = headers.map((header, index) => {
    const widestCell = rows.reduce((widest, row) => Math.max(widest, row[index]?.length ?? 0), 0);
    return Math.max(header.length, widestCell);
  });

  const line = (cells: readonly string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join(COLUMN_GAP);

  console.log(line(headers));
  for (const row of rows) {
    console.log(line(row));
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exitCode = 1;
});
