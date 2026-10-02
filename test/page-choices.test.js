import assert from "node:assert/strict";
import test from "node:test";

import { choiceAnswer, orderedChoices, parsePageChoices } from "../src/page-choices.js";

const declare = (value) => JSON.stringify(value);

test("parsePageChoices reads one question or a list of them", () => {
  const one = parsePageChoices(
    declare({
      id: "plan",
      question: "Which plan?",
      options: ["Fix it next", "Keep 300 s"],
      recommended: "Fix it next",
    }),
  );
  const list = parsePageChoices(
    declare([
      { id: "plan", question: "Which plan?", options: ["Fix it next", "Keep 300 s"] },
      { id: "when", question: "When?", options: ["Now", "After the freeze"], asker: "cg-scrawl-look" },
    ]),
  );

  assert.deepEqual(one, [
    {
      id: "plan",
      question: "Which plan?",
      detail: "",
      asker: "",
      options: ["Fix it next", "Keep 300 s"],
      recommended: "Fix it next",
    },
  ]);
  assert.deepEqual(
    list.map((question) => [question.id, question.asker, question.recommended]),
    [
      ["plan", "", ""],
      ["when", "cg-scrawl-look", ""],
    ],
  );
});

test("parsePageChoices keeps each option word for word", () => {
  const [question] = parsePageChoices(
    declare({ id: "q", question: "Pick", options: ["  Keep 300 s  ", "A) Fix it next (now)"] }),
  );

  // The value sent back is the option exactly as declared; only surrounding space goes.
  assert.deepEqual(question.options, ["Keep 300 s", "A) Fix it next (now)"]);
});

test("parsePageChoices drops what is not a question and never throws", () => {
  assert.deepEqual(parsePageChoices("not json"), []);
  assert.deepEqual(parsePageChoices(declare("a string")), []);
  assert.deepEqual(parsePageChoices(declare(null)), []);
  assert.deepEqual(
    parsePageChoices(
      declare([
        { id: "no-question", options: ["a", "b"] },
        { id: "one-option", question: "Pick", options: ["only"] },
        { id: "not-strings", question: "Pick", options: [1, { a: 1 }, ""] },
        { question: "No id", options: ["a", "b"] },
        { id: "ok", question: "Pick", options: ["a", "b"] },
      ]),
    ).map((question) => question.id),
    ["ok"],
  );
});

test("parsePageChoices bounds what a page can declare", () => {
  const many = Array.from({ length: 30 }, (_, index) => ({
    id: "q" + index,
    question: "Pick " + index,
    options: Array.from({ length: 30 }, (_, option) => "option " + option),
  }));
  const questions = parsePageChoices(declare(many));

  assert.equal(questions.length, 8);
  assert.equal(questions[0].options.length, 8);
  assert.equal(
    parsePageChoices(declare({ id: "q", question: "x".repeat(5000), options: ["a", "b"] }))[0].question.length,
    2000,
  );
  // A question with the same id twice is one question: the first wins.
  assert.equal(
    parsePageChoices(
      declare([
        { id: "q", question: "First", options: ["a", "b"] },
        { id: "q", question: "Second", options: ["a", "b"] },
      ]),
    ).length,
    1,
  );
});

test("parsePageChoices ignores a recommendation that is not one of the options", () => {
  const [question] = parsePageChoices(declare({ id: "q", question: "Pick", options: ["a", "b"], recommended: "c" }));

  assert.equal(question.recommended, "");
});

test("orderedChoices puts the recommended option first and marks it", () => {
  const choices = orderedChoices({ options: ["Keep 300 s", "Fix it next", "Drop it"], recommended: "Fix it next" });

  assert.deepEqual(choices, [
    { value: "Fix it next", text: "Fix it next", recommended: true },
    { value: "Keep 300 s", text: "Keep 300 s", recommended: false },
    { value: "Drop it", text: "Drop it", recommended: false },
  ]);
});

// As on the board: a goblin's own letters are dropped from what is shown only when every option
// carries one and they run A, B, C in order; the value stays the option word for word.
test("orderedChoices shows options without a goblin's own letters, and keeps them in the value", () => {
  const lettered = orderedChoices({ options: ["A) Fix it next", "B) Keep 300 s"], recommended: "B) Keep 300 s" });
  const meaningful = orderedChoices({ options: ["B) Plan B", "A) Plan A"], recommended: "" });

  assert.deepEqual(lettered, [
    { value: "B) Keep 300 s", text: "Keep 300 s", recommended: true },
    { value: "A) Fix it next", text: "Fix it next", recommended: false },
  ]);
  assert.deepEqual(
    meaningful.map((choice) => choice.text),
    ["B) Plan B", "A) Plan A"],
  );
});

test("choiceAnswer is the exact option, or the written answer for Other", () => {
  const question = { options: ["Fix it next", "Keep 300 s"] };

  assert.equal(choiceAnswer(question, "option:Keep 300 s", ""), "Keep 300 s");
  assert.equal(choiceAnswer(question, "other", "  Do neither, park it  "), "Do neither, park it");
  // Nothing to send: no selection, an option the question never offered, an empty Other.
  assert.equal(choiceAnswer(question, "", ""), "");
  assert.equal(choiceAnswer(question, "option:Something else", ""), "");
  assert.equal(choiceAnswer(question, "other", "   "), "");
});
