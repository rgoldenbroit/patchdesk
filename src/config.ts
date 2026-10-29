import type { ModelSelection } from "@cursor/sdk";

/** Model that decides whether each vulnerable package is actually reachable. */
export const TRIAGE_MODEL: ModelSelection = { id: "composer-2.5" };

/** Model that will edit the repo once a person has approved a fix. */
export const FIX_MODEL: ModelSelection = { id: "composer-2.5" };

/** How many times the fix agent may try before PatchDesk gives up on that package. */
export const MAX_FIX_ATTEMPTS = 2;

/** How urgent a finding is. The triage agent is only allowed to use these three words. */
type Priority = "fix-now" | "fix-soon" | "defer";

// DECISION: keep the approval rules in one object in config. Why: a person can see the limits without reading the gate. Alternative: hardcode the priorities and the number 2 inside gate.ts.
/**
 * Which findings PatchDesk will try to fix in one run.
 * The gate reads this object. The rules do not live inside the prompt loop.
 */
export const POLICY = {
  /** Ask about these priorities, in this order. */
  fixPriorities: ["fix-now", "fix-soon"],
  /** Never open a fix for these, even when the run has room under the cap. */
  neverFix: ["defer"],
  /** How many packages we will offer to fix in one run. This is not the fix agent's retry count. */
  maxFixesPerRun: 2,
  /** A major-version bump always needs a person to say yes, even when --yes is set. */
  majorUpgradeRequiresApproval: true,
} as const satisfies {
  fixPriorities: readonly Priority[];
  neverFix: readonly Priority[];
  maxFixesPerRun: number;
  majorUpgradeRequiresApproval: boolean;
};
