import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

class FixtureElement extends EventTarget {
  constructor(tagName = "div") {
    super();
    this.tagName = tagName;
    this.parentNode = null;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.className = "";
    this.textContent = "";
    this.isFocusVisible = false;
    this.box = { left: 100, top: 100, width: 100, height: 30 };
    this.style = { left: "", top: "", setProperty: (name, value) => this.attributes.set(name, value) };
  }

  get parentElement() {
    return this.parentNode instanceof FixtureElement ? this.parentNode : null;
  }

  get isConnected() {
    return this.tagName === "document" || this.tagName === "shadow" || !!this.parentNode?.isConnected;
  }

  append(child) {
    child.remove();
    child.parentNode = this;
    this.children.push(child);
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
      this.parentNode = null;
    }
  }

  contains(child) {
    return child === this || this.children.some((node) => node.contains(child));
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  matches(selector) {
    if (selector === ":focus-visible") return this.isFocusVisible;
    if (selector === "[data-tip]") return this.attributes.has("data-tip");
    if (selector === "dialog[open]") return this.tagName === "dialog" && this.attributes.has("open");
    return false;
  }

  closest(selector) {
    return this.matches(selector) ? this : (this.parentElement?.closest(selector) ?? null);
  }

  getBoundingClientRect() {
    return { ...this.box, right: this.box.left + this.box.width, bottom: this.box.top + this.box.height };
  }
}

function fixture({ isShadow = false, width = 400, height = 300 } = {}) {
  const document = new FixtureElement("document");
  const body = new FixtureElement("body");
  document.append(body);
  const root = isShadow ? new FixtureElement("shadow") : document;
  const view = new EventTarget();
  const frames = new Map();
  const mutations = new Set();
  const sizes = new Set();
  const animations = [];
  const listeners = [];
  let frameId = 0;
  for (const surface of [root, view]) {
    surface.addEventListener = (type, callback, options) => {
      listeners.push({ surface, type, callback });
      EventTarget.prototype.addEventListener.call(surface, type, callback, options);
    };
    surface.removeEventListener = (type, callback, options) => {
      const index = listeners.findIndex(
        (entry) => entry.surface === surface && entry.type === type && entry.callback === callback,
      );
      if (index !== -1) listeners.splice(index, 1);
      EventTarget.prototype.removeEventListener.call(surface, type, callback, options);
    };
  }
  function KeyframeEffect(target, pseudoElement = null) {
    this.target = target;
    this.pseudoElement = pseudoElement;
  }
  const browserDocument = Object.assign(document, {
    body,
    documentElement: { clientWidth: width, clientHeight: height },
    defaultView: view,
    createElement: (name) => new FixtureElement(name),
    getAnimations: () => animations,
  });
  Object.assign(root, { ownerDocument: browserDocument });
  function MutationObserver(callback) {
    const observer = {
      callback,
      target: null,
      observe(target) {
        this.target = target;
        mutations.add(this);
      },
      disconnect() {
        this.target = null;
        mutations.delete(this);
      },
    };
    return observer;
  }
  function ResizeObserver(callback) {
    const observer = {
      callback,
      targets: new Set(),
      observe(target) {
        this.targets.add(target);
        sizes.add(this);
      },
      disconnect() {
        this.targets.clear();
        sizes.delete(this);
      },
    };
    return observer;
  }
  const sourceUrl = new URL("../src/board-tips.js", import.meta.url);
  const source = readFileSync(sourceUrl, "utf8");
  const context = vm.createContext({
    document: browserDocument,
    window: view,
    Element: FixtureElement,
    HTMLElement: FixtureElement,
    KeyframeEffect,
    MutationObserver,
    ResizeObserver,
    requestAnimationFrame: (callback) => {
      frames.set(++frameId, callback);
      return frameId;
    },
    cancelAnimationFrame: (id) => frames.delete(id),
  });
  // Evaluate the function alone, just as the SDK serializer will do.
  const watch = vm.runInContext(`(${source.replace("export ", "")})`, context, { filename: sourceUrl.href });
  const stop = isShadow ? watch(root) : watch();
  function emit(type, target, fields = {}) {
    const event = new Event(type);
    Object.defineProperties(event, {
      target: { value: target },
      ...Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, { value }])),
    });
    root.dispatchEvent(event);
  }
  return {
    root,
    body,
    view,
    frames,
    mutations,
    sizes,
    animations,
    listeners,
    stop,
    emit,
    anchor(text = "A useful tip", parent = isShadow ? root : body) {
      const anchor = new FixtureElement("button");
      anchor.setAttribute("data-tip", text);
      parent.append(anchor);
      return anchor;
    },
    tip() {
      const find = (node) => (node.className === "tip" ? node : node.children.map(find).find(Boolean));
      return find(root) ?? null;
    },
    change(target) {
      for (const observer of [...mutations]) observer.callback([{ target }]);
    },
    resize(target = null) {
      for (const observer of [...sizes]) {
        if (!target || observer.targets.has(target)) observer.callback([]);
      }
    },
    animate(target, pseudoElement = null) {
      const animation = { pending: false, playState: "running", effect: new KeyframeEffect(target, pseudoElement) };
      animations.push(animation);
      return animation;
    },
    frame() {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback();
    },
    flushFrames(limit = 8) {
      for (let count = 0; frames.size && count < limit; count++) {
        const pending = [...frames.values()];
        frames.clear();
        for (const callback of pending) callback();
      }
      assert.equal(frames.size, 0, "a stationary tooltip must stop requesting frames");
    },
  };
}

test("board tips appear for a pointer over a descendant and render text safely", (t) => {
  const page = fixture();
  t.after(page.stop);
  const anchor = page.anchor('<img src=x onerror="alert(1)">');
  const child = new FixtureElement("span");
  anchor.append(child);

  page.emit("pointerover", child, { buttons: 0, pointerType: "mouse" });

  assert.equal(page.tip()?.textContent, '<img src=x onerror="alert(1)">');
  assert.equal(page.tip()?.getAttribute("role"), "tooltip");
  assert.equal(page.tip()?.children.length, 0);
  assert.equal(page.tip()?.parentNode, page.body);
  page.flushFrames();
});

test("board tips show only keyboard focus-visible focus", (t) => {
  const page = fixture();
  t.after(page.stop);
  const anchor = page.anchor();

  page.emit("focusin", anchor);
  assert.equal(page.tip(), null);
  anchor.isFocusVisible = true;
  page.emit("focusin", anchor);

  assert.equal(page.tip()?.textContent, "A useful tip");
  page.emit("focusout", anchor);
  assert.equal(page.tip(), null);
  page.flushFrames();
});

test("board tips read live text and remove and restore empty tips", (t) => {
  const page = fixture();
  t.after(page.stop);
  const anchor = page.anchor();
  page.emit("pointerover", anchor);

  anchor.setAttribute("data-tip", "Changed text");
  page.change(anchor);
  assert.equal(page.tip()?.textContent, "Changed text");
  anchor.setAttribute("data-tip", "");
  page.change(anchor);
  assert.equal(page.tip(), null);
  anchor.setAttribute("data-tip", "Restored text");
  page.change(anchor);

  assert.equal(page.tip()?.textContent, "Restored text");
  page.flushFrames();
});

for (const isShadow of [false, true]) {
  test(`board tips stay in their ${isShadow ? "shadow" : "document"} root and active dialog`, (t) => {
    const page = fixture({ isShadow });
    t.after(page.stop);
    const anchor = page.anchor();
    page.emit("pointerover", anchor);
    assert.equal(page.tip()?.parentNode, isShadow ? page.root : page.body);
    const dialog = new FixtureElement("dialog");
    dialog.setAttribute("open", "");
    (isShadow ? page.root : page.body).append(dialog);

    dialog.append(anchor);
    page.change(dialog);

    assert.equal(page.tip()?.parentNode, dialog);
    page.flushFrames();
  });
}

for (const { box, side, left, top, arrow } of [
  { box: { left: 1, top: 1, width: 20, height: 20 }, side: "below", left: "8px", top: "29px", arrow: "14px" },
  { box: { left: 380, top: 270, width: 20, height: 20 }, side: "above", left: "292px", top: "232px", arrow: "86px" },
  { box: { left: 10, top: 8, width: 20, height: 284 }, side: "right", left: "38px", top: "135px", arrow: "15px" },
  { box: { left: 370, top: 8, width: 20, height: 284 }, side: "left", left: "262px", top: "135px", arrow: "15px" },
  { box: { left: 8, top: 8, width: 384, height: 284 }, side: "below", left: "150px", top: "262px", arrow: "50px" },
]) {
  test(`board tips fit viewport edges using ${side} at ${box.left},${box.top}`, (t) => {
    const page = fixture();
    t.after(page.stop);
    const anchor = page.anchor();
    anchor.box = box;

    page.emit("pointerover", anchor);

    assert.equal(page.tip()?.dataset.side, side);
    assert.equal(page.tip()?.style.left, left);
    assert.equal(page.tip()?.style.top, top);
    assert.equal(page.tip()?.getAttribute("--arrow"), arrow);
    page.flushFrames();
  });
}

test("board tips follow moved anchors on scroll, resize, and page changes", (t) => {
  const page = fixture({ isShadow: true });
  t.after(page.stop);
  const anchor = page.anchor();
  page.emit("pointerover", anchor);
  page.flushFrames();

  anchor.box.left = 200;
  page.view.dispatchEvent(new Event("scroll"));
  assert.equal(page.tip()?.style.left, "200px");
  anchor.box.left = 150;
  page.emit("scroll", anchor);
  assert.equal(page.tip()?.style.left, "150px");
  anchor.box.top = 200;
  page.view.dispatchEvent(new Event("resize"));
  assert.equal(page.tip()?.style.top, "162px");
  anchor.box.top = 150;
  page.change(anchor);
  assert.equal(page.tip()?.style.top, "112px");
  page.tip().box.height = 60;
  page.resize();
  assert.equal(page.tip()?.style.top, "82px");
  page.flushFrames();
});

test("board tips settle after movement and ignore their own mutation records", (t) => {
  const page = fixture();
  t.after(page.stop);
  const anchor = page.anchor();
  page.emit("pointerover", anchor);
  anchor.box.left = 200;

  page.flushFrames();

  assert.equal(page.tip()?.style.left, "200px");
  page.change(page.tip());
  assert.equal(page.frames.size, 0);
});

test("board tips at rest ignore size changes of earlier anchors", (t) => {
  const page = fixture();
  t.after(page.stop);
  const first = page.anchor("First");
  const second = page.anchor("Second");
  page.emit("pointerover", first);
  page.flushFrames();
  page.emit("pointerover", second);
  page.flushFrames();

  first.box.height = 60;
  page.resize(first);

  assert.equal(page.tip()?.textContent, "Second");
  assert.equal(page.frames.size, 0);
});

test("board tips follow an animated ancestor then stop when it settles", (t) => {
  const page = fixture();
  t.after(page.stop);
  const anchor = page.anchor();
  const animation = page.animate(page.body);
  page.emit("pointerover", anchor);

  page.frame();
  assert.equal(page.frames.size, 1);
  anchor.box.left = 200;
  page.frame();
  assert.equal(page.tip()?.style.left, "200px");
  animation.playState = "finished";

  page.flushFrames();
});

test("board tips ignore unrelated and pseudo-element animations", (t) => {
  const page = fixture();
  t.after(page.stop);
  const anchor = page.anchor();
  page.animate(page.anchor());
  page.animate(anchor, "::before");

  page.emit("pointerover", anchor);

  assert.ok(page.tip());
  page.flushFrames();
});

for (const { type, fields } of [
  { type: "keydown", fields: { key: "Escape" } },
  { type: "pointerdown", fields: { buttons: 1, pointerType: "mouse" } },
  { type: "pointerdown", fields: { buttons: 1, pointerType: "pen" } },
  { type: "pointerout", fields: { relatedTarget: null } },
  { type: "pointerup", fields: { buttons: 0, pointerType: "touch" } },
  { type: "pointercancel", fields: { pointerType: "touch" } },
]) {
  test(`board tips dismiss on ${type} ${fields.pointerType ?? fields.key ?? "leaving"}`, (t) => {
    const page = fixture();
    t.after(page.stop);
    const anchor = page.anchor();
    page.emit("pointerover", anchor);
    assert.ok(page.tip());

    page.emit(type, anchor, fields);

    assert.equal(page.tip(), null);
    page.flushFrames();
    page.change(anchor);
    assert.equal(page.tip(), null);
  });
}

test("board tips show a held touch and return after releasing a mouse press", (t) => {
  const page = fixture();
  t.after(page.stop);
  const anchor = page.anchor();

  page.emit("pointerdown", anchor, { buttons: 1, pointerType: "touch" });
  assert.ok(page.tip());
  page.emit("pointerdown", anchor, { buttons: 1, pointerType: "mouse" });
  assert.equal(page.tip(), null);
  page.emit("pointerup", anchor, { buttons: 0, pointerType: "mouse" });
  assert.ok(page.tip());
  page.flushFrames();
});

test("board tips stay dismissed until every mouse button is released", (t) => {
  const page = fixture();
  t.after(page.stop);
  const anchor = page.anchor();
  page.emit("pointerover", anchor);
  page.emit("pointerdown", anchor, { buttons: 3, pointerType: "mouse" });
  assert.equal(page.tip(), null);

  page.emit("pointerup", anchor, { buttons: 1, pointerType: "mouse" });

  assert.equal(page.tip(), null);
  page.emit("pointerup", anchor, { buttons: 0, pointerType: "mouse" });
  assert.ok(page.tip());
  page.flushFrames();
});

test("board tips dismiss anchors removed or moved outside the watched root", (t) => {
  const page = fixture({ isShadow: true });
  t.after(page.stop);
  const anchor = page.anchor();
  page.emit("pointerover", anchor);
  assert.ok(page.tip());

  page.body.append(anchor);
  page.change(page.root);

  assert.equal(page.tip(), null);
  const removed = page.anchor();
  page.emit("pointerover", removed);
  assert.ok(page.tip());
  removed.remove();
  page.change(page.root);
  assert.equal(page.tip(), null);
  page.flushFrames();
});

test("board tips clear all observers, listeners, and pending frames on cleanup", () => {
  const page = fixture();
  const anchor = page.anchor();
  page.emit("pointerover", anchor);
  assert.ok(page.frames.size > 0);

  page.stop();

  assert.equal(page.tip(), null);
  assert.equal(page.frames.size, 0);
  assert.equal(page.mutations.size, 0);
  assert.equal(page.sizes.size, 0);
  assert.equal(page.listeners.length, 0);
  page.emit("pointerover", anchor);
  anchor.isFocusVisible = true;
  page.emit("focusin", anchor);
  page.view.dispatchEvent(new Event("resize"));
  page.view.dispatchEvent(new Event("scroll"));
  assert.equal(page.tip(), null);
  assert.equal(page.frames.size, 0);
});
