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

  it("accepts a new repository target", () => {
    const options = parseArguments(
      ["--create-repo", "flex4237/accounting-app", "--task", "Build a local accounting app"],
      true,
    );

    assert.equal(options.createRepository, true);
    assert.equal(options.push, true);
    assert.deepEqual(options.repository, { owner: "flex4237", name: "accounting-app" });
  });

  it("requires a token and publishing when creating a repository", () => {
    const args = ["--create-repo", "flex4237/accounting-app", "--task", "Build an app"];
    assert.throws(() => parseArguments(args, false), /GITHUB_TOKEN/);
    assert.throws(() => parseArguments([...args, "--no-push"], true), /requires publishing/);
  });

  it("does not allow both an existing and new repository target", () => {
    assert.throws(
      () =>
        parseArguments([
          "--create-repo",
          "flex4237/accounting-app",
          "--repo",
          "flex4237/Validot",
          "--task",
          "Build an app",
        ]),
      /either --repo or --create-repo/,
    );
  });
});
