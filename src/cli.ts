import { stat } from "node:fs/promises";
import path from "node:path";
import { scan, type Finding } from "./scan.js";
import { newRun, saveRun } from "./state.js";
import { triage, type TriageVerdict } from "./triage.js";

const USAGE = "usage: npm run patchdesk -- run --repo <path> [--triage-only]";

const TABLE_HEADERS = ["package", "severity", "advisories", "fix version", "major upgrade"] as const;

/** Gap between table columns. Two spaces keeps the header readable without a library. */
const COLUMN_GAP = "  ";

/**
 * `npm run patchdesk -- run --repo <path> [--triage-only]`
 * Resolves the repo, scans it, asks the triage agent for a verdict on each finding,
 * saves both, and prints the two tables plus the run id.
 * `--triage-only` stops after that. Later steps will run only when the flag is absent.
 */
async function main(): Promise<void> {
  const { repo, triageOnly } = parseArgs(process.argv.slice(2));
  const repoDir = await resolveRepo(repo);
  const run = newRun(repoDir);
  run.steps.scan = await scan(repoDir);
  await saveRun(run);
  printTable(run.steps.scan);

  const triageResult = await triage(repoDir, run.steps.scan);
  run.steps.triage = triageResult;
  await saveRun(run);
  console.log("");
  printTriageTable(run.steps.scan, triageResult.verdicts);
  console.log("");
  console.log(`run id: ${run.runId}`);

  if (triageOnly) {
    return;
  }
}

/**
 * Reads `run --repo <path> [--triage-only]` from the argument list.
 * `--triage-only` takes no value. Anything else is a usage error.
 */
function parseArgs(argv: readonly string[]): { repo: string; triageOnly: boolean } {
  if (argv[0] !== "run") {
    throw new Error(USAGE);
  }

  let repo: string | undefined;
  let triageOnly = false;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--triage-only") {
      triageOnly = true;
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
  return { repo, triageOnly };
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
