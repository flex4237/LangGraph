import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeRepositoryPath } from "../src/paths.js";

describe("normalizeRepositoryPath", () => {
  it("normalizes Windows separators", () => {
    assert.equal(
      normalizeRepositoryPath("src\\feature\\file.ts"),
      "src/feature/file.ts",
    );
  });

  for (const path of [
    "../secret",
    "/absolute",
    "C:\\secret",
    ".git/config",
    ".env.local",
    "id_rsa.key",
  ]) {
    it(`rejects unsafe path ${path}`, () => {
      assert.throws(() => normalizeRepositoryPath(path));
    });
  }
});
