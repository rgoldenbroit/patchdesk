import { execFile } from "node:child_process";
import { z } from "zod";

/** How serious npm says a problem is. */
const severitySchema = z.enum(["info", "low", "moderate", "high", "critical"]);

const advisorySchema = z.object({
  id: z.number(),
  ghsa: z.string().min(1),
  title: z.string(),
  url: z.string().min(1),
  severity: severitySchema,
});

/**
 * One package we might open a fix for.
 * `installedRange` is the versions currently installed.
 * `fixVersion` is null when npm did not name a version to upgrade to.
 */
export const findingSchema = z.object({
  package: z.string().min(1),
  severity: severitySchema,
  installedRange: z.string(),
  advisories: z.array(advisorySchema).min(1),
  fixVersion: z.string().nullable(),
  fixIsMajor: z.boolean(),
});

export type Finding = z.infer<typeof findingSchema>;
export type Advisory = z.infer<typeof advisorySchema>;

/** One advisory object inside npm's `via` array. Strings in that array are not advisories. */
const rawAdvisorySchema = z.object({
  source: z.number(),
  title: z.string(),
  url: z.string().min(1),
  severity: severitySchema,
});

const fixAvailableSchema = z.union([
  z.boolean(),
  z.object({
    name: z.string(),
    version: z.string(),
    isSemVerMajor: z.boolean(),
  }),
]);

const rawVulnerabilitySchema = z.object({
  name: z.string(),
  severity: severitySchema,
  via: z.array(z.union([z.string(), rawAdvisorySchema])),
  range: z.string(),
  fixAvailable: fixAvailableSchema,
});

// DECISION: drop npm fields we do not use (cvss, cwe, nodes, effects). Why: npm adds fields over time and a strict schema would start failing on new reports. Alternative: reject any key we did not list.
const auditReportSchema = z.object({
  vulnerabilities: z.record(z.string(), rawVulnerabilitySchema),
});

type RawAdvisory = z.infer<typeof rawAdvisorySchema>;
type FixAvailable = z.infer<typeof fixAvailableSchema>;

/** npm exits with 1 when the audit worked and found vulnerabilities. */
const AUDIT_FINDINGS_EXIT_CODE = 1;

// DECISION: allow up to 10 MiB of audit JSON. Why: Node's default 1 MiB cap kills `npm audit` on larger apps before we can parse it. Alternative: keep the default and fail when the report is big.
const AUDIT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/**
 * Turns npm audit JSON into findings.
 * A package is included only when `via` has at least one advisory object.
 * Packages whose `via` list is only names are skipped: another package pulled them in.
 */
export function parseAudit(json: unknown): Finding[] {
  const failure = npmFailureMessage(json);
  if (failure !== undefined) {
    throw new Error(`npm audit failed: ${failure}`);
  }

  const report = auditReportSchema.parse(json);
  const findings: Finding[] = [];

  // DECISION: keep packages in the order npm printed them. Why: that matches the audit a person just looked at. Alternative: sort by severity, which would hide npm's own order.
  for (const [packageName, vulnerability] of Object.entries(report.vulnerabilities)) {
    const rawAdvisories = vulnerability.via.filter((item): item is RawAdvisory => typeof item !== "string");
    // DECISION: ignore npm's `isDirect` flag and look at `via` instead. Why: a string-only `via` means some other package pulled this one in, which is the rule we were given. Alternative: trust `isDirect`, which is a different signal.
    if (rawAdvisories.length === 0) {
      continue;
    }

    const fix = readFix(vulnerability.fixAvailable);
    findings.push({
      package: packageName,
      severity: vulnerability.severity,
      // The package's own `range` is what is installed. Each advisory also has a range; that one is the affected span, not the install.
      installedRange: vulnerability.range,
      advisories: rawAdvisories.map(toAdvisory),
      fixVersion: fix.fixVersion,
      fixIsMajor: fix.fixIsMajor,
    });
  }

  return findings;
}

/**
 * Runs `npm audit --json` in `repoDir` and returns the same findings as `parseAudit`.
 * Exit code 1 is normal: it means npm found vulnerabilities and still printed JSON.
 */
export function scan(repoDir: string): Promise<Finding[]> {
  const stdout = runNpmAudit(repoDir);
  return stdout.then(parseAuditStdout);
}

/**
 * Reads the version npm says to upgrade to.
 * A boolean means "a fix exists" or "no fix", but it does not name a version.
 */
function readFix(fixAvailable: FixAvailable): { fixVersion: string | null; fixIsMajor: boolean } {
  if (typeof fixAvailable === "boolean") {
    // DECISION: `true` and `false` both become fixVersion null and fixIsMajor false. Why: only the object form names a version and says whether that bump is a major upgrade. Alternative: store the word "true" as the version, which is not a version anyone can install.
    return { fixVersion: null, fixIsMajor: false };
  }

  // DECISION: keep `version` and `isSemVerMajor`, and drop `name`. Why: a Finding only has a fix version and a major flag. Alternative: also remember which package npm named, which matters when the fix is an upgrade of a parent package rather than this one.
  return {
    fixVersion: fixAvailable.version,
    fixIsMajor: fixAvailable.isSemVerMajor,
  };
}

/** Copies an npm advisory into our smaller advisory shape. */
function toAdvisory(raw: RawAdvisory): Advisory {
  return {
    id: raw.source,
    ghsa: ghsaFromUrl(raw.url),
    title: raw.title,
    url: raw.url,
    severity: raw.severity,
  };
}

/**
 * The GHSA id is the last piece of the advisory URL.
 * Example: `https://github.com/advisories/GHSA-8cf7-32gw-wr33` → `GHSA-8cf7-32gw-wr33`.
 */
function ghsaFromUrl(url: string): string {
  // DECISION: parse the URL and take the last path segment. Why: a query string or a trailing slash should not become part of the id. Alternative: split the raw string on "/" and take the last piece, which breaks when the URL has a `?`.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`advisory url is not a valid URL: ${url}`);
  }

  const segment = parsed.pathname.split("/").filter((part) => part.length > 0).at(-1);
  if (segment === undefined) {
    throw new Error(`advisory url has no id: ${url}`);
  }
  return segment;
}

/**
 * npm uses `{ error: { summary } }` when the audit itself failed
 * (for example, there is no lockfile). That JSON has no `vulnerabilities` object.
 */
function npmFailureMessage(json: unknown): string | undefined {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return undefined;
  }
  if ("vulnerabilities" in json || !("error" in json)) {
    return undefined;
  }

  const error = json.error;
  if (typeof error !== "object" || error === null) {
    return "npm audit failed";
  }
  if ("summary" in error && typeof error.summary === "string" && error.summary.length > 0) {
    return error.summary;
  }
  return "npm audit failed";
}

/** Parses the text npm wrote to stdout. */
function parseAuditStdout(stdout: string): Finding[] {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`npm audit stdout was not JSON: ${message}`);
  }
  return parseAudit(json);
}

/**
 * Runs npm without a shell. Args are a list, so a path with spaces cannot be read as extra commands.
 * Resolves with stdout for exit 0 (nothing found) and exit 1 (vulnerabilities found).
 */
function runNpmAudit(repoDir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "npm",
      ["audit", "--json"],
      {
        cwd: repoDir,
        encoding: "utf8",
        maxBuffer: AUDIT_MAX_BUFFER_BYTES,
      },
      (error, stdout, stderr) => {
        if (error === null || error.code === AUDIT_FINDINGS_EXIT_CODE) {
          // DECISION: treat exit code 1 as a finished audit. Why: npm uses 1 to mean "vulnerabilities found", and the JSON report is still on stdout. Alternative: throw on every non-zero exit, which would throw away the report.
          resolve(stdout);
          return;
        }

        const detail = stderr.trim();
        const message = detail.length > 0 ? detail : error.message;
        reject(new Error(`npm audit failed (${String(error.code)}): ${message}`, { cause: error }));
      },
    );
  });
}
