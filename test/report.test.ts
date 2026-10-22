import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { writeRunReport } from "../src/report.js";

describe("writeRunReport", () => {
  it("writes task, changes, test results, and commit details to Markdown", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-report-test-"));
    try {
      const reportPath = await writeRunReport(
        {
          repository: { owner: "example", name: "repo" },
          branch: "main",
          task: "Add a number validation",
          push: true,
          plan: "Update the validator and its test.",
          summary: "Added the number validation.",
          changes: [{ path: "src/number.ts", content: "not included in report" }],
          testResult: {
            command: "dotnet test",
            exitCode: 0,
            output: "Passed!",
          },
          commitUrl: "https://github.com/example/repo/commit/abc",
        },
        directory,
      );

      const report = await readFile(reportPath, "utf8");
      assert.match(report, /# Coding Agent Run Report/);
      assert.match(report, /example\/repo/);
      assert.match(report, /Add a number validation/);
      assert.match(report, /`src\/number\.ts`/);
      assert.match(report, /`dotnet test`/);
      assert.match(report, /https:\/\/github\.com\/example\/repo\/commit\/abc/);
      assert.doesNotMatch(report, /not included in report/);
      assert.equal((await readdir(directory)).length, 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports errors when the graph fails before returning a result", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-report-test-"));
    try {
      const reportPath = await writeRunReport(
        {
          repository: { owner: "example", name: "repo" },
          branch: "main",
          task: "Inspect repository",
          push: true,
          error: "Model request failed.",
        },
        directory,
      );

      const report = await readFile(reportPath, "utf8");
      assert.match(report, /\*\*Outcome:\*\* Failed/);
      assert.match(report, /## Error\n\nModel request failed\./);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
