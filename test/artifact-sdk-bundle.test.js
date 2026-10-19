import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { createSdkJs } from "../src/server.js";

// The SDK the browser actually runs is a serialized bundle, not the module: `createSdkJs` has to
// declare every helper `createArtifactSdk` reaches for. A helper left out compiles fine and only
// ReferenceErrors on the first click, so these tests boot the served bundle and drive the real
// annotation path through a DOM stub instead of inspecting the module directly.

function createElement(tag) {
  const attributes = new Map();
  const queried = new Map();
  const element = {
    tagName: String(tag).toUpperCase(),
    nodeName: String(tag).toUpperCase(),
    nodeType: 1,
    parentElement: null,
    children: [],
    style: {},
    value: "",
    innerHTML: "",
    textContent: "",
    offsetWidth: 100,
    offsetHeight: 100,
    hidden: false,
    listeners: [],
    classList: {
      add() {},
      remove() {},
      contains() {
        return false;
      },
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
    },
    matches(selectorList) {
      return String(selectorList)
        .split(",")
        .some((part) => {
          const selector = part.trim();
          if (selector.startsWith("[")) return attributes.has(selector.slice(1, selector.indexOf("]")).split("=")[0]);
          return selector === element.tagName.toLowerCase();
        });
    },
    closest(selectorList) {
      let current = element;
      while (current) {
        if (current.matches(selectorList)) return current;
        current = current.parentElement;
      }
      return null;
    },
    appendChild(child) {
      child.parentElement = element;
      element.children.push(child);
      return child;
    },
    get firstChild() {
      return element.children[0] ?? null;
    },
    insertBefore(child, before) {
      const index = before ? element.children.indexOf(before) : -1;
      child.parentElement = element;
      element.children.splice(index < 0 ? element.children.length : index, 0, child);
      return child;
    },
    remove() {
      const index = element.parentElement?.children.indexOf(element) ?? -1;
      if (index >= 0) element.parentElement.children.splice(index, 1);
    },
    // Card internals are looked up by class after innerHTML is assigned, so hand back a stable
    // stub per selector: the test drives the very buttons the SDK wired up.
    querySelector(selector) {
      if (!queried.has(selector)) queried.set(selector, createElement(selector.replace(/^[.#]/, "")));
      return queried.get(selector);
    },
    // Only class selectors are understood, which is what removing a card or a chip needs.
    querySelectorAll(selectorList) {
      const classes = String(selectorList)
        .split(",")
        .map((part) => part.trim())
        .filter((part) => /^\.[\w-]+$/.test(part))
        .map((part) => part.slice(1));
      const found = [];
      const walk = (node) => {
        for (const child of node.children) {
          if (
            String(child.className)
              .split(" ")
              .some((name) => classes.includes(name))
          )
            found.push(child);
          walk(child);
        }
      };
      if (classes.length) walk(element);
      return found;
    },
    getBoundingClientRect() {
      return { left: 10, top: 10, right: 110, bottom: 40, width: 100, height: 30 };
    },
    addEventListener(type, handler) {
      element.listeners.push({ type, handler });
    },
    removeEventListener() {},
    focus() {},
    click() {},
    scrollIntoView() {},
    // Nothing in a stub's root holds the keyboard.
    getRootNode() {
      return { activeElement: null };
    },
    attachShadow() {
      element.shadowRoot = createElement("shadow-root");
      Object.defineProperty(element.shadowRoot, "ownerDocument", { value: Reflect.get(element, "ownerDocument") });
      return element.shadowRoot;
    },
  };
  return element;
}

function appendTo(parent, child) {
  child.parentElement = parent;
  parent.children.push(child);
  return child;
}

function cell(tag, text) {
  const element = createElement(tag);
  element.textContent = text;
  return element;
}

function bootSdk({
  runAnimationFrames = false,
  revisionsScript = null,
  revisionMarkElements = [],
  pageHeadTags = [],
  // What the page declares in its `<script data-lavish-choices>`, or null for a page without one.
  choices = null,
  // The page's `document.fonts.ready`, or null for a browser without the font loading API.
  fontsReady = null,
} = {}) {
  const posted = [];
  const documentListeners = [];
  // Deferred work the SDK schedules, run only when a test asks for it: the draft-anchor settle
  // re-query is a real timer, and asserting on it means running it rather than assuming it.
  const timers = [];
  const scheduleTimer = (fn, ms) => timers.push({ fn, ms }) && timers.length;
  const cancelTimer = (id) => {
    if (timers[id - 1]) timers[id - 1].cancelled = true;
  };
  /** @type {(selector: string) => any} */
  let documentQuery = () => null;
  const documentElement = createElement("html");
  const head = createElement("head");
  for (const tag of pageHeadTags) head.appendChild(createElement(tag));
  const body = createElement("body");
  appendTo(documentElement, head);
  appendTo(documentElement, body);
  for (const element of revisionMarkElements) appendTo(body, element);
  let choicesScript = null;
  if (choices !== null) {
    choicesScript = appendTo(body, createElement("script"));
    choicesScript.textContent = typeof choices === "string" ? choices : JSON.stringify(choices);
  }

  const sandbox = {
    parent: { postMessage: (message) => posted.push(message) },
    navigator: { platform: "Linux" },
    CSS: { escape: (value) => String(value) },
    Element: class Element {},
    MutationObserver: class MutationObserver {
      observe() {}
      disconnect() {}
    },
    ResizeObserver: class ResizeObserver {
      observe() {}
      disconnect() {}
    },
    URL: {
      createObjectURL() {
        return "blob:lavish-test";
      },
      revokeObjectURL() {},
    },
    getComputedStyle: () => ({}),
    setTimeout: scheduleTimer,
    clearTimeout: cancelTimer,
    requestAnimationFrame: (fn) => (runAnimationFrames ? scheduleTimer(fn, 0) : 0),
    document: {
      readyState: "complete",
      documentElement,
      head,
      body,
      activeElement: body,
      baseURI: "http://127.0.0.1/artifact/abc/index.html",
      addEventListener: (type, handler) => documentListeners.push({ type, handler }),
      removeEventListener() {},
      createElement(tag) {
        const element = createElement(tag);
        Object.defineProperty(element, "ownerDocument", { value: this });
        return element;
      },
      getElementById: () => null,
      querySelector: (selector) =>
        selector === "script[data-lavish-revisions]"
          ? revisionsScript
          : selector === "script[data-lavish-choices]"
            ? choicesScript
            : documentQuery(selector),
      querySelectorAll: (selector) => (selector === "[data-lavish-revision]" ? revisionMarkElements : []),
      getSelection: () => null,
      ...(fontsReady ? { fonts: { ready: fontsReady } } : {}),
    },
  };
  const windowListeners = [];
  sandbox.window = {
    addEventListener: (type, handler) => windowListeners.push({ type, handler }),
    removeEventListener() {},
    setTimeout: scheduleTimer,
    clearTimeout: cancelTimer,
    requestAnimationFrame: (fn) => (runAnimationFrames ? scheduleTimer(fn, 0) : 0),
    innerWidth: 1280,
    innerHeight: 800,
    scrollX: 0,
    scrollY: 0,
    location: { origin: "http://127.0.0.1" },
    URL: sandbox.URL,
  };
  sandbox.globalThis = sandbox;
  Object.defineProperty(sandbox.document, "defaultView", { value: sandbox.window });

  vm.runInNewContext(createSdkJs("abc", 3, "load-token"), sandbox);

  return {
    posted,
    head,
    body,
    api: sandbox.window.lavish,
    click(target) {
      const listener = documentListeners.find((entry) => entry.type === "click");
      assert.ok(listener, "the SDK registers a document click listener");
      listener.handler({ target, preventDefault() {}, stopPropagation() {} });
    },
    setDocumentQuery(query) {
      documentQuery = query;
    },
    // Runs only the pending timers due within `ms`, as that much time passing would.
    runTimersWithin(ms) {
      for (const timer of timers.filter((entry) => !entry.cancelled && entry.ms <= ms)) {
        timer.cancelled = true;
        timer.fn();
      }
    },
    runTimers() {
      const pending = timers.splice(0, timers.length);
      for (const timer of pending) {
        if (!timer.cancelled) timer.fn();
      }
    },
    async runAllTimers() {
      for (let round = 0; round < 100; round += 1) {
        await Promise.resolve();
        await Promise.resolve();
        const pending = timers.splice(0, timers.length);
        if (pending.length === 0) {
          await Promise.resolve();
          if (timers.length === 0) return;
          continue;
        }
        for (const timer of pending) {
          if (!timer.cancelled) timer.fn();
        }
      }
      assert.fail("the SDK timer queue did not settle");
    },
    // The chrome is the only legitimate sender, so its messages arrive with `source: parent`.
    sendChromeMessage(data) {
      const listeners = windowListeners.filter((entry) => entry.type === "message");
      assert.ok(listeners.length > 0, "the SDK registers a window message listener");
      for (const listener of listeners) listener.handler({ source: sandbox.parent, data });
    },
    cards() {
      return documentElement.children
        .flatMap((child) => child.shadowRoot?.children || [])
        .filter((child) => String(child.className).split(" ").includes("lavish-annotation-card"));
    },
    card() {
      const card = this.cards().at(-1);
      assert.ok(card, "clicking an element opens an annotation card");
      return card;
    },
    // The card's button adds the note to the page's notes; what the note carried is the
    // queuePrompt message.
    queue(text) {
      const card = this.card();
      card.querySelector("textarea").value = text;
      card.querySelector(".lavish-add").onclick();
      return posted.findLast((message) => message.type === "lavish:queuePrompt");
    },
    // What the page last told the chrome is selected: a note's context, or null.
    selection() {
      const report = posted.findLast((message) => message.type === "lavish:selection");
      assert.ok(report, "the SDK reports what is selected");
      return report;
    },
    shadowChildren(className) {
      return documentElement.children
        .flatMap((child) => child.shadowRoot?.children || [])
        .filter((child) => String(child.className).split(" ").includes(className));
    },
    hover(target) {
      const listener = documentListeners.find((entry) => entry.type === "mouseover");
      assert.ok(listener, "the SDK registers a document mouseover listener");
      listener.handler({ target });
    },
    // The question cards Scrawl drew for the page's declared choices, in order.
    choiceForms() {
      const host = body.children.find((child) => child.getAttribute("data-lavish-ui") === "choices");
      const list = host?.shadowRoot.children.find((child) => child.className === "lavish-choices");
      return list ? list.children : [];
    },
    choicesHostIndex: () => body.children.findIndex((child) => child.getAttribute("data-lavish-ui") === "choices"),
    choicesScriptIndex: () => body.children.indexOf(choicesScript),
  };
}

function buildTable(sdk) {
  const table = appendTo(sdk.body, createElement("table"));
  const thead = appendTo(table, createElement("thead"));
  const headerRow = appendTo(thead, createElement("tr"));
  for (const label of ["Permission / setting", "Visible state", "Database evidence"]) {
    appendTo(headerRow, cell("th", label));
  }
  const tbody = appendTo(table, createElement("tbody"));
  const dataRow = appendTo(tbody, createElement("tr"));
  appendTo(dataRow, cell("td", "Media & Apple Music"));
  appendTo(dataRow, cell("td", "4 apps"));
  const evidence = appendTo(dataRow, cell("td", "Drive, Neovide, Cursor"));
  const badge = appendTo(evidence, cell("code", "Drive"));
  return { evidence, badge };
}

test("a requested layout diagnostic publishes even when the result is unchanged", async () => {
  const sdk = bootSdk({ runAnimationFrames: true });

  await sdk.runAllTimers();
  const first = sdk.posted.filter((message) => message.type === "lavish:layoutDiagnostics");
  assert.equal(first.length, 1);

  sdk.sendChromeMessage({ type: "lavish:requestLayoutDiagnostics" });
  await sdk.runAllTimers();
  const diagnostics = sdk.posted.filter((message) => message.type === "lavish:layoutDiagnostics");
  assert.equal(diagnostics.length, 2);
  assert.equal(diagnostics[1].artifact_pass_sequence, diagnostics[0].artifact_pass_sequence + 1);
  assert.deepEqual(diagnostics[1].findings, diagnostics[0].findings);
});

// The chrome lifts its curtain on `lavish:readyToShow`. A frame behind the curtain gets about one
// animation frame a second, so none is run here, and a font that never arrives holds the message
// back only for the short font wait.
test("the served SDK says a page whose font is slow is ready to show at once", async () => {
  const sdk = bootSdk({ fontsReady: new Promise(() => {}) });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    sdk.posted.some((message) => message.type === "lavish:readyToShow"),
    false,
    "an on-time font gets a moment to arrive first",
  );

  sdk.runTimersWithin(100);
  await new Promise((resolve) => setImmediate(resolve));

  const ready = sdk.posted.filter((message) => message.type === "lavish:readyToShow");
  assert.equal(ready.length, 1);
  assert.equal(ready[0].artifact_load_token, "load-token");
  assert.equal(
    sdk.posted.some((message) => message.type === "lavish:layoutDiagnostics"),
    false,
    "the page is shown before its layout check, which runs on the shown page",
  );
});

test("the served SDK says the page is ready to show as soon as its fonts are in", async () => {
  const sdk = bootSdk({ fontsReady: Promise.resolve() });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sdk.posted.filter((message) => message.type === "lavish:readyToShow").length, 1);
});

// The page frame's scrollbars wear the dark theme through a rule with no specificity that comes
// before the page's own styles, so a page that styles its scrollbars keeps them.
test("the served SDK puts its scrollbar style ahead of the page's own styles", () => {
  const sdk = bootSdk({ pageHeadTags: ["style"] });

  const [first, second] = sdk.head.children;
  assert.equal(first.id, "lavish-scrollbar-style");
  assert.match(first.textContent, /scrollbar-color/);
  assert.equal(second.tagName, "STYLE");
});

test("the served SDK echoes the snapshot request id", () => {
  const sdk = bootSdk();

  sdk.sendChromeMessage({ type: "lavish:requestSnapshot", snapshot_request_id: "snapshot-17" });

  const response = sdk.posted.at(-1);
  assert.equal(response.type, "lavish:snapshot");
  assert.equal(response.snapshot_request_id, "snapshot-17");
  assert.equal(response.artifact_load_token, "load-token");
});

// readArtifactRevisions calls parseRevisionRegistry and collectRevisionMarks, which in turn call
// the rest of the revision helper chain; a helper left out of the bundle only ReferenceErrors on
// this real read, which a source-grep over the bundle text cannot catch.
test("the served SDK bundle reports the artifact's own revision registry and marks", () => {
  const revisionsScript = createElement("script");
  revisionsScript.textContent = JSON.stringify([
    { id: "r1", label: "Tightened header copy", summary: "Shortened the hero headline" },
  ]);
  const marked = createElement("h1");
  marked.setAttribute("data-lavish-revision", "r1");
  marked.textContent = "Ship faster";

  const sdk = bootSdk({ revisionsScript, revisionMarkElements: [marked] });

  const message = sdk.posted.find((entry) => entry.type === "lavish:revisions");
  assert.ok(message, "the SDK reports the revision registry on load");
  assert.equal(message.revisions.length, 1);
  assert.equal(message.revisions[0].id, "r1");
  assert.equal(message.revisions[0].label, "Tightened header copy");
  assert.equal(message.revisions[0].mark_count, 1);
  assert.equal(message.marks.length, 1);
  assert.equal(message.marks[0].revision_id, "r1");
  assert.equal(message.marks[0].selector, "html > body > h1");
  assert.equal(message.marks[0].excerpt, "Ship faster");
});

test("the served SDK bundle queues a table-cell annotation without a missing-helper ReferenceError", () => {
  const sdk = bootSdk();
  const { evidence } = buildTable(sdk);

  sdk.click(evidence);
  const message = sdk.queue("Check this permission");

  assert.equal(message.type, "lavish:queuePrompt");
  assert.equal(message.prompt.prompt, "Check this permission");
  assert.deepEqual(
    { ...message.prompt.target },
    {
      type: "table-cell",
      selector: "body > table > tbody > tr > td:nth-of-type(3)",
      rowLabel: "Media & Apple Music",
      columnLabel: "Database evidence",
      text: "Drive, Neovide, Cursor",
    },
  );
});

test("the served SDK bundle keeps the clicked element's own identity inside a table cell", () => {
  const sdk = bootSdk();
  const { badge } = buildTable(sdk);

  sdk.click(badge);
  const message = sdk.queue("Rename this app");

  assert.equal(message.prompt.tag, "code");
  assert.equal(message.prompt.selector, "table > tbody > tr > td:nth-of-type(3) > code");
  assert.equal(message.prompt.text, "Drive");
  assert.equal(message.prompt.target.selector, "body > table > tbody > tr > td:nth-of-type(3)");
  assert.equal(message.prompt.target.columnLabel, "Database evidence");
});

test("the annotation card names the cell it annotates when the cell itself is clicked", () => {
  const sdk = bootSdk();
  const { evidence } = buildTable(sdk);

  sdk.click(evidence);

  assert.match(sdk.card().innerHTML, /Annotate cell: Media &amp; Apple Music → Database evidence/);
  assert.match(sdk.card().innerHTML, /about this table cell/);
});

test("the annotation card names the clicked element, not the cell, for a nested click", () => {
  const sdk = bootSdk();
  const { badge } = buildTable(sdk);

  sdk.click(badge);

  assert.match(sdk.card().innerHTML, /Annotate &lt;code&gt; in Media &amp; Apple Music → Database evidence/);
  assert.doesNotMatch(sdk.card().innerHTML, /about this table cell/);
});

test("the served SDK bundle resolves table coordinates only for annotation clicks", () => {
  const sdk = bootSdk();
  const { evidence } = buildTable(sdk);

  sdk.api.queuePrompt("Programmatic note", { element: evidence });

  assert.equal(sdk.posted.at(-1).prompt.target, undefined);
});

test("the served SDK bundle annotates elements outside tables with no table target", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  sdk.click(paragraph);
  const message = sdk.queue("Reword this");

  assert.equal(message.prompt.tag, "p");
  assert.equal(message.prompt.target, undefined);
});

// closeCard() clears the element highlight, so that highlight standing or gone is the observable proof of close.
function pressEscape(textarea) {
  const listener = textarea.listeners.find((entry) => entry.type === "keydown");
  assert.ok(listener, "the annotation textarea registers a keydown listener");
  listener.handler({ key: "Escape", preventDefault() {} });
}

test("Escape closes an annotation card with no text and no attachment", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  sdk.click(paragraph);
  const textarea = sdk.card().querySelector("textarea");
  textarea.value = "   "; // whitespace-only counts as empty
  pressEscape(textarea);

  assert.equal(paragraph.style.outline, "", "the highlight is cleared, proving the card closed");
});

test("Escape during IME composition leaves an empty annotation card open", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  sdk.click(paragraph);
  const textarea = sdk.card().querySelector("textarea");
  const listener = textarea.listeners.find((entry) => entry.type === "keydown");
  listener.handler({ key: "Escape", isComposing: true, preventDefault() {} });

  assert.notEqual(paragraph.style.outline, "", "a composing Escape belongs to the IME, not the card");
});

// Escape cancels as it does on the board's diff comment, and as there the words are not lost:
// the same element's next card opens with them.
test("Escape cancels a card with typed text and keeps the text for that element", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));
  const other = appendTo(sdk.body, cell("h2", "A heading"));

  sdk.click(paragraph);
  sdk.card().querySelector("textarea").value = "keep this note";
  pressEscape(sdk.card().querySelector("textarea"));
  assert.equal(paragraph.style.outline, "", "the highlight is cleared, proving the card closed");
  assert.equal(
    sdk.posted.some((message) => message.type === "lavish:queuePrompt"),
    false,
    "a cancelled note is never queued",
  );

  sdk.click(other);
  assert.equal(sdk.card().querySelector("textarea").value, "", "another element starts empty");

  sdk.click(paragraph);
  assert.equal(sdk.card().querySelector("textarea").value, "keep this note");
});

test("the Cancel button keeps the typed text for that element too", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  sdk.click(paragraph);
  sdk.card().querySelector("textarea").value = "half a thought";
  sdk.card().querySelector(".lavish-cancel").onclick();
  sdk.click(paragraph);

  assert.equal(sdk.card().querySelector("textarea").value, "half a thought");
});

test("a sent note leaves nothing behind for its element's next card", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  sdk.click(paragraph);
  sdk.queue("Reword this");
  sdk.click(paragraph);

  assert.equal(sdk.card().querySelector("textarea").value, "");
});

function pressEnter(textarea, modifiers = {}) {
  const listener = textarea.listeners.find((entry) => entry.type === "keydown");
  assert.ok(listener, "the annotation textarea registers a keydown listener");
  listener.handler({ key: "Enter", preventDefault() {}, ...modifiers });
}

const postedTypes = (sdk) => sdk.posted.map((message) => message.type).filter((type) => /Prompt/.test(type));

// Every note waits in the page's notes for Send or Send & End, which deliver them all together:
// nothing a card does sends anything on its own (the Overlord, 2026-10-18).
test("Enter, Ctrl+Enter and Cmd+Enter each add the note to the notes and send nothing", () => {
  for (const modifier of [{}, { ctrlKey: true }, { metaKey: true }]) {
    const sdk = bootSdk();
    const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

    sdk.click(paragraph);
    sdk.card().querySelector("textarea").value = "Reword this";
    pressEnter(sdk.card().querySelector("textarea"), modifier);

    assert.deepEqual(postedTypes(sdk), ["lavish:queuePrompt"]);
    assert.equal(sdk.posted.find((message) => message.type === "lavish:queuePrompt").prompt.prompt, "Reword this");
  }
});

test("the card's button adds the note to the notes and sends nothing", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  sdk.click(paragraph);
  sdk.queue("Reword this");

  assert.deepEqual(postedTypes(sdk), ["lavish:queuePrompt"]);
  assert.equal(sdk.cards().length, 0, "the card has shrunk to its chip");
});

test("Shift+Enter is a new line and sends nothing", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  sdk.click(paragraph);
  sdk.card().querySelector("textarea").value = "First line";
  pressEnter(sdk.card().querySelector("textarea"), { shiftKey: true });

  assert.deepEqual(postedTypes(sdk), []);
});

test("Enter on an empty card closes it and sends nothing", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  sdk.click(paragraph);
  pressEnter(sdk.card().querySelector("textarea"));

  assert.deepEqual(postedTypes(sdk), []);
  assert.equal(paragraph.style.outline, "");
});

// Once sent, the card shrinks to the board's chip: what it was about, what was said, and check
// marks that follow the note's delivery as the chrome reports it.
test("a sent note shrinks to a chip whose check marks follow its delivery", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  sdk.click(paragraph);
  const note = sdk.queue("Reword <this>");
  const chip = sdk.shadowChildren("lavish-annotation-chip").at(-1);
  assert.ok(chip, "the card became a chip");
  assert.match(chip.className, /comment-overlay floating sent/);
  assert.match(chip.innerHTML, /<p class="comment-sent-text"><strong>&lt;p&gt;<\/strong> Reword &lt;this&gt;<\/p>/);
  assert.match(chip.innerHTML, /<span class="delivery" aria-hidden="true">/);
  assert.notEqual(paragraph.style.outline, "", "the element stays marked while its chip is up");

  const noteId = note.prompt._lavishNoteId;
  assert.match(noteId, /\S/);
  sdk.sendChromeMessage({ type: "lavish:noteStatus", noteId, status: "sending" });
  assert.match(chip.innerHTML, /<span class="delivery" aria-hidden="true">/);
  assert.equal(chip.getAttribute("aria-label"), "Comment on <p>. Sending");

  sdk.sendChromeMessage({ type: "lavish:noteStatus", noteId, status: "delivered" });
  assert.equal(sdk.shadowChildren("lavish-annotation-chip").length, 0, "a delivered note's chip closes");
  assert.equal(paragraph.style.outline, "", "the element is released with it");
});

test("a delivered note closes only its own chip, not the card the reader moved on to", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));
  const heading = appendTo(sdk.body, cell("h2", "A heading"));

  sdk.click(paragraph);
  const noteId = sdk.queue("Reword this").prompt._lavishNoteId;
  sdk.click(heading);
  sdk.card().querySelector("textarea").value = "still typing";
  sdk.sendChromeMessage({ type: "lavish:noteStatus", noteId, status: "delivered" });

  assert.equal(sdk.card().querySelector("textarea").value, "still typing");
  assert.notEqual(heading.style.outline, "");
});

test("a note added to the queue keeps its chip until it is delivered, then closes it", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  sdk.click(paragraph);
  sdk.card().querySelector("textarea").value = "One of several";
  pressEnter(sdk.card().querySelector("textarea"), { ctrlKey: true });
  const noteId = sdk.posted.findLast((message) => message.type === "lavish:queuePrompt").prompt._lavishNoteId;
  sdk.sendChromeMessage({ type: "lavish:noteStatus", noteId, status: "queued" });
  assert.equal(sdk.shadowChildren("lavish-annotation-chip").length, 1);

  sdk.sendChromeMessage({ type: "lavish:noteStatus", noteId, status: "sending" });
  sdk.sendChromeMessage({ type: "lavish:noteStatus", noteId, status: "delivered" });
  assert.equal(sdk.shadowChildren("lavish-annotation-chip").length, 0);
});

test("a note that falls back to the queue after a failed send says so on its chip", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  sdk.click(paragraph);
  const noteId = sdk.queue("Reword this").prompt._lavishNoteId;
  const chip = sdk.shadowChildren("lavish-annotation-chip").at(-1);
  sdk.sendChromeMessage({ type: "lavish:noteStatus", noteId, status: "sending" });
  sdk.sendChromeMessage({ type: "lavish:noteStatus", noteId, status: "queued" });

  assert.equal(sdk.shadowChildren("lavish-annotation-chip").at(-1), chip, "the chip stays up with the note's words");
  assert.match(chip.innerHTML, /Reword this/);
  assert.match(chip.innerHTML, /<span class="delivery uncertain" aria-hidden="true">/);
  assert.match(
    chip.innerHTML,
    /<p class="comment-trouble lavish-hint-alert">Not sent\. It is still in your notes: Send to Agent tries again\.<\/p>/,
  );
});

test("a note reworded in the Conversation panel says its new words on its chip", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  sdk.click(paragraph);
  const noteId = sdk.queue("Reword this").prompt._lavishNoteId;
  const chip = sdk.shadowChildren("lavish-annotation-chip").at(-1);
  sdk.sendChromeMessage({ type: "lavish:noteText", noteId: "someone-else", text: "Not mine" });
  sdk.sendChromeMessage({ type: "lavish:noteText", noteId, text: "Say <it> better" });

  assert.match(chip.innerHTML, /<strong>&lt;p&gt;<\/strong> Say &lt;it&gt; better<\/p>/);
  assert.doesNotMatch(chip.innerHTML, /Not mine/);
});

test("a chip ignores the status of a note that is not its own", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  sdk.click(paragraph);
  sdk.queue("Reword this");
  const chip = sdk.shadowChildren("lavish-annotation-chip").at(-1);
  sdk.sendChromeMessage({ type: "lavish:noteStatus", noteId: "someone-else", status: "delivered" });

  assert.doesNotMatch(chip.innerHTML, /delivery succeeded/);
});

test("an added note says on its chip that it waits in the notes for a send", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  sdk.click(paragraph);
  sdk.card().querySelector("textarea").value = "One of several";
  pressEnter(sdk.card().querySelector("textarea"));
  const chip = sdk.shadowChildren("lavish-annotation-chip").at(-1);

  assert.equal(
    chip.getAttribute("aria-label"),
    "Comment on <p>. In your notes: Send to Agent or Send & End sends them all",
  );
});

// ---- What is selected in the page, as the chrome's composer attaches its notes ----
// A note written in the Conversation box while an element is selected belongs to that element, so
// the page tells the chrome what is selected: the element of an open card or of a chip.

test("an open card tells the chrome what is selected, and closing it clears the selection", () => {
  const sdk = bootSdk();
  const heading = appendTo(sdk.body, cell("h2", "Pricing"));

  sdk.click(heading);
  const opened = sdk.selection();
  assert.equal(opened.selection.tag, "h2");
  assert.equal(opened.selection.text, "Pricing");
  assert.match(opened.selection.selector, /\S/);
  assert.equal(opened.card, true);

  pressEscape(sdk.card().querySelector("textarea"));
  assert.equal(sdk.selection().selection, null);
  assert.equal(sdk.selection().card, false);
});

test("an added note's chip keeps its element selected until the chip closes", () => {
  const sdk = bootSdk();
  const heading = appendTo(sdk.body, cell("h2", "Pricing"));

  sdk.click(heading);
  const noteId = sdk.queue("Make it bigger").prompt._lavishNoteId;
  assert.equal(sdk.selection().selection.tag, "h2");
  assert.equal(sdk.selection().card, false, "a chip is not a card with words to keep");

  sdk.sendChromeMessage({ type: "lavish:noteStatus", noteId, status: "delivered" });
  assert.equal(sdk.selection().selection, null);
});

test("the chrome can clear the selection, and a card's words are kept for its next card", () => {
  const sdk = bootSdk();
  const heading = appendTo(sdk.body, cell("h2", "Pricing"));

  sdk.click(heading);
  sdk.card().querySelector("textarea").value = "half a thought";
  sdk.sendChromeMessage({ type: "lavish:clearSelection" });

  assert.equal(sdk.cards().length, 0);
  assert.equal(sdk.selection().selection, null);
  sdk.click(heading);
  assert.equal(sdk.card().querySelector("textarea").value, "half a thought");
});

test("a note the chrome added for the selection turns its empty card into that note's chip", () => {
  const sdk = bootSdk();
  const heading = appendTo(sdk.body, cell("h2", "Pricing"));

  sdk.click(heading);
  sdk.sendChromeMessage({ type: "lavish:selectionNoted", noteId: "chrome-note-1", text: "Dictated <words>" });

  assert.equal(sdk.cards().length, 0, "the empty card gave way to the chip");
  const chip = sdk.shadowChildren("lavish-annotation-chip").at(-1);
  assert.match(chip.innerHTML, /<strong>&lt;h2&gt;<\/strong> Dictated &lt;words&gt;/);
  assert.equal(postedTypes(sdk).includes("lavish:queuePrompt"), false, "the chrome already holds the note");

  sdk.sendChromeMessage({ type: "lavish:noteStatus", noteId: "chrome-note-1", status: "delivered" });
  assert.equal(sdk.shadowChildren("lavish-annotation-chip").length, 0);
});

test("a note the chrome added for the selection leaves a card with words of its own alone", () => {
  const sdk = bootSdk();
  const heading = appendTo(sdk.body, cell("h2", "Pricing"));

  sdk.click(heading);
  sdk.card().querySelector("textarea").value = "my own words";
  sdk.sendChromeMessage({ type: "lavish:selectionNoted", noteId: "chrome-note-1", text: "Dictated" });

  assert.equal(sdk.card().querySelector("textarea").value, "my own words");
});

// ---- Send & End takes a card's unfinished words with it ----

test("committing the open card adds its words to the notes, then says it is done", () => {
  const sdk = bootSdk();
  const heading = appendTo(sdk.body, cell("h2", "Pricing"));

  sdk.click(heading);
  sdk.card().querySelector("textarea").value = "  unfinished thought  ";
  const before = sdk.posted.length;
  sdk.sendChromeMessage({ type: "lavish:commitDraft", commit_id: "commit-1" });

  const replies = sdk.posted.slice(before).filter((message) => message.type !== "lavish:selection");
  assert.deepEqual(
    replies.map((message) => message.type),
    ["lavish:queuePrompt", "lavish:draftCommitted"],
  );
  assert.equal(replies[0].prompt.prompt, "unfinished thought");
  assert.equal(replies[0].prompt.tag, "h2");
  assert.equal(replies[0].commit_id, "commit-1");
  assert.equal(replies[1].commit_id, "commit-1");
  assert.equal(replies[1].committed, true);
});

test("committing with no card, or an empty one, adds nothing and still answers", () => {
  for (const openCard of [false, true]) {
    const sdk = bootSdk();
    const heading = appendTo(sdk.body, cell("h2", "Pricing"));
    if (openCard) sdk.click(heading);
    sdk.sendChromeMessage({ type: "lavish:commitDraft", commit_id: "commit-2" });

    assert.equal(postedTypes(sdk).includes("lavish:queuePrompt"), false);
    const reply = sdk.posted.findLast((message) => message.type === "lavish:draftCommitted");
    assert.equal(reply.commit_id, "commit-2");
    assert.equal(reply.committed, true, "nothing to add is not a failure");
  }
});

test("committing a card whose image is still uploading keeps the card and says it could not", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  sdk.click(paragraph);
  const card = sdk.card();
  card.querySelector("textarea").value = "see the picture";
  const attachInput = card.querySelector(".lavish-attach-input");
  attachInput.files = [{ name: "shot.png", type: "image/png", size: 10, arrayBuffer: () => new Promise(() => {}) }];
  attachInput.listeners.find((entry) => entry.type === "change").handler();
  sdk.sendChromeMessage({ type: "lavish:commitDraft", commit_id: "commit-3" });

  assert.equal(postedTypes(sdk).includes("lavish:queuePrompt"), false);
  assert.equal(sdk.posted.findLast((message) => message.type === "lavish:draftCommitted").committed, false);
  assert.equal(sdk.cards().length, 1, "his words and the upload stay on the card");
});

// The pin is the board's comment mark: it sits on the corner of whatever a click would annotate.
test("the pin marks the hovered element and stays on the one being annotated", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  sdk.hover(paragraph);
  const pin = sdk.shadowChildren("lavish-pin").at(-1);
  assert.ok(pin, "hovering shows the pin");
  assert.match(pin.className, /comment-mark/);
  // The stub element sits at left 10, top 10; the mark stays inside the viewport.
  assert.equal(pin.style.left, "2px");
  assert.equal(pin.style.top, "11px");
  assert.equal(pin.hidden, false);

  sdk.click(paragraph);
  assert.equal(pin.hidden, false, "the annotated element keeps its pin");

  pressEscape(sdk.card().querySelector("textarea"));
  assert.equal(pin.hidden, true, "a cancelled card takes its pin with it");
});

test("Escape leaves an annotation card with an in-flight attachment open, even with no text", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  sdk.click(paragraph);
  const card = sdk.card();
  const attachInput = card.querySelector(".lavish-attach-input");
  // Never resolves - only the synchronous "uploading" status addFiles sets is needed here.
  attachInput.files = [{ name: "shot.png", type: "image/png", size: 10, arrayBuffer: () => new Promise(() => {}) }];
  const changeListener = attachInput.listeners.find((entry) => entry.type === "change");
  assert.ok(changeListener, "the attach input registers a change listener");
  changeListener.handler();

  pressEscape(card.querySelector("textarea"));

  assert.notEqual(
    paragraph.style.outline,
    "",
    "an attachment mid-upload is unsent content, so Escape must not close the card",
  );
});

// The chrome cannot see into this document, so a draft whose anchor is gone is only ever retired
// if the SDK says so. Silence left it to be retried against every later load.
test("the served SDK bundle reports a draft whose anchor the artifact no longer has", () => {
  const sdk = bootSdk();

  sdk.sendChromeMessage({
    type: "lavish:restoreReviewState",
    state: { card: { selector: "#hero", text: "needs a shorter headline" }, fields: [] },
  });

  // The load event proves the document parsed, not that it finished rendering, so nothing is
  // reported until the anchor has had time to appear.
  assert.equal(
    sdk.posted.some((message) => message.type === "lavish:reviewDraftUnrestorable"),
    false,
  );

  sdk.runTimers();
  const report = sdk.posted.at(-1);
  assert.equal(report.type, "lavish:reviewDraftUnrestorable");
  assert.equal(report.selector, "#hero");
  assert.equal(report.artifact_load_token, "load-token");
});

// A section this page builds in script, or a Mermaid diagram, is not in the document when it
// loads. Reporting that as a missing anchor is how a live draft gets thrown away.
test("the served SDK bundle restores a draft whose anchor arrives after the load", () => {
  const sdk = bootSdk();
  let late = null;
  sdk.setDocumentQuery((selector) => (selector === "#hero" ? late : null));

  sdk.sendChromeMessage({
    type: "lavish:restoreReviewState",
    state: { card: { selector: "#hero", text: "needs a shorter headline" }, fields: [] },
  });
  late = appendTo(sdk.body, cell("h1", "Headline"));
  sdk.runTimers();

  assert.equal(
    sdk.posted.some((message) => message.type === "lavish:reviewDraftUnrestorable"),
    false,
    "an anchor that arrived late is restored, not reported gone",
  );
  assert.equal(sdk.card().querySelector("textarea").value, "needs a shorter headline");
});

test("the served SDK bundle reports nothing when there is no draft to restore", () => {
  const sdk = bootSdk();
  const before = sdk.posted.length;

  sdk.sendChromeMessage({ type: "lavish:restoreReviewState", state: { card: null, fields: [] } });
  sdk.sendChromeMessage({ type: "lavish:restoreReviewState", state: { card: { selector: "#hero", text: "  " } } });
  sdk.runTimers();

  assert.equal(sdk.posted.length, before);
});

// `showAnnotationCard` closes whatever card is open before it draws, so a late restore landing on
// a card the user opened inside the settle window would delete text they are still typing - text
// no report has carried to the chrome yet.
test("the served SDK bundle leaves a card the user opened alone when the anchor arrives late", () => {
  const sdk = bootSdk();
  let late = null;
  sdk.setDocumentQuery((selector) => (selector === "#hero" ? late : null));

  sdk.sendChromeMessage({
    type: "lavish:restoreReviewState",
    state: { card: { selector: "#hero", text: "needs a shorter headline" }, fields: [] },
  });

  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));
  sdk.click(paragraph);
  sdk.card().querySelector("textarea").value = "typing something new";
  late = appendTo(sdk.body, cell("h1", "Headline"));
  sdk.runTimers();

  assert.equal(sdk.card().querySelector("textarea").value, "typing something new");
  // The draft is still stored on the chrome side, so a later load can try again; nothing here
  // claims the anchor is gone either.
  assert.equal(
    sdk.posted.some((message) => message.type === "lavish:reviewDraftUnrestorable"),
    false,
  );
});

// Cancelling a card reports `card: null`, which is what retires the stored draft on the chrome
// side. A late restore firing after that cancel would draw text the chrome no longer holds and
// report it back as a live draft, so the card the user dismissed reappears with someone else's
// text in it.
test("the served SDK bundle drops a late restore once the user has opened a card of their own", () => {
  const sdk = bootSdk();
  let late = null;
  sdk.setDocumentQuery((selector) => (selector === "#hero" ? late : null));

  sdk.sendChromeMessage({
    type: "lavish:restoreReviewState",
    state: { card: { selector: "#hero", text: "needs a shorter headline" }, fields: [] },
  });

  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));
  sdk.click(paragraph);
  sdk.card().querySelector(".lavish-cancel").onclick();
  const cardsAfterCancel = sdk.cards().length;

  late = appendTo(sdk.body, cell("h1", "Headline"));
  sdk.runTimers();

  assert.equal(cardsAfterCancel, 0, "cancelling takes the card off the page");
  assert.equal(sdk.cards().length, 0, "the cancelled card is not replaced by a restored one");
  assert.equal(
    sdk.posted.some((message) => message.type === "lavish:reviewDraftUnrestorable"),
    false,
  );
});

// ---- The choices a page declares are drawn as the board's question card ----
// A page asks for a pick by declaring it as data. Scrawl draws the radio list where the
// declaration sits, and the pick goes back as an ordinary prompt whose text is the option exactly
// as the page wrote it.

const PLAN_QUESTION = {
  id: "plan",
  question: "Which plan?",
  asker: "cg-scrawl-look",
  options: ["Keep 300 s", "Fix it next", "Drop <it>"],
  recommended: "Fix it next",
};

function fire(form, type, event = {}) {
  const handlers = form.listeners.filter((entry) => entry.type === type);
  assert.ok(handlers.length > 0, `the question card listens for ${type}`);
  for (const entry of handlers) entry.handler({ preventDefault() {}, ...event });
}
const pick = (form, value) => fire(form, "change", { target: { name: "answer", value, checked: true } });
const write = (form, value) => fire(form, "input", { target: { name: "written", value } });
const promptMessages = (sdk) => sdk.posted.filter((message) => /Prompt/.test(message.type));

test("a page's declared choices are drawn after the declaration as the board's radio list", () => {
  const sdk = bootSdk({ choices: PLAN_QUESTION });

  assert.equal(sdk.choicesHostIndex(), sdk.choicesScriptIndex() + 1, "the card sits where the declaration is");
  const [form] = sdk.choiceForms();
  assert.ok(form, "one question, one card");
  assert.equal(form.className, "question-card");

  const html = form.innerHTML;
  assert.match(
    html,
    /<p class="asker"><span class="goblin-avatar" aria-hidden="true"><\/span><span><strong>cg-scrawl-look<\/strong> asks<\/span><\/p>/,
  );
  assert.match(html, /<div class="question-body">Which plan\?<\/div>/);
  // The recommended option is first and marked; the rest keep the page's order; Other is last.
  const order = [...html.matchAll(/<input type="radio" name="answer" value="([^"]*)"/g)].map((match) => match[1]);
  assert.deepEqual(order, ["option:Fix it next", "option:Keep 300 s", "option:Drop &lt;it&gt;", "other"]);
  assert.match(html, /<span>Fix it next<\/span><span class="recommendation">Recommended<\/span>/);
  assert.equal(html.split('class="recommendation"').length - 1, 1);
  assert.match(html, /<span>Other<\/span><small>Write your own answer\.<\/small>/);
  assert.match(html, /<button class="primary send-decision" type="submit" disabled>/);
});

test("a pick is sent as the exact option text, once", () => {
  const sdk = bootSdk({ choices: PLAN_QUESTION });
  const [form] = sdk.choiceForms();

  pick(form, "option:Keep 300 s");
  fire(form, "submit");

  const messages = promptMessages(sdk);
  assert.deepEqual(
    messages.map((message) => message.type),
    ["lavish:queuePrompt", "lavish:sendQueuedPrompts"],
  );
  assert.equal(messages[1].endSession, undefined);
  const { prompt } = messages[0];
  assert.equal(prompt.prompt, "Keep 300 s", "the prompt is the option and nothing else");
  assert.equal(prompt.tag, "choice");
  assert.equal(prompt.text, "Which plan?");
  assert.equal(prompt._lavishQueueKey, "choice:plan");
  assert.match(prompt._lavishNoteId, /\S/);

  // The card closes on what was chosen, as the board's does: no radios to choose again.
  assert.doesNotMatch(form.innerHTML, /type="radio"/);
  assert.match(
    form.innerHTML,
    /<label class="question-choice chosen"><span class="choice-mark">.*<\/span><span class="question-option"><span>Keep 300 s<\/span>/,
  );
  assert.match(
    form.innerHTML,
    /<label class="question-choice dimmed"><span class="choice-mark"><\/span><span class="question-option"><span>Fix it next<\/span>/,
  );

  fire(form, "submit");
  assert.equal(promptMessages(sdk).length, 2, "a second submit sends nothing");
});

// A pick is one of his notes: it joins the page's notes at once, so Send & End in the
// Conversation panel carries it with everything else, and a new pick on the same question takes
// its place. Nothing is sent until a Send.
test("a pick joins the notes at once, a new pick replaces it, and nothing is sent", () => {
  const sdk = bootSdk({ choices: PLAN_QUESTION });
  const [form] = sdk.choiceForms();

  assert.match(form.innerHTML, /class="primary send-decision"[^>]*disabled>.*Send<\/button>/);
  assert.match(form.innerHTML, /class="end-decision"[^>]*disabled>.*End<\/button>/);
  assert.match(form.innerHTML, /class="card-actions"><button class="primary send-decision"/);
  pick(form, "option:Keep 300 s");
  pick(form, "option:Fix it next");

  const messages = promptMessages(sdk);
  assert.deepEqual(
    messages.map((message) => message.type),
    ["lavish:queuePrompt", "lavish:queuePrompt"],
  );
  assert.deepEqual(
    messages.map((message) => message.prompt.prompt),
    ["Keep 300 s", "Fix it next"],
  );
  assert.equal(messages[1].prompt._lavishQueueKey, "choice:plan", "the same question replaces its earlier pick");
  assert.equal(messages[1].prompt._lavishNoteId, messages[0].prompt._lavishNoteId);
  assert.equal(form.querySelector(".send-decision").disabled, false);
  assert.equal(form.querySelector(".end-decision").disabled, false);
  assert.equal(form.querySelector(".question-pending").hidden, false, "the card says its answer is in the notes");
  assert.match(form.innerHTML, /<p class="question-pending[^>]*>.*In your notes: Send or End sends them all<\/p>/);
  assert.match(form.innerHTML, /type="radio"/, "the question stays open to another pick");
});

test("switching to an empty Other takes the earlier pick out of the notes", () => {
  const sdk = bootSdk({ choices: PLAN_QUESTION });
  const [form] = sdk.choiceForms();

  pick(form, "option:Keep 300 s");
  pick(form, "other");
  const dropped = sdk.posted.at(-1);
  assert.equal(dropped.type, "lavish:dropQueuedPrompt");
  assert.equal(dropped.queueKey, "choice:plan");
  assert.equal(form.querySelector(".question-pending").hidden, true);

  write(form, "Something else");
  assert.equal(promptMessages(sdk).at(-1).prompt.prompt, "Something else");
  write(form, "   ");
  assert.equal(sdk.posted.at(-1).type, "lavish:dropQueuedPrompt");
});

test("an answer sent from the Conversation panel closes its card on what was chosen", () => {
  const sdk = bootSdk({ choices: PLAN_QUESTION });
  const [form] = sdk.choiceForms();
  pick(form, "option:Fix it next");
  const noteId = promptMessages(sdk)[0].prompt._lavishNoteId;

  sdk.sendChromeMessage({ type: "lavish:noteStatus", noteId, status: "sending" });
  assert.doesNotMatch(form.innerHTML, /type="radio"/);
  assert.match(form.innerHTML, /<label class="question-choice chosen">.*<span>Fix it next<\/span>/);

  sdk.sendChromeMessage({ type: "lavish:noteStatus", noteId, status: "delivered" });
  assert.match(form.innerHTML, /<p class="question-outcome delivery succeeded" role="status">.*Delivered<\/p>/);
});

test("a pick taken out of the notes in the Conversation panel opens its question again", () => {
  const sdk = bootSdk({ choices: PLAN_QUESTION });
  const [form] = sdk.choiceForms();
  pick(form, "option:Fix it next");
  const noteId = promptMessages(sdk)[0].prompt._lavishNoteId;

  sdk.sendChromeMessage({ type: "lavish:noteStatus", noteId, status: "removed" });

  assert.doesNotMatch(form.innerHTML, / checked>/, "no option is picked any more");
  assert.match(form.innerHTML, /class="primary send-decision"[^>]*disabled>/);
});

test("choice End sends the selected answer with an atomic end intent exactly once", () => {
  const sdk = bootSdk({ choices: PLAN_QUESTION });
  const [form] = sdk.choiceForms();
  pick(form, "other");
  write(form, "  Revise the plan  ");

  fire(form, "submit", { submitter: form.querySelector(".end-decision") });
  fire(form, "submit", { submitter: form.querySelector(".end-decision") });

  assert.equal(promptMessages(sdk).length, 2);
  assert.equal(promptMessages(sdk)[0].prompt.prompt, "Revise the plan");
  assert.equal(promptMessages(sdk)[1].endSession, true);
  assert.equal(
    sdk.posted.some((message) => message.type === "lavish:endSession"),
    false,
  );
});

test("Other sends the written answer, and only once something is written", () => {
  const sdk = bootSdk({ choices: PLAN_QUESTION });
  const [form] = sdk.choiceForms();

  pick(form, "other");
  fire(form, "submit");
  assert.deepEqual(promptMessages(sdk), [], "an empty Other is not an answer");

  write(form, "  Park it until the freeze lifts  ");
  fire(form, "submit");

  assert.equal(promptMessages(sdk)[0].prompt.prompt, "Park it until the freeze lifts");
  assert.match(
    form.innerHTML,
    /<label class="question-choice chosen">.*<span>Other<\/span><small>Park it until the freeze lifts<\/small>/,
  );
});

test("nothing is sent without a pick, or for an option the page never offered", () => {
  const sdk = bootSdk({ choices: PLAN_QUESTION });
  const [form] = sdk.choiceForms();

  fire(form, "submit");
  pick(form, "option:Something else");
  fire(form, "submit");

  assert.deepEqual(promptMessages(sdk), []);
});

test("each declared question is its own card with its own answer", () => {
  const sdk = bootSdk({
    choices: [PLAN_QUESTION, { id: "when", question: "When?", options: ["Now", "After the freeze"] }],
  });
  const [plan, when] = sdk.choiceForms();

  pick(when, "option:Now");
  fire(when, "submit");

  const [message] = promptMessages(sdk);
  assert.equal(message.prompt.prompt, "Now");
  assert.equal(message.prompt.text, "When?");
  assert.equal(message.prompt._lavishQueueKey, "choice:when");
  assert.match(plan.innerHTML, /type="radio"/, "the other question is still open");
  // No asker named: the page asks.
  assert.match(when.innerHTML, /<strong>This page<\/strong> asks/);
});

test("the answered card follows its answer's delivery, and reopens if the answer is taken back", () => {
  const sdk = bootSdk({ choices: PLAN_QUESTION });
  const [form] = sdk.choiceForms();
  pick(form, "option:Fix it next");
  fire(form, "submit");
  const noteId = promptMessages(sdk)[0].prompt._lavishNoteId;
  assert.match(form.innerHTML, /<p class="question-outcome delivery" role="status">.*Sending<\/p>/);

  sdk.sendChromeMessage({ type: "lavish:noteStatus", noteId, status: "sending" });
  sdk.sendChromeMessage({ type: "lavish:noteStatus", noteId, status: "delivered" });
  assert.match(form.innerHTML, /<p class="question-outcome delivery succeeded" role="status">.*Delivered<\/p>/);

  // Removed from the queue in the conversation panel before it went: the question is open again.
  const again = bootSdk({ choices: PLAN_QUESTION });
  const [open] = again.choiceForms();
  pick(open, "option:Fix it next");
  fire(open, "submit");
  again.sendChromeMessage({
    type: "lavish:noteStatus",
    noteId: promptMessages(again)[0].prompt._lavishNoteId,
    status: "removed",
  });
  assert.match(open.innerHTML, /type="radio"/);
});

test("a pick survives a reload of the page: its state is reported and restored", () => {
  const sdk = bootSdk({ choices: PLAN_QUESTION });
  const [form] = sdk.choiceForms();
  pick(form, "option:Keep 300 s");
  const noteId = promptMessages(sdk)[0].prompt._lavishNoteId;
  sdk.runTimers();
  const report = sdk.posted.findLast((message) => message.type === "lavish:reviewState");
  // Compared as JSON: the report was built inside the SDK's own realm.
  assert.equal(
    JSON.stringify(report.state.choices),
    JSON.stringify([{ id: "plan", selection: "option:Keep 300 s", written: "", answered: "", noteId }]),
  );

  // The pick is still in the notes after a reload, so its card says so and follows that note.
  const pending = bootSdk({ choices: PLAN_QUESTION });
  const [stillOpen] = pending.choiceForms();
  pending.sendChromeMessage({
    type: "lavish:restoreReviewState",
    state: { card: null, fields: [], choices: [{ id: "plan", selection: "option:Keep 300 s", written: "", noteId }] },
  });
  assert.match(stillOpen.innerHTML, /value="option:Keep 300 s" checked>/);
  assert.equal(stillOpen.querySelector(".question-pending").hidden, false);
  pending.sendChromeMessage({ type: "lavish:noteStatus", noteId, status: "sending" });
  assert.doesNotMatch(stillOpen.innerHTML, /type="radio"/, "the restored pick follows its note");
  assert.deepEqual(promptMessages(pending), [], "restoring adds nothing to the notes");

  const reloaded = bootSdk({ choices: PLAN_QUESTION });
  const [restored] = reloaded.choiceForms();
  reloaded.sendChromeMessage({
    type: "lavish:restoreReviewState",
    state: {
      card: null,
      fields: [],
      choices: [{ id: "plan", selection: "other", written: "x", answered: "Fix it next" }],
    },
  });
  assert.doesNotMatch(restored.innerHTML, /type="radio"/, "an answered question stays answered");
  assert.match(restored.innerHTML, /<label class="question-choice chosen">.*<span>Fix it next<\/span>/);
  assert.match(restored.innerHTML, /<p class="question-outcome delivery" role="status">.*Sent<\/p>/);
  // Nothing is sent again by restoring.
  assert.deepEqual(promptMessages(reloaded), []);
});

test("a page with no declaration, or a malformed one, gets no card", () => {
  assert.equal(bootSdk().choicesHostIndex(), -1);
  assert.equal(bootSdk({ choices: "not json" }).choicesHostIndex(), -1);
  assert.equal(bootSdk({ choices: { id: "q", question: "Pick", options: ["only one"] } }).choicesHostIndex(), -1);
});
