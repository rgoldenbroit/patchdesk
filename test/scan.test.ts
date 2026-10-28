import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseAudit } from "../src/scan.js";

test("parseAudit reads direct advisories from a real npm audit report", async () => {
  const raw = await readFile(new URL("./fixtures/audit.json", import.meta.url), "utf8");
  const findings = parseAudit(JSON.parse(raw) as unknown);

  assert.deepEqual(
    findings.map((finding) => ({
      package: finding.package,
      severity: finding.severity,
      installedRange: finding.installedRange,
      fixVersion: finding.fixVersion,
      fixIsMajor: finding.fixIsMajor,
      advisories: finding.advisories.length,
    })),
    [
      {
        package: "jsonwebtoken",
        severity: "high",
        installedRange: "<=8.5.1",
        fixVersion: "9.0.3",
        fixIsMajor: true,
        advisories: 3,
      },
      {
        package: "lodash",
        severity: "high",
        installedRange: "<=4.17.23",
        fixVersion: "4.18.1",
        fixIsMajor: false,
        advisories: 5,
      },
      {
        package: "minimist",
        severity: "critical",
        installedRange: "1.0.0 - 1.2.5",
        fixVersion: "1.2.8",
        fixIsMajor: false,
        advisories: 1,
      },
    ],
  );

  // The fixture title really does end with a space. We keep it as npm wrote it.
  assert.deepEqual(findings[0]?.advisories[0], {
    id: 1097690,
    ghsa: "GHSA-8cf7-32gw-wr33",
    title: "jsonwebtoken unrestricted key type could lead to legacy keys usage ",
    url: "https://github.com/advisories/GHSA-8cf7-32gw-wr33",
    severity: "high",
  });
  assert.equal(findings[2]?.advisories[0]?.ghsa, "GHSA-xvch-5gv4-984h");
  assert.equal(findings[2]?.advisories[0]?.id, 1097678);
});

test("parseAudit skips packages that only list other package names in via", () => {
  const findings = parseAudit({
    vulnerabilities: {
      "pkg-b": vulnerability("pkg-b", false, [
        "pulled-in",
        advisory(9, "GHSA-aaaa-bbbb-cccc"),
      ]),
      "pulled-in": vulnerability("pulled-in", false, ["pkg-b"]),
      "pkg-a": vulnerability("pkg-a", true, [advisory(2, "GHSA-dddd-eeee-ffff")]),
    },
  });

  assert.deepEqual(
    findings.map((finding) => finding.package),
    ["pkg-b", "pkg-a"],
  );
  assert.deepEqual(
    findings[0]?.advisories.map((advisory) => advisory.ghsa),
    ["GHSA-aaaa-bbbb-cccc"],
  );
  assert.equal(findings[0]?.fixVersion, null);
  assert.equal(findings[0]?.fixIsMajor, false);
  assert.equal(findings[1]?.fixVersion, null);
  assert.equal(findings[1]?.fixIsMajor, false);
});

test("parseAudit rejects JSON that is not an audit report", () => {
  assert.throws(() => parseAudit({ metadata: {} }));
});

test("parseAudit surfaces an npm error report", () => {
  assert.throws(
    () =>
      parseAudit({
        error: { code: "ENOLOCK", summary: "This command requires an existing lockfile." },
      }),
    /existing lockfile/,
  );
});

/** A small advisory object in the shape npm puts inside `via`. */
function advisory(id: number, ghsa: string): {
  source: number;
  title: string;
  url: string;
  severity: "low";
} {
  return {
    source: id,
    title: `advisory ${ghsa}`,
    url: `https://github.com/advisories/${ghsa}`,
    severity: "low",
  };
}

/** A small vulnerability object in the shape npm puts under `vulnerabilities`. */
function vulnerability(
  name: string,
  fixAvailable: boolean,
  via: Array<string | ReturnType<typeof advisory>>,
): {
  name: string;
  severity: "low";
  via: Array<string | ReturnType<typeof advisory>>;
  range: string;
  fixAvailable: boolean;
} {
  return {
    name,
    severity: "low",
    via,
    range: "<1.0.0",
    fixAvailable,
  };
}
