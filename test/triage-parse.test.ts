import assert from "node:assert/strict";
import test from "node:test";
import { parseTriageVerdicts } from "../src/triage.js";

const sample = [
  {
    package: "jsonwebtoken",
    reachable: true,
    evidence: ["src/auth.ts:12"],
    priority: "fix-now",
    reason: "The login handler verifies tokens.",
  },
  {
    package: "lodash",
    reachable: false,
    evidence: [],
    priority: "defer",
    reason: "App code never imports it.",
  },
];

test("parseTriageVerdicts reads a JSON array", () => {
  assert.deepEqual(parseTriageVerdicts(JSON.stringify(sample)), sample);
});

test("parseTriageVerdicts strips a json fence", () => {
  const fenced = `\`\`\`json\n${JSON.stringify(sample, null, 2)}\n\`\`\``;
  assert.deepEqual(parseTriageVerdicts(fenced), sample);
});

test("parseTriageVerdicts rejects a priority that is not in the list", () => {
  const broken = JSON.stringify([{ ...sample[0], priority: "later" }]);
  assert.throws(() => parseTriageVerdicts(broken), /failed validation/);
});
