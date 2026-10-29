import * as os from "node:os";
import { z } from "zod";
import { POLICY } from "./config.js";
import type { Finding } from "./scan.js";
import type { TriageVerdict } from "./triage.js";

/** One package after the approval gate. Saved on the run under `steps.gate`. */
export const gateDecisionSchema = z.object({
  package: z.string().min(1),
  decision: z.enum(["approved", "skipped", "deferred-by-policy"]),
  by: z.string(),
  at: z.string(),
});

export type GateDecision = z.infer<typeof gateDecisionSchema>;

/** Answers the prompt. Tests pass a fake. The CLI passes a real terminal question. */
export type ApprovalAsk = (prompt: string) => Promise<string>;

/** `yes` approves every selected fix that is not a major upgrade, without asking. */
export type GateOptions = {
  yes?: boolean;
};

type Candidate = {
  finding: Finding;
  verdict: TriageVerdict;
};

/** Words that count as a yes. Compared after trim and lowercase. */
const APPROVE_ANSWERS = new Set(["y", "yes"]);

/**
 * Picks the findings policy allows, asks a person about each one, and returns one decision per finding.
 * `ask` is passed in so a test can answer without a terminal.
 * Decisions come back in the same order as `findings`.
 */
export async function gate(
  findings: readonly Finding[],
  verdicts: readonly TriageVerdict[],
  ask: ApprovalAsk,
  options: GateOptions = {},
): Promise<GateDecision[]> {
  // DECISION: ask in policy order (fix-now, then fix-soon), but return one decision per finding in scan order. Why: the prompts follow urgency, and the saved run lines up with the scan table. Alternative: return decisions in the order we asked, which would reshuffle the run file.
  const chosen = chooseFixes(findings, verdicts);
  const by = os.userInfo().username;
  const answered = new Map<string, GateDecision>();

  for (const { finding, verdict } of chosen) {
    console.log("");
    printFixSummary(finding, verdict);

    // DECISION: a major upgrade ignores --yes. Why: POLICY says a major bump always needs a person. Alternative: let --yes approve every selected fix, including majors.
    const mustAsk = finding.fixIsMajor && POLICY.majorUpgradeRequiresApproval;
    if (options.yes === true && !mustAsk) {
      console.log("approved (--yes)");
      answered.set(finding.package, stamp(finding.package, "approved", by));
      continue;
    }

    const answer = await ask(approvalPrompt(finding.package));
    const decision = isApproval(answer) ? "approved" : "skipped";
    answered.set(finding.package, stamp(finding.package, decision, by));
  }

  return findings.map((finding) => answered.get(finding.package) ?? stamp(finding.package, "deferred-by-policy", by));
}

/**
 * The packages we will offer to fix, in the order we will ask about them.
 * At most POLICY.maxFixesPerRun. "fix-now" comes before "fix-soon". "defer" is left out.
 */
function chooseFixes(findings: readonly Finding[], verdicts: readonly TriageVerdict[]): Candidate[] {
  // DECISION: pair each finding with a verdict by package name. Why: the two lists do not have to be in the same order. Alternative: zip them by index, which assigns the wrong priority when the lists differ.
  const verdictByPackage = new Map(verdicts.map((verdict) => [verdict.package, verdict]));
  const eligible: Array<{ candidate: Candidate; index: number }> = [];

  for (const [index, finding] of findings.entries()) {
    const verdict = verdictByPackage.get(finding.package);
    if (verdict === undefined) {
      throw new Error(`no triage verdict for ${finding.package}`);
    }
    if (!isEligible(verdict.priority)) {
      continue;
    }
    eligible.push({ candidate: { finding, verdict }, index });
  }

  // DECISION: keep the scan order when two packages share a priority. Why: two "fix-now" rows should stay in the order npm printed them. Alternative: sort by severity, which would hide that order.
  eligible.sort((left, right) => {
    const byPriority = priorityRank(left.candidate.verdict.priority) - priorityRank(right.candidate.verdict.priority);
    return byPriority !== 0 ? byPriority : left.index - right.index;
  });

  // DECISION: stop after POLICY.maxFixesPerRun packages, before the person answers. Why: a "no" must not quietly pull in another package, and the run still cannot approve more than the cap. Alternative: keep asking until that many are approved.
  return eligible.slice(0, POLICY.maxFixesPerRun).map((entry) => entry.candidate);
}

/**
 * True when this priority is one we fix, and not one we never fix.
 * `neverFix` wins if a priority is ever listed in both places.
 */
function isEligible(priority: TriageVerdict["priority"]): boolean {
  if (listed(POLICY.neverFix, priority)) {
    return false;
  }
  return listed(POLICY.fixPriorities, priority);
}

/** Where this priority sits in the ask order. Priorities we do not fix sort last. */
function priorityRank(priority: TriageVerdict["priority"]): number {
  const rank = (POLICY.fixPriorities as readonly string[]).indexOf(priority);
  return rank === -1 ? POLICY.fixPriorities.length : rank;
}

/** True when `list` contains `value`. */
function listed(list: readonly string[], value: string): boolean {
  return list.includes(value);
}

/**
 * Prints the facts a person needs before they answer.
 * The target version is "none" when npm did not name one.
 * Evidence is the agent's file:line list, or "none" when nothing in the app imports the package.
 */
function printFixSummary(finding: Finding, verdict: TriageVerdict): void {
  const evidence = verdict.evidence.length > 0 ? verdict.evidence.join("; ") : "none";
  console.log(`package: ${finding.package}`);
  console.log(`installed range: ${finding.installedRange}`);
  console.log(`target version: ${finding.fixVersion ?? "none"}`);
  console.log(`major upgrade: ${finding.fixIsMajor ? "yes" : "no"}`);
  console.log(`evidence: ${evidence}`);
}

/** The exact question `ask` receives. The trailing space keeps the cursor off the question mark. */
function approvalPrompt(packageName: string): string {
  return `Approve fix for ${packageName}? (y/N) `;
}

/**
 * True only for "y" and "yes".
 * A trailing space or a capital Y still counts. Any other answer, including just pressing Enter, does not.
 */
function isApproval(answer: string): boolean {
  // DECISION: trim and lowercase, then accept only "y" and "yes". Why: a trailing space or a capital Y is the same answer, and words like "ok" must not count. Alternative: require the exact lowercase letters with no extra space.
  return APPROVE_ANSWERS.has(answer.trim().toLowerCase());
}

/** Stamps who decided, and when. Policy deferrals use the person who ran the command. */
function stamp(packageName: string, decision: GateDecision["decision"], by: string): GateDecision {
  return {
    package: packageName,
    decision,
    by,
    at: new Date().toISOString(),
  };
}
