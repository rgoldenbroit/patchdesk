import type { SDKAgent } from "@cursor/sdk";
import { z } from "zod";

/** Token total copied from one finished run. Used only when `getUsage` throws. */
export type TokenCount = {
  totalTokens: number;
};

/**
 * Billed usage for one agent, stored on the run record.
 * `cost` is charged cents when the API returned a cost.
 * It is `"unavailable"` when `getUsage` threw.
 * It is left off when the API returned tokens but no cost yet.
 */
export type SavedUsage = {
  totalTokens: number;
  cost?: number | "unavailable";
};

/** A number here is charged cents (42 means $0.42). The report divides by 100. */
export const totalTokensSchema = z.number().finite();

/** Charged cents, or `"unavailable"` when `getUsage` threw. */
export const savedCostSchema = z.union([z.number().finite(), z.literal("unavailable")]);

/**
 * The fields we keep from `agent.getUsage()`.
 * Extra fields are ignored. A bad shape is treated as a failed call.
 */
const billedUsageSchema = z.object({
  usage: z.object({
    totalTokens: z.number().finite(),
  }),
  cost: z
    .object({
      chargedCents: z.number().finite(),
    })
    .nullish(),
});

/**
 * Remembers one run's token total so we still have a number if `getUsage` throws.
 * Skips a run that did not report a finite total.
 */
export function rememberUsage(bucket: TokenCount[], usage: { totalTokens?: number } | undefined): void {
  if (usage !== undefined && typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens)) {
    bucket.push({ totalTokens: usage.totalTokens });
  }
}

/**
 * Reads billed tokens and cost for an agent that is about to be closed.
 * Never throws. A thrown `getUsage` (including `feature_unavailable` on some local agents)
 * falls back to the token totals already collected from the run results.
 */
export async function readAgentUsage(
  agent: Pick<SDKAgent, "getUsage">,
  runUsages: readonly TokenCount[],
): Promise<SavedUsage> {
  try {
    const raw: unknown = await agent.getUsage();
    const parsed = billedUsageSchema.safeParse(raw);
    if (!parsed.success) {
      // DECISION: a usage payload that fails validation uses the same fallback as a throw. Why: the run must not die because billing data has the wrong shape. Alternative: throw, which would fail the run over a cost lookup.
      noteUnavailable("invalid usage payload");
      return fallbackUsage(runUsages);
    }
    const saved: SavedUsage = { totalTokens: parsed.data.usage.totalTokens };
    if (parsed.data.cost != null) {
      saved.cost = parsed.data.cost.chargedCents;
    }
    return saved;
  } catch (err) {
    // DECISION: any throw from getUsage becomes cost "unavailable" plus the run-result token sum. Why: local agents throw feature_unavailable on some accounts, and a missing cost must not fail the run. Alternative: rethrow anything other than that code, which would still stop the demo on those accounts.
    noteUnavailable(errorCode(err));
    return fallbackUsage(runUsages);
  }
}

/** Copies billed usage onto a triage result or a fix result. A missing cost is left off. */
export function assignUsage(target: { totalTokens?: number; cost?: number | "unavailable" }, saved: SavedUsage): void {
  target.totalTokens = saved.totalTokens;
  if (saved.cost !== undefined) {
    target.cost = saved.cost;
  }
}

/** Sums the token totals we saved off each finished run. */
function fallbackUsage(runUsages: readonly TokenCount[]): SavedUsage {
  const totalTokens = runUsages.reduce((sum, usage) => sum + usage.totalTokens, 0);
  return { totalTokens, cost: "unavailable" };
}

/** One short line so the run output explains a report that says cost is unavailable. */
function noteUnavailable(reason: string): void {
  console.log(`usage cost unavailable (${reason})`);
}

/** A stable code when the SDK sent one, otherwise the first line of the error. */
function errorCode(err: unknown): string {
  if (typeof err === "object" && err !== null && "code" in err && typeof err.code === "string" && err.code.length > 0) {
    return err.code;
  }
  if (err instanceof Error && err.message.trim().length > 0) {
    const line = err.message.split("\n")[0];
    return line !== undefined && line.length > 0 ? line : "unknown";
  }
  return "unknown";
}
