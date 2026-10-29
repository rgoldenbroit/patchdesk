import assert from "node:assert/strict";
import { userInfo } from "node:os";
import test from "node:test";
import { gate, type ApprovalAsk, type GateDecision } from "../src/gate.js";
import type { Finding } from "../src/scan.js";
import type { TriageVerdict } from "../src/triage.js";

test("asks for fix-now before fix-soon and never asks about defer", async () => {
  const { ask, prompts } = scriptedAsk(["y", "y"]);
  const decisions = await gate(
    [finding("soon"), finding("later"), finding("now")],
    [verdict("now", "fix-now"), verdict("later", "defer"), verdict("soon", "fix-soon")],
    ask,
  );

  assert.deepEqual(prompts, ["Approve fix for now? (y/N) ", "Approve fix for soon? (y/N) "]);
  assert.deepEqual(
    decisions.map((decision) => [decision.package, decision.decision]),
    [
      ["soon", "approved"],
      ["later", "deferred-by-policy"],
      ["now", "approved"],
    ],
  );
});

test("offers at most two fixes, with fix-now ahead of fix-soon", async () => {
  const { ask, prompts } = scriptedAsk(["yes", "yes"]);
  const decisions = await gate(
    [finding("soon"), finding("now-a"), finding("now-b"), finding("now-c")],
    [
      verdict("soon", "fix-soon"),
      verdict("now-a", "fix-now"),
      verdict("now-b", "fix-now"),
      verdict("now-c", "fix-now"),
    ],
    ask,
  );

  assert.deepEqual(prompts, ["Approve fix for now-a? (y/N) ", "Approve fix for now-b? (y/N) "]);
  assert.deepEqual(
    decisions.map((decision) => [decision.package, decision.decision]),
    [
      ["soon", "deferred-by-policy"],
      ["now-a", "approved"],
      ["now-b", "approved"],
      ["now-c", "deferred-by-policy"],
    ],
  );
});

test("defer is never fixed, even when the run has room", async () => {
  const { ask, prompts } = scriptedAsk([]);
  const decisions = await gate([finding("lodash")], [verdict("lodash", "defer")], ask);

  assert.deepEqual(prompts, []);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]?.package, "lodash");
  assert.equal(decisions[0]?.decision, "deferred-by-policy");
  assert.equal(decisions[0]?.by, userInfo().username);
  assert.match(decisions[0]?.at ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("--yes approves a non-major fix and still asks for a major upgrade", async () => {
  const declined = scriptedAsk(["n"]);
  const declinedDecisions = await gate(
    [finding("lodash"), finding("jsonwebtoken", true)],
    [verdict("lodash", "fix-soon"), verdict("jsonwebtoken", "fix-now")],
    declined.ask,
    { yes: true },
  );

  assert.deepEqual(declined.prompts, ["Approve fix for jsonwebtoken? (y/N) "]);
  assert.deepEqual(
    declinedDecisions.map((decision) => [decision.package, decision.decision]),
    [
      ["lodash", "approved"],
      ["jsonwebtoken", "skipped"],
    ],
  );

  const accepted = scriptedAsk(["y"]);
  const acceptedDecisions = await gate(
    [finding("jsonwebtoken", true)],
    [verdict("jsonwebtoken", "fix-now")],
    accepted.ask,
    { yes: true },
  );
  assert.deepEqual(accepted.prompts, ["Approve fix for jsonwebtoken? (y/N) "]);
  assert.equal(acceptedDecisions[0]?.decision, "approved");
});

test("only y or yes approves", async () => {
  const approved = await decisionsFor(["y", "yes"], ["a", "b"]);
  assert.deepEqual(
    approved.map((decision) => decision.decision),
    ["approved", "approved"],
  );

  const shouted = await decisionsFor(["Y", "YES"], ["c", "d"]);
  assert.deepEqual(
    shouted.map((decision) => decision.decision),
    ["approved", "approved"],
  );

  const skipped = await decisionsFor(["n", "no"], ["e", "f"]);
  assert.deepEqual(
    skipped.map((decision) => decision.decision),
    ["skipped", "skipped"],
  );

  const pressedEnter = await decisionsFor([""], ["g"]);
  assert.equal(pressedEnter[0]?.decision, "skipped");
});

/** Runs the gate on one fix-now package per answer. */
async function decisionsFor(answers: readonly string[], packages: readonly string[]): Promise<GateDecision[]> {
  const { ask } = scriptedAsk(answers);
  return gate(
    packages.map((packageName) => finding(packageName)),
    packages.map((packageName) => verdict(packageName, "fix-now")),
    ask,
  );
}

/**
 * Records every prompt and answers from a fixed list.
 * Throws if the gate asks more questions than the list has.
 */
function scriptedAsk(answers: readonly string[]): { ask: ApprovalAsk; prompts: string[] } {
  const prompts: string[] = [];
  const queue = [...answers];
  return {
    prompts,
    ask: async (prompt: string) => {
      prompts.push(prompt);
      const next = queue.shift();
      if (next === undefined) {
        throw new Error(`unexpected prompt: ${prompt}`);
      }
      return next;
    },
  };
}

/** A finding. `fixIsMajor` defaults to false so most tests are not major upgrades. */
function finding(packageName: string, fixIsMajor = false): Finding {
  return {
    package: packageName,
    severity: "high",
    installedRange: "1.0.0",
    advisories: [
      {
        id: 1,
        ghsa: "GHSA-1111-2222-3333",
        title: `${packageName} issue`,
        url: "https://github.com/advisories/GHSA-1111-2222-3333",
        severity: "high",
      },
    ],
    fixVersion: fixIsMajor ? "2.0.0" : "1.1.0",
    fixIsMajor,
  };
}

/** A triage verdict. A deferred package has no evidence. */
function verdict(packageName: string, priority: TriageVerdict["priority"]): TriageVerdict {
  const deferred = priority === "defer";
  return {
    package: packageName,
    reachable: !deferred,
    evidence: deferred ? [] : [`src/${packageName}.ts:1`],
    priority,
    reason: deferred ? "App code never imports it." : "The app calls it.",
  };
}
