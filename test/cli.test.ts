import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArguments } from "../src/cli.js";

const requiredArguments = [
  "--repo",
  "flex4237/Validot",
  "--task",
  "Add number validation",
];

describe("parseArguments", () => {
  it("pushes by default when a GitHub token is available", () => {
    const options = parseArguments(requiredArguments, true);

    assert.equal(options.push, true);
    assert.deepEqual(options.repository, { owner: "flex4237", name: "Validot" });
  });

  it("supports dry runs without a GitHub token", () => {
    const options = parseArguments([...requiredArguments, "--no-push"], false);

    assert.equal(options.push, false);
  });

  it("requires a GitHub token when pushing", () => {
    assert.throws(() => parseArguments(requiredArguments, false), /GITHUB_TOKEN/);
  });
});
