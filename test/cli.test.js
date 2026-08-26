import assert from "node:assert/strict";
import test from "node:test";
import { parseArguments } from "../bin/open-kimi-ppt-skills.js";

test("rejects missing values for path and option arguments", () => {
  assert.throws(() => parseArguments(["install", "--target"]), /--target requires a value/);
  assert.throws(() => parseArguments(["render", "project", "--output"]), /--output requires a value/);
  assert.throws(() => parseArguments(["export", "project", "--output"]), /--output requires a value/);
});
