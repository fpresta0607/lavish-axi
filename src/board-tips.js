/* global document, Element, HTMLElement, KeyframeEffect, MutationObserver, ResizeObserver, requestAnimationFrame, cancelAnimationFrame */

/** @param {Document | ShadowRoot} [root] */
export function watchBoardTips(root = document) {
  const GAP = 8;
  const ARROW_INSET = 14;
  const ownerDocument = "body" in root ? root : root.ownerDocument;
  const host = "body" in root ? root.body : root;
  const view = ownerDocument.defaultView;
  /** @type {HTMLElement | null} */
  let anchor = null;
  /** @type {HTMLDivElement | null} */
  let tooltip = null;
  let frame = 0;
  let previousBox = "";

  /** @param {HTMLElement} part */
  const isMoving = (part) =>
    ownerDocument
      .getAnimations()
      .some(
        ({ pending, playState, effect }) =>
          (pending || playState === "running") &&
          effect instanceof KeyframeEffect &&
          !effect.pseudoElement &&
          (effect.target?.contains(part) || ("host" in root && effect.target?.contains(root.host))),
      );

  /** @param {HTMLDivElement} node @param {HTMLElement} part */
  const place = (node, part) => {
    const box = part.getBoundingClientRect();
    const own = node.getBoundingClientRect();
    const { clientWidth: width, clientHeight: height } = ownerDocument.documentElement;
    const centered = (start, length, size, room) =>
      Math.max(GAP, Math.min(start + length / 2 - size / 2, room - GAP - size));
    const left = centered(box.left, box.width, own.width, width);
    const top = centered(box.top, box.height, own.height, height);
    const spots = [
      { side: "above", left, top: box.top - GAP - own.height },
      { side: "below", left, top: box.bottom + GAP },
      { side: "right", left: box.right + GAP, top },
      { side: "left", left: box.left - GAP - own.width, top },
    ];
    const spot =
      spots.find(
        ({ left, top }) =>
          left >= GAP && top >= GAP && left + own.width <= width - GAP && top + own.height <= height - GAP,
      ) ?? spots[1];
    const boundedTop = Math.max(GAP, Math.min(spot.top, height - GAP - own.height));
    const isAcross = spot.side === "above" || spot.side === "below";
    const arrow = isAcross ? box.left + box.width / 2 - spot.left : box.top + box.height / 2 - boundedTop;
    if (node.dataset.side !== spot.side) node.dataset.side = spot.side;
    node.style.setProperty(
      "--arrow",
      Math.max(ARROW_INSET, Math.min(arrow, (isAcross ? own.width : own.height) - ARROW_INSET)) + "px",
    );
    node.style.left = spot.left + "px";
    node.style.top = boundedTop + "px";
    return [box.left, box.top, box.width, box.height].join();
  };

  const draw = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    if (anchor && (!anchor.isConnected || !root.contains(anchor))) return point(null);
    const text = anchor?.getAttribute("aria-expanded") === "true" ? null : anchor?.getAttribute("data-tip");
    if (!anchor || !text) {
      sizes.disconnect();
      tooltip?.remove();
      tooltip = null;
      return;
    }
    if (!tooltip) {
      tooltip = ownerDocument.createElement("div");
      tooltip.className = "tip";
      tooltip.setAttribute("role", "tooltip");
      sizes.observe(tooltip);
    }
    const container = anchor.closest('dialog[open], [aria-modal="true"]') ?? host;
    if (tooltip.parentNode !== container) container.append(tooltip);
    if (tooltip.textContent !== text) tooltip.textContent = text;
    const box = place(tooltip, anchor);
    if (box !== previousBox || isMoving(anchor)) frame = requestAnimationFrame(draw);
    previousBox = box;
  };
  const show = () => {
    previousBox = "";
    draw();
  };
  const changes = new MutationObserver((records) => {
    if (records.some((record) => record.target !== tooltip)) show();
  });
  const sizes = new ResizeObserver(show);
  /** @param {EventTarget | null} target */
  const partOf = (target) => {
    const part = target instanceof Element ? target.closest("[data-tip]") : null;
    return part instanceof HTMLElement && root.contains(part) ? part : null;
  };
  /** @param {HTMLElement | null} next */
  const point = (next) => {
    if (next === anchor) return;
    anchor = next;
    changes.disconnect();
    if (anchor) changes.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    show();
  };
  /** @param {PointerEvent} event */
  const onPointer = (event) => point(event.buttons && event.pointerType !== "touch" ? null : partOf(event.target));
  /** @param {PointerEvent} event */
  const onRelease = (event) => (event.pointerType === "touch" ? point(null) : onPointer(event));
  /** @param {PointerEvent} event */
  const onOut = (event) => {
    if (!(event.relatedTarget instanceof Element) || !root.contains(event.relatedTarget)) point(null);
  };
  /** @param {FocusEvent} event */
  const onFocus = (event) => {
    if (event.target instanceof Element && event.target.matches(":focus-visible")) point(partOf(event.target));
  };
  const dismiss = () => point(null);
  /** @param {KeyboardEvent} event */
  const onKey = (event) => {
    if (event.key === "Escape") dismiss();
  };
  const capture = { capture: true };
  root.addEventListener("pointerover", onPointer, capture);
  root.addEventListener("pointerdown", onPointer, capture);
  root.addEventListener("pointerup", onRelease, capture);
  root.addEventListener("pointerout", onOut, capture);
  root.addEventListener("pointercancel", dismiss, capture);
  root.addEventListener("focusin", onFocus);
  root.addEventListener("focusout", dismiss);
  root.addEventListener("keydown", onKey, capture);
  if (root !== ownerDocument) root.addEventListener("scroll", show, { capture: true, passive: true });
  view.addEventListener("scroll", show, { capture: true, passive: true });
  view.addEventListener("resize", show);
  return () => {
    dismiss();
    root.removeEventListener("pointerover", onPointer, capture);
    root.removeEventListener("pointerdown", onPointer, capture);
    root.removeEventListener("pointerup", onRelease, capture);
    root.removeEventListener("pointerout", onOut, capture);
    root.removeEventListener("pointercancel", dismiss, capture);
    root.removeEventListener("focusin", onFocus);
    root.removeEventListener("focusout", dismiss);
    root.removeEventListener("keydown", onKey, capture);
    if (root !== ownerDocument) root.removeEventListener("scroll", show, capture);
    view.removeEventListener("scroll", show, capture);
    view.removeEventListener("resize", show);
  };
}
