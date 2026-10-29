import assert from "node:assert/strict";
import { readFile, unlink } from "node:fs/promises";
import test from "node:test";
import { formatDuration, renderReport, writeReport } from "../src/report.js";
import { loadRun, newRun, reportFile, runFile, saveRun, type Run } from "../src/state.js";

test("formatDuration uses seconds under a minute and minutes after that", () => {
  assert.equal(formatDuration("2026-10-29T17:00:00.000Z", "2026-10-29T17:00:01.500Z"), "1.5s");
  assert.equal(formatDuration("2026-10-29T17:00:00.000Z", "2026-10-29T17:01:00.000Z"), "1m 0s");
  assert.equal(formatDuration("2026-10-29T17:00:00.000Z", "2026-10-29T17:01:30.000Z"), "1m 30s");
  assert.equal(formatDuration("not-a-date", "also-not"), "unknown");
});

test("renderReport lists packages, step durations, tokens, and dollars", () => {
  const markdown = renderReport(sampleRun());

  assert.match(markdown, /\| package \| npm severity \| PatchDesk priority \| decision \| PR link \|/);
  assert.match(
    markdown,
    /\| jsonwebtoken \| high \| fix-now \| approved \| https:\/\/example\.com\/pull\/1 \|/,
  );
  assert.match(markdown, /\| lodash \| moderate \| defer \| deferred-by-policy \| none \|/);
  assert.match(markdown, /- scan: 1\.5s/);
  assert.match(markdown, /- triage: 30\.0s, 8000 tokens, \$0\.20/);
  assert.match(markdown, /- gate: 1m 0s/);
  assert.match(markdown, /- fix jsonwebtoken: 1m 30s, 1000 tokens, \$0\.05/);
  assert.match(markdown, /Total tokens: 9000/);
  assert.match(markdown, /Cost: \$0\.25/);
});

test("renderReport says unavailable when getUsage could not return a cost", () => {
  const run = sampleRun();
  const triage = run.steps.triage;
  const fix = run.steps.fixes?.[0];
  if (triage === undefined || fix === undefined) {
    throw new Error("sample run is missing triage or the fix");
  }
  triage.cost = "unavailable";
  fix.cost = "unavailable";

  const markdown = renderReport(run);
  assert.match(markdown, /- triage: 30\.0s, 8000 tokens, cost unavailable/);
  assert.match(markdown, /- fix jsonwebtoken: 1m 30s, 1000 tokens, cost unavailable/);
  assert.match(markdown, /Cost: unavailable/);
});

test("renderReport keeps the known dollars when only one agent has no cost", () => {
  const run = sampleRun();
  const fix = run.steps.fixes?.[0];
  if (fix === undefined) {
    throw new Error("sample run is missing the fix");
  }
  fix.cost = "unavailable";

  const markdown = renderReport(run);
  assert.match(markdown, /Cost: \$0\.20 \(some unavailable\)/);
});

test("renderReport treats a zero charge as $0.00", () => {
  const run = sampleRun();
  const triage = run.steps.triage;
  const fix = run.steps.fixes?.[0];
  if (triage === undefined || fix === undefined) {
    throw new Error("sample run is missing triage or the fix");
  }
  triage.cost = 0;
  triage.totalTokens = 0;
  fix.cost = 0;
  fix.totalTokens = 0;

  const markdown = renderReport(run);
  assert.match(markdown, /Cost: \$0\.00/);
});

test("writeReport writes runs/<runId>.md", async () => {
  const run = sampleRun();
  run.runId = "1999-12-31T23-59-59-999Z";
  const file = reportFile(run.runId);
  try {
    assert.equal(await writeReport(run), file);
    assert.equal(await readFile(file, "utf8"), renderReport(run));
  } finally {
    await unlink(file).catch(() => undefined);
  }
});

test("reportFile rejects an id that is not a timestamp", () => {
  assert.throws(() => reportFile("../secret"), /invalid run id/);
});

test("saveRun and loadRun keep timings, token totals, and cost", async () => {
  const run = newRun("/tmp/patient");
  run.timings.scan = { startedAt: run.startedAt, endedAt: run.startedAt };
  run.steps.triage = {
    agentId: "agent",
    runId: "run-1",
    totalTokens: 12,
    cost: "unavailable",
    verdicts: [],
  };
  run.steps.fixes = [
    {
      package: "lodash",
      branch: "patchdesk/lodash-test",
      attempts: 1,
      testsPassed: true,
      runIds: [],
      requestIds: [],
      summary: "upgraded",
      totalTokens: 5,
      cost: 10,
      prUrl: "https://example.com/pull/2",
    },
  ];

  try {
    await saveRun(run);
    assert.deepEqual(await loadRun(run.runId), run);
  } finally {
    await unlink(runFile(run.runId)).catch(() => undefined);
  }
});

/** A finished run with one approved fix and one package policy left alone. */
function sampleRun(): Run {
  return {
    runId: "2026-10-29T17-00-00-000Z",
    repoDir: "/tmp/patient",
    startedAt: "2026-10-29T17:00:00.000Z",
    timings: {
      scan: { startedAt: "2026-10-29T17:00:00.000Z", endedAt: "2026-10-29T17:00:01.500Z" },
      triage: { startedAt: "2026-10-29T17:00:01.500Z", endedAt: "2026-10-29T17:00:31.500Z" },
      gate: { startedAt: "2026-10-29T17:00:31.500Z", endedAt: "2026-10-29T17:01:31.500Z" },
      fixes: [
        {
          package: "jsonwebtoken",
          startedAt: "2026-10-29T17:01:31.500Z",
          endedAt: "2026-10-29T17:03:01.500Z",
        },
      ],
    },
    steps: {
      scan: [
        {
          package: "jsonwebtoken",
          severity: "high",
          installedRange: "8.5.1",
          advisories: [
            {
              id: 1,
              ghsa: "GHSA-1111-2222-3333",
              title: "jwt issue",
              url: "https://github.com/advisories/GHSA-1111-2222-3333",
              severity: "high",
            },
          ],
          fixVersion: "9.0.3",
          fixIsMajor: true,
        },
        {
          package: "lodash",
          severity: "moderate",
          installedRange: "4.17.21",
          advisories: [
            {
              id: 2,
              ghsa: "GHSA-4444-5555-6666",
              title: "lodash issue",
              url: "https://github.com/advisories/GHSA-4444-5555-6666",
              severity: "moderate",
            },
          ],
          fixVersion: "4.18.1",
          fixIsMajor: false,
        },
      ],
      triage: {
        agentId: "triage-agent",
        runId: "run-triage",
        totalTokens: 8000,
        cost: 20,
        verdicts: [
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
        ],
      },
      gate: [
        { package: "jsonwebtoken", decision: "approved", by: "russ", at: "2026-10-29T17:01:00.000Z" },
        { package: "lodash", decision: "deferred-by-policy", by: "russ", at: "2026-10-29T17:01:00.000Z" },
      ],
      fixes: [
        {
          package: "jsonwebtoken",
          branch: "patchdesk/jsonwebtoken-2026-10-29T17-00-00-000Z",
          prUrl: "https://example.com/pull/1",
          attempts: 1,
          testsPassed: true,
          runIds: ["run-fix"],
          requestIds: [],
          summary: "Pinned jsonwebtoken to 9.0.3.",
          totalTokens: 1000,
          cost: 5,
        },
      ],
    },
  };
}
