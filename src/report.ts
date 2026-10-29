import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Run } from "./state.js";
import { reportFile } from "./state.js";

/** One step that may have billed usage. Scan and the gate do not. */
type BilledStep = {
  totalTokens?: number;
  cost?: number | "unavailable";
};

/** An agent step that recorded a token total. */
type RecordedUsage = {
  totalTokens: number;
  cost?: number | "unavailable";
};

/**
 * Writes `runs/<runId>.md` and returns that absolute path.
 * The file is a summary of the run record: the package table, how long each step took,
 * the token total, and the cost in dollars when we have charged cents.
 */
export async function writeReport(run: Run): Promise<string> {
  const file = reportFile(run.runId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, renderReport(run), "utf8");
  return file;
}

/**
 * The markdown report for one run.
 * Dollars are charged cents divided by 100. A cost of `"unavailable"` stays the word unavailable.
 */
export function renderReport(run: Run): string {
  const table = markdownTable(
    ["package", "npm severity", "PatchDesk priority", "decision", "PR link"],
    findingRows(run),
  );
  const steps = stepLines(run);
  return [
    `# PatchDesk run ${run.runId}`,
    "",
    table,
    "",
    "## Steps",
    "",
    ...(steps.length > 0 ? steps : ["- (none)"]),
    "",
    usageSummary(run),
    "",
  ].join("\n");
}

/** How long a step took, from the start and end times stored on the run. */
export function formatDuration(startedAt: string, endedAt: string): string {
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) {
    return "unknown";
  }
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  let seconds = Math.round(totalSeconds - minutes * 60);
  let wholeMinutes = minutes;
  if (seconds === 60) {
    wholeMinutes += 1;
    seconds = 0;
  }
  return `${wholeMinutes}m ${seconds}s`;
}

/** One table row per scanned package, in scan order. */
function findingRows(run: Run): string[][] {
  const verdicts = new Map(run.steps.triage?.verdicts.map((verdict) => [verdict.package, verdict]) ?? []);
  const decisions = new Map(run.steps.gate?.map((decision) => [decision.package, decision]) ?? []);
  const fixes = new Map(run.steps.fixes?.map((fix) => [fix.package, fix]) ?? []);

  return (run.steps.scan ?? []).map((finding) => [
    finding.package,
    finding.severity,
    verdicts.get(finding.package)?.priority ?? "none",
    decisions.get(finding.package)?.decision ?? "none",
    fixes.get(finding.package)?.prUrl ?? "none",
  ]);
}

/** One line per step that has a start and end time. Agent steps also show tokens and cost. */
function stepLines(run: Run): string[] {
  const lines: string[] = [];
  const { timings } = run;
  if (timings.scan !== undefined) {
    lines.push(`- scan: ${formatDuration(timings.scan.startedAt, timings.scan.endedAt)}`);
  }
  if (timings.triage !== undefined) {
    lines.push(`- triage: ${formatDuration(timings.triage.startedAt, timings.triage.endedAt)}${usageSuffix(run.steps.triage)}`);
  }
  if (timings.gate !== undefined) {
    lines.push(`- gate: ${formatDuration(timings.gate.startedAt, timings.gate.endedAt)}`);
  }
  for (const fixTiming of timings.fixes ?? []) {
    const fix = run.steps.fixes?.find((item) => item.package === fixTiming.package);
    lines.push(`- fix ${fixTiming.package}: ${formatDuration(fixTiming.startedAt, fixTiming.endedAt)}${usageSuffix(fix)}`);
  }
  return lines;
}

/** Tokens and cost for an agent step. Empty when that step never recorded usage. */
function usageSuffix(step: BilledStep | undefined): string {
  if (step?.totalTokens === undefined) {
    return "";
  }
  return `, ${step.totalTokens} tokens, ${formatCost(step.cost)}`;
}

/** The run-wide token total and dollar cost, summed across triage and each fix. */
function usageSummary(run: Run): string {
  const parts = recordedUsage(run);
  const tokens = parts.reduce((sum, step) => sum + step.totalTokens, 0);
  return [`Total tokens: ${tokens}`, `Cost: ${formatTotalCost(parts)}`].join("\n");
}

/** Triage and each fix that recorded a token total. Scan and the gate are not included. */
function recordedUsage(run: Run): RecordedUsage[] {
  const parts: RecordedUsage[] = [];
  const triage = run.steps.triage;
  if (triage?.totalTokens !== undefined) {
    parts.push({ totalTokens: triage.totalTokens, cost: triage.cost });
  }
  for (const fix of run.steps.fixes ?? []) {
    if (fix.totalTokens !== undefined) {
      parts.push({ totalTokens: fix.totalTokens, cost: fix.cost });
    }
  }
  return parts;
}

/**
 * Dollars when every agent reported charged cents.
 * "unavailable" when none did and at least one call threw.
 * A partial sum says so, because adding only the known cents would look like the whole bill.
 */
function formatTotalCost(parts: readonly RecordedUsage[]): string {
  if (parts.length === 0) {
    return "not reported";
  }
  let cents = 0;
  let sawNumber = false;
  let sawUnavailable = false;
  let sawMissing = false;
  for (const part of parts) {
    if (typeof part.cost === "number") {
      cents += part.cost;
      sawNumber = true;
    } else if (part.cost === "unavailable") {
      sawUnavailable = true;
    } else {
      sawMissing = true;
    }
  }
  if (sawNumber) {
    const dollars = formatDollars(cents);
    // DECISION: say when the dollar figure is only part of the bill. Why: a thrown getUsage and a real charge can show up in the same run, and a lone dollar amount would hide that. Alternative: print "unavailable" whenever any agent failed, which would hide the charges we do have.
    if (sawUnavailable) {
      return `${dollars} (some unavailable)`;
    }
    if (sawMissing) {
      return `${dollars} (some not reported)`;
    }
    return dollars;
  }
  if (sawUnavailable) {
    return "unavailable";
  }
  return "not reported";
}

/** One agent's cost, in the same words the total line uses. */
function formatCost(cost: number | "unavailable" | undefined): string {
  if (cost === "unavailable") {
    return "cost unavailable";
  }
  if (cost === undefined) {
    return "cost not reported";
  }
  return formatDollars(cost);
}

/**
 * Turns charged cents into dollars.
 * Whole cents print with two decimal places ($0.42). A fractional cent prints as-is.
 */
function formatDollars(cents: number): string {
  // DECISION: divide by 100 only when writing the report. Why: the run record keeps the API's charged cents, and dividing twice would round. Alternative: store dollars on the run record.
  const dollars = cents / 100;
  if (Number.isInteger(cents)) {
    return `$${dollars.toFixed(2)}`;
  }
  return `$${dollars}`;
}

/** A GitHub-flavored markdown table. Cell text cannot break the column with a pipe or a newline. */
function markdownTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const head = `| ${headers.map(cell).join(" | ")} |`;
  const rule = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.map(cell).join(" | ")} |`);
  return [head, rule, ...body].join("\n");
}

/** Makes one cell safe to sit between pipes. */
function cell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
