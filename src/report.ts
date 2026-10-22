import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FileChange, Repository, TestResult } from "./types.js";

export interface RunReportInput {
  repository: Repository;
  branch: string;
  task: string;
  push: boolean;
  plan?: string;
  summary?: string;
  changes?: FileChange[];
  testResult?: TestResult | null;
  commitUrl?: string;
  error?: string;
}

function formatTestResult(result: TestResult | null | undefined): string {
  if (!result) return "Not run.";

  const status = result.exitCode === 0 ? "Passed" : "Failed";
  const output = result.output
    ? result.output.split(/\r?\n/).map((line) => `    ${line}`).join("\n")
    : "    (no output)";
  return `${status} (exit code ${result.exitCode})\n\nCommand: \`${result.command}\`\n\nOutput:\n\n${output}`;
}

export async function writeRunReport(
  input: RunReportInput,
  reportsDirectory = path.resolve("reports"),
): Promise<string> {
  const timestamp = new Date().toISOString();
  const outcome = input.error
    ? "Failed"
    : input.testResult && input.testResult.exitCode !== 0
      ? "Tests failed; changes were not committed"
      : input.commitUrl
        ? "Tests passed and changes were committed"
        : "Completed without committing changes";

  const report = [
    "# Coding Agent Run Report",
    "",
    `- **Run time (UTC):** ${timestamp}`,
    `- **Outcome:** ${outcome}`,
    `- **Repository:** ${input.repository.owner}/${input.repository.name}`,
    `- **Branch:** ${input.branch}`,
    `- **Push requested:** ${input.push ? "Yes" : "No"}`,
    "",
    "## Task",
    "",
    input.task,
    "",
    "## Plan",
    "",
    input.plan || "No plan was produced.",
    "",
    "## Changes",
    "",
    ...(input.changes?.length
      ? input.changes.map((change) => `- \`${change.path.replaceAll("`", "\\`")}\``)
      : ["No file changes were produced."]),
    "",
    "## Summary",
    "",
    input.summary || "No change summary was produced.",
    "",
    "## Tests",
    "",
    formatTestResult(input.testResult),
    "",
    "## Commit",
    "",
    input.commitUrl ? input.commitUrl : "No commit was created.",
    ...(input.error ? ["", "## Error", "", input.error] : []),
    "",
  ].join("\n");

  await mkdir(reportsDirectory, { recursive: true });
  const filename = `agent-run-${timestamp.replaceAll(":", "-")}-${randomUUID()}.md`;
  const reportPath = path.join(reportsDirectory, filename);
  await writeFile(reportPath, report, { encoding: "utf8", flag: "wx" });
  return reportPath;
}
