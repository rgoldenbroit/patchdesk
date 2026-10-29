import { Agent, type Run, type RunResult } from "@cursor/sdk";
import { z } from "zod";
import { TRIAGE_MODEL } from "./config.js";
import type { Finding } from "./scan.js";
import { assignUsage, readAgentUsage, rememberUsage, savedCostSchema, totalTokensSchema, type TokenCount } from "./usage.js";

/** How urgent PatchDesk thinks a finding is, after looking at the app's own code. */
const prioritySchema = z.enum(["fix-now", "fix-soon", "defer"]);

/**
 * One package, judged by the triage agent.
 * `reachable` is true when the app's own code imports it.
 * `evidence` lists `file:line` spots that show that. It is empty when nothing imports the package.
 */
export const triageVerdictSchema = z.object({
  package: z.string().min(1),
  reachable: z.boolean(),
  evidence: z.array(z.string()),
  priority: prioritySchema,
  reason: z.string(),
});

export type TriageVerdict = z.infer<typeof triageVerdictSchema>;

/** Token counts the SDK reports for a finished run. Absent fields mean the run did not report them. */
const tokenUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  totalTokens: z.number(),
  reasoningTokens: z.number().optional(),
});

/**
 * What `triage` returns, and what we store on the run record.
 * `requestId`, `durationMs`, and `usage` are optional because the SDK leaves them off when it has no value.
 * `usage` is the last run's own token breakdown.
 * `totalTokens` and `cost` are the billed figures for the whole agent, read from `getUsage` just before the agent is closed.
 */
export const triageResultSchema = z.object({
  agentId: z.string(),
  runId: z.string(),
  requestId: z.string().optional(),
  durationMs: z.number().optional(),
  usage: tokenUsageSchema.optional(),
  /** Whole-agent token total. From `getUsage`, or the sum of run results when that call throws. */
  totalTokens: totalTokensSchema.optional(),
  /** Charged cents, or `"unavailable"` when `getUsage` threw. Absent when the API has not reported a cost yet. */
  cost: savedCostSchema.optional(),
  verdicts: z.array(triageVerdictSchema),
});

export type TriageResult = z.infer<typeof triageResultSchema>;

/** A whole reply wrapped in a markdown fence. The model was told not to do this, but it sometimes does. */
const JSON_FENCE = /^```(?:json)?\s*([\s\S]*?)\s*```$/;

/**
 * String fields we print from a tool call.
 * The stream types `args` as unknown, so we only read a field after checking it is a string.
 * These names are the ones the read, grep, glob, and ls tools actually send.
 */
const TOOL_ARG_KEYS = ["pattern", "globPattern", "path", "targetDirectory"] as const;

/**
 * Reads the agent's reply into verdicts.
 * Strips a surrounding ```json fence, parses the JSON, then checks the shape with zod.
 * Throws if the text is not JSON or the shape is wrong. Does not call the API.
 */
export function parseTriageVerdicts(text: string): TriageVerdict[] {
  const trimmed = text.trim();
  const fenced = JSON_FENCE.exec(trimmed);
  const body = fenced?.[1] ?? trimmed;

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`triage reply was not JSON: ${message}`);
  }

  // DECISION: ask for a JSON array and check it with zod before using it. Why: the model can invent fields or skip a package, and a cast would hide that. Alternative: trust the text and JSON.parse into the verdict type.
  const parsed = z.array(triageVerdictSchema).safeParse(json);
  if (!parsed.success) {
    throw new Error(`triage reply failed validation: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Looks at the app's own code and returns one verdict per finding.
 * Uses a single local agent. The agent is closed even when the run fails.
 */
export async function triage(repoDir: string, findings: readonly Finding[]): Promise<TriageResult> {
  // DECISION: one agent reads every finding in a single prompt. Why: reachability of two packages often shares the same files, and a second agent would re-read them. Alternative: one agent per package, which costs a full run for each row.
  const agent = await Agent.create({
    model: TRIAGE_MODEL,
    name: "patchdesk-triage",
    local: { cwd: repoDir, settingSources: ["project"] },
    // DECISION: allow only read, grep, glob, and ls. Why: triage only needs to look at the app's source, and write or shell tools could change the repo before a person approves a fix. Alternative: leave the default toolset, which includes edit and shell.
    tools: ["read", "grep", "glob", "ls"],
  });

  const runUsages: TokenCount[] = [];
  let outcome: TriageResult | undefined;
  try {
    const first = await agent.send(buildPrompt(findings));
    let result = await watchRun(first, runUsages);
    let verdicts: TriageVerdict[];
    try {
      verdicts = parseTriageVerdicts(result.result ?? "");
    } catch (err) {
      const followUp = await agent.send(correctionPrompt(err));
      result = await watchRun(followUp, runUsages);
      verdicts = parseTriageVerdicts(result.result ?? "");
    }

    outcome = {
      agentId: agent.agentId,
      runId: result.id,
      requestId: result.requestId,
      durationMs: result.durationMs,
      usage: result.usage,
      verdicts: verdictsForFindings(findings, verdicts),
    };
    return outcome;
  } finally {
    // DECISION: call getUsage before dispose, and keep the verdicts if that call throws. Why: the SDK says to read billing while the agent is still open, and feature_unavailable must not throw away a finished triage. Alternative: dispose first, which closes the agent before we can ask for the cost.
    const billed = await readAgentUsage(agent, runUsages);
    if (outcome !== undefined) {
      assignUsage(outcome, billed);
    }
    await agent[Symbol.asyncDispose]();
  }
}

/**
 * Prints each finished tool call, then waits for the run.
 * Throws when the run did not finish, using the SDK's error message.
 */
async function watchRun(run: Run, runUsages: TokenCount[]): Promise<RunResult> {
  for await (const event of run.stream()) {
    if (event.type === "tool_call" && event.status === "completed") {
      const summary = summarizeToolArgs(event.args);
      console.log(summary.length > 0 ? `${event.name}  ${summary}` : event.name);
    }
  }

  const result = await run.wait();
  rememberUsage(runUsages, result.usage);
  if (result.status !== "finished") {
    const message = result.error?.message;
    throw new Error(
      message !== undefined && message.length > 0 ? message : `triage ended with status ${result.status}`,
    );
  }
  return result;
}

/** Turns the scan list into the one prompt the agent sees. */
function buildPrompt(findings: readonly Finding[]): string {
  const findingLines = findings.map(formatFinding);
  return [
    "You are triaging npm audit findings for this repository.",
    "For each package, decide whether the app's own code imports and calls it.",
    "Look at the app's own source only. Skip node_modules. Skip tests.",
    "When the app does use the package, cite file:line evidence.",
    "",
    "Priority rules:",
    '- "fix-now" if it is reachable from a request handler or the auth path.',
    '- "fix-soon" if it is reachable but attackers cannot control its inputs.',
    '- "defer" if app code never imports it.',
    "",
    "Findings:",
    ...(findingLines.length > 0 ? findingLines : ["- (none)"]),
    "",
    "Reply with ONLY a JSON array. No markdown.",
    "Each item is { package, reachable, evidence: string[], priority, reason }.",
    'priority is one of "fix-now", "fix-soon", or "defer".',
    "Include exactly one item for each package listed above.",
  ].join("\n");
}

/** One finding, written so the agent can see the package, the installed range, and each advisory. */
function formatFinding(finding: Finding): string {
  const advisories = finding.advisories
    .map((advisory) => `${advisory.ghsa} (npm ${advisory.id}): ${advisory.title}`)
    .join("; ");
  return `- ${finding.package}, installed ${finding.installedRange}. Advisories: ${advisories}`;
}

/** The second prompt. It includes the parse error and asks for JSON only. */
function correctionPrompt(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return [
    "Your last reply failed validation:",
    message,
    "Reply with ONLY a corrected JSON array of the same shape. No markdown fences.",
  ].join("\n");
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

/**
 * Checks that the agent judged every scanned package once, and no others.
 * Returns the verdicts in the same order as the scan.
 */
function verdictsForFindings(findings: readonly Finding[], verdicts: readonly TriageVerdict[]): TriageVerdict[] {
  const byPackage = new Map<string, TriageVerdict>();
  for (const verdict of verdicts) {
    if (byPackage.has(verdict.package)) {
      throw new Error(`triage returned more than one verdict for ${verdict.package}`);
    }
    byPackage.set(verdict.package, verdict);
  }

  const expected = new Set(findings.map((finding) => finding.package));
  for (const packageName of byPackage.keys()) {
    if (!expected.has(packageName)) {
      throw new Error(`triage returned a verdict for ${packageName}, which was not in the scan`);
    }
  }

  return findings.map((finding) => {
    const verdict = byPackage.get(finding.package);
    if (verdict === undefined) {
      throw new Error(`triage returned no verdict for ${finding.package}`);
    }
    return verdict;
  });
}
