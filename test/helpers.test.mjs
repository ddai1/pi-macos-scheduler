import test from "node:test";
import assert from "node:assert/strict";
import { idFromText, plistEscape, scriptQuote } from "../extensions/macos-scheduler/helpers.mjs";

test("idFromText creates a safe bounded schedule id", () => {
  assert.equal(idFromText("Deploy API / Production!"), "deploy-api-production");
  assert.equal(idFromText("!!!"), "task");
  assert.ok(idFromText("a".repeat(100)).length <= 32);
});

test("plistEscape escapes XML-sensitive characters", () => {
  assert.equal(plistEscape(`a&b <c> "d"`), "a&amp;b &lt;c&gt; &quot;d&quot;");
});

test("scriptQuote safely quotes shell arguments containing apostrophes", () => {
  assert.equal(scriptQuote("review user's logs"), "'review user'\\''s logs'");
});
