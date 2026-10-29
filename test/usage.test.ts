import assert from "node:assert/strict";
import test from "node:test";
import type { SDKAgent } from "@cursor/sdk";
import { readAgentUsage, rememberUsage, type TokenCount } from "../src/usage.js";

const tokens = {
  inputTokens: 1,
  outputTokens: 2,
  cacheReadTokens: 3,
  cacheWriteTokens: 4,
};

test("readAgentUsage saves totalTokens and charged cents", async () => {
  const saved = await readAgentUsage(
    agentReturning({
      usage: { ...tokens, totalTokens: 10 },
      cost: { rawCostCents: 40, chargedCents: 25 },
      runs: [],
    }),
    [],
  );

  assert.equal(saved.totalTokens, 10);
  assert.equal(saved.cost, 25);
});

test("readAgentUsage keeps a zero charge and leaves cost off when the API omits it", async () => {
  const zero = await readAgentUsage(
    agentReturning({
      usage: { ...tokens, totalTokens: 0 },
      cost: { rawCostCents: 0, chargedCents: 0 },
      runs: [],
    }),
    [],
  );
  assert.equal(zero.totalTokens, 0);
  assert.equal(zero.cost, 0);

  const missing = await readAgentUsage(agentReturning({ usage: { ...tokens, totalTokens: 8 }, runs: [] }), []);
  assert.equal(missing.totalTokens, 8);
  assert.equal(missing.cost, undefined);
});

test("readAgentUsage falls back when getUsage throws", async () => {
  const runUsages: TokenCount[] = [];
  rememberUsage(runUsages, { totalTokens: 4 });
  rememberUsage(runUsages, { totalTokens: 6 });
  rememberUsage(runUsages, undefined);
  rememberUsage(runUsages, { totalTokens: Number.NaN });

  const saved = await readAgentUsage(
    {
      async getUsage() {
        const err = new Error("billing is off");
        (err as Error & { code: string }).code = "feature_unavailable";
        throw err;
      },
    },
    runUsages,
  );

  assert.equal(saved.totalTokens, 10);
  assert.equal(saved.cost, "unavailable");
});

test("readAgentUsage falls back when the payload is the wrong shape", async () => {
  const saved = await readAgentUsage(
    {
      async getUsage() {
        return { nope: true } as unknown as Awaited<ReturnType<SDKAgent["getUsage"]>>;
      },
    },
    [{ totalTokens: 3 }],
  );

  assert.equal(saved.totalTokens, 3);
  assert.equal(saved.cost, "unavailable");
});

/** A fake agent whose getUsage returns a fixed payload. */
function agentReturning(payload: Awaited<ReturnType<SDKAgent["getUsage"]>>): Pick<SDKAgent, "getUsage"> {
  return {
    async getUsage() {
      return payload;
    },
  };
}
