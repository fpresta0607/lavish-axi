import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

// Every box he writes to the agent in is the one message box of src/message-box.js. They drifted
// apart once: the pencil on a queued note and Other on a question each drew a plain field of its
// own, with no microphone and no images (the Overlord, 2026-11-11). A field written anywhere else
// is the start of the same drift, so its markup may appear in that one module only.
const srcDir = new URL("../src/", import.meta.url);

test("a text box is written only in the one message box", async () => {
  const scripts = (await readdir(srcDir)).filter((name) => name.endsWith(".js"));
  const writers = [];
  for (const name of scripts) {
    const source = await readFile(new URL(name, srcDir), "utf8");
    if (/<textarea\b/.test(source)) writers.push(name);
  }

  assert.deepEqual(writers, ["message-box.js"]);
});

// The page's boxes are mounted by one function, so a new box on the page cannot wire its own
// field, paperclip or microphone.
test("the page mounts every one of its boxes through the one mount", async () => {
  const sdk = await readFile(new URL("artifact-sdk.js", srcDir), "utf8");

  assert.equal(sdk.match(/messageBoxHtml\(/g)?.length, 1, "the box's markup is asked for once");
  assert.equal(sdk.match(/createVoiceBubble\(/g)?.length, 1, "and so is its voice bubble");
  assert.equal(sdk.match(/makeAttachmentsController\(/g)?.length, 2, "its images: the definition and the one use");
  assert.equal(sdk.match(/ = mountMessageBox\(/g)?.length, 2, "two boxes are mounted");
  assert.deepEqual(
    [...sdk.matchAll(/^\s+id: "(lavish\w+)"/gm)].map((match) => match[1]),
    ["lavishCard", "lavishChoice"],
    "the annotation card's and a question's written answer",
  );
});
