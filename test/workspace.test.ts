import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runNewProjectTests } from "../src/workspace.js";
import type { FileChange } from "../src/types.js";

describe("runNewProjectTests", () => {
  it("runs a generated Node project using the safe node --test script", async () => {
    const files: FileChange[] = [
      {
        path: "package.json",
        content: JSON.stringify({
          type: "module",
          scripts: { test: "node --test" },
        }),
      },
      {
        path: "test/app.test.js",
        content: [
          'import assert from "node:assert/strict";',
          'import { test } from "node:test";',
          'test("generated project runs", () => assert.equal(2 + 2, 4));',
        ].join("\n"),
      },
    ];

    const result = await runNewProjectTests(files);

    assert.equal(result.exitCode, 0, result.output);
    assert.match(result.output, /# pass 1/);
  });

  it("rejects generated npm scripts that can run arbitrary commands", async () => {
    await assert.rejects(
      runNewProjectTests([
        {
          path: "package.json",
          content: JSON.stringify({
            scripts: { test: "node --test && echo unexpected" },
          }),
        },
        { path: "README.md", content: "Generated test project" },
      ]),
      /must use `node --test`/,
    );
  });

  it("requires generated Node.js projects to include a test file", async () => {
    await assert.rejects(
      runNewProjectTests([
        {
          path: "package.json",
          content: JSON.stringify({
            type: "module",
            scripts: { test: "node --test" },
          }),
        },
        { path: "README.md", content: "Generated project without tests" },
      ]),
      /must include at least one test file/,
    );
  });
});
