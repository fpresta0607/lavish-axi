// Helpers for the choices a page asks its reader to pick from.
//
// A page that needs a pick declares it as data, in the file it writes: one
// `<script type="application/json" data-lavish-choices>` holding a question (or a list of them)
// with its options and, optionally, the recommended one. Scrawl draws each question where the
// declaration sits, as the Code Goblins board draws a question: a plain radio list with the
// recommended option first and marked, Other for a written answer, and Send decision. The pick
// goes back as an ordinary prompt whose text is the option exactly as the page declared it.
//
// The page never builds an answer form of its own, so there is one way to answer and it looks
// the same on every page. Opened without Scrawl, the declaration is inert data.
//
// Every helper here is serialized wholesale into the artifact SDK bundle by `createSdkJs`, so
// each one may only reference its own arguments, browser globals, or its sibling exports from
// this module, and every export must be a function (see src/artifact-revisions.js).

// Bounds on what one page may declare: a review asks a handful of questions, each with the 2 to
// 4 options the fleet's question contract allows and a little room beyond it.
export function pageChoiceLimits() {
  return { questions: 8, options: 8, id: 80, question: 2000, detail: 2000, asker: 120, option: 300 };
}

/**
 * The questions a page declares, in order, each normalized and bounded. Anything that is not a
 * question with an id, a question text and at least two options is dropped; malformed JSON
 * yields none. Options are kept word for word, apart from surrounding space.
 *
 * @param {string} json
 * @returns {Array<{ id: string, question: string, detail: string, asker: string, options: string[], recommended: string }>}
 */
export function parsePageChoices(json) {
  const limits = pageChoiceLimits();
  const text = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");
  let declared;
  try {
    declared = JSON.parse(String(json || ""));
  } catch {
    return [];
  }
  const entries = Array.isArray(declared) ? declared : [declared];
  /** @type {Array<{ id: string, question: string, detail: string, asker: string, options: string[], recommended: string }>} */
  const questions = [];
  for (const entry of entries) {
    if (questions.length >= limits.questions) break;
    if (!entry || typeof entry !== "object") continue;
    const id = text(entry.id, limits.id);
    const question = text(entry.question, limits.question);
    const options = (Array.isArray(entry.options) ? entry.options : [])
      .map((option) => text(option, limits.option))
      .filter((option, index, all) => option && all.indexOf(option) === index)
      .slice(0, limits.options);
    if (!id || !question || options.length < 2 || questions.some((existing) => existing.id === id)) continue;
    const recommended = text(entry.recommended, limits.option);
    questions.push({
      id,
      question,
      detail: text(entry.detail, limits.detail),
      asker: text(entry.asker, limits.asker),
      options,
      recommended: options.includes(recommended) ? recommended : "",
    });
  }
  return questions;
}

/**
 * A question's options as they are shown, the way the board shows them: the recommended one
 * first and marked, and a goblin's own leading letters ("A) ", "b. ") dropped from the shown text
 * only when every option carries one and they run A, B, C in the declared order. The value stays
 * the option word for word.
 *
 * @param {{ options: string[], recommended: string }} question
 * @returns {Array<{ value: string, text: string, recommended: boolean }>}
 */
export function orderedChoices(question) {
  const ownLetter = /^\s*\(?([A-Ha-h])[).:]\s+/;
  const lettersInOrder = question.options.every((option, index) => {
    const match = option.match(ownLetter);
    return Boolean(match) && match[1].toUpperCase() === String.fromCharCode(65 + index);
  });
  const options = [...question.options];
  const recommendedIndex = options.indexOf(question.recommended);
  if (recommendedIndex > 0) options.unshift(...options.splice(recommendedIndex, 1));
  return options.map((value) => ({
    value,
    text: lettersInOrder ? value.replace(ownLetter, "") : value,
    recommended: value === question.recommended,
  }));
}

/**
 * What a selection sends: the chosen option exactly as declared, or the written answer for
 * Other. Empty when there is nothing to send.
 *
 * @param {{ options: string[] }} question
 * @param {string} selection `option:<the option>`, `other`, or empty
 * @param {string} written
 * @returns {string}
 */
export function choiceAnswer(question, selection, written) {
  if (selection === "other") return String(written || "").trim();
  if (!String(selection).startsWith("option:")) return "";
  const option = String(selection).slice("option:".length);
  return question.options.includes(option) ? option : "";
}
