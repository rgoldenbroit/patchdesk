import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { fixResultSchema } from "./fix.js";
import { gateDecisionSchema } from "./gate.js";
import { findingSchema } from "./scan.js";
import { triageResultSchema } from "./triage.js";

const JSON_INDENT = 2;

/** When one step started and when it finished. Both are ISO timestamps. */
const stepTimingSchema = z.object({
  startedAt: z.string(),
  endedAt: z.string(),
});

/** The same clock for one package's fix, plus the package name so the report can label the row. */
const fixTimingSchema = stepTimingSchema.extend({
  package: z.string().min(1),
});

/**
 * One PatchDesk run, saved as `runs/<runId>.json`.
 * Scan fills `steps.scan`. Triage fills `steps.triage`. The gate fills `steps.gate`. The fix step fills `steps.fixes`.
 * `timings` records the start and end of each of those steps. The markdown report is written beside this file.
 */
const runSchema = z.object({
  runId: z.string(),
  repoDir: z.string(),
  startedAt: z.string(),
  // DECISION: keep the clocks on `timings` instead of wrapping each step. Why: `steps.scan` and `steps.gate` are arrays the rest of the program already reads, and a clock does not fit inside an array. Alternative: wrap every step in `{ startedAt, endedAt, data }`.
  timings: z
    .object({
      scan: stepTimingSchema.optional(),
      triage: stepTimingSchema.optional(),
      gate: stepTimingSchema.optional(),
      fixes: z.array(fixTimingSchema).optional(),
    })
    .default({}),
  steps: z.object({
    scan: z.array(findingSchema).optional(),
    triage: triageResultSchema.optional(),
    gate: z.array(gateDecisionSchema).optional(),
    fixes: z.array(fixResultSchema).optional(),
  }),
});

export type Run = z.infer<typeof runSchema>;

/** Matches the id `newRun` builds from an ISO timestamp. */
const RUN_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

/**
 * Starts a run in memory. Nothing is written until `saveRun`.
 * `repoDir` is stored as given. The CLI passes an absolute path.
 */
export function newRun(repoDir: string): Run {
  const startedAt = new Date().toISOString();
  return {
    runId: startedAt.replaceAll(":", "-").replaceAll(".", "-"),
    repoDir,
    startedAt,
    timings: {},
    steps: {},
  };
}

/** Writes the run to `runs/<runId>.json` under the PatchDesk project. */
export async function saveRun(run: Run): Promise<void> {
  const file = runFile(run.runId);
  await mkdir(path.dirname(file), { recursive: true });
  // DECISION: pretty-print with a 2-space indent. Why: a person opens this file during a demo and needs to read it. Alternative: one long line of JSON.
  await writeFile(file, `${JSON.stringify(run, null, JSON_INDENT)}\n`, "utf8");
}

/** Loads a run that `saveRun` wrote. Throws if the id or the JSON is not a run record. */
export async function loadRun(runId: string): Promise<Run> {
  const text = await readFile(runFile(runId), "utf8");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`run file ${runId} is not valid JSON: ${message}`);
  }

  // DECISION: check the file with zod before using it. Why: it is JSON on disk and can be truncated or hand-edited. Alternative: trust JSON.parse and cast it to Run.
  const run = runSchema.parse(json);
  if (run.runId !== runId) {
    throw new Error(`run file ${runId} says its id is ${run.runId}`);
  }
  return run;
}

/** Absolute path of `runs/<runId>.json`. The id is checked so it cannot escape the runs folder. */
export function runFile(runId: string): string {
  assertRunId(runId);
  return path.join(runsDir(), `${runId}.json`);
}

/** Absolute path of `runs/<runId>.md`. The id is checked so it cannot escape the runs folder. */
export function reportFile(runId: string): string {
  assertRunId(runId);
  return path.resolve(runsDir(), `${runId}.md`);
}

/**
 * Rejects a run id that is not the timestamp shape from `newRun`.
 * The id is used as a file name, so a value like `../secret` must not get through.
 */
function assertRunId(runId: string): void {
  // DECISION: only accept the timestamp id shape. Why: the id is used as a file name. Alternative: join whatever string we are given and hope it stays inside `runs/`.
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`invalid run id: ${runId}`);
  }
}

/**
 * `runs/` next to `src/`, not inside the customer repo and not "wherever the shell happens to be".
 */
function runsDir(): string {
  // DECISION: put runs in the PatchDesk project directory. Why: `.gitignore` ignores `runs/` here, and we should not write our state into the repo being scanned. Alternative: write `runs/` inside that repo, or into the current working directory.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "runs");
}
