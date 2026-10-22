/* global document */

// The one message box Scrawl draws. The Conversation box in the chrome and the annotation box on a
// highlighted component are both this component, so neither can have a part the other lacks: one
// bordered field holding the text, the paperclip at its bottom left and the board's voice bubble at
// its bottom right, whose card lists the recent dictations to copy or paste back.
// server.js serializes every export into the chrome client and into the SDK the reviewed page runs
// (serializeModuleHelpers), so the module exports only functions and keeps no state of its own.

// The box's line icons, drawn by the board's `.icon` rule (code-goblins frontend/src/Icon.tsx).
export function messageBoxIcon(name) {
  const paths = {
    paperclip:
      "M19.24 12.32L12.88 18.69A4.75 4.75 0 0 1 6.16 11.97L13.23 4.9A3.25 3.25 0 0 1 17.83 9.49L11.11 16.21A1.75 1.75 0 0 1 8.64 13.74L14.29 8.08",
    mic: "M12 3.5a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0v-5a3 3 0 0 0-3-3ZM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7",
    close: "M6 6l12 12M18 6 6 18",
    copy: "M9 9h10v11H9ZM5 15V4h10",
    check: "M5 12.5 9.5 17 19 7.5",
    paste:
      "M8.5 5H6.5A1.5 1.5 0 0 0 5 6.5v13A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-13A1.5 1.5 0 0 0 17.5 5h-2M9 3.5h6v3H9ZM12 10v7M9 14l3 3 3-3",
  };
  return (
    '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="' + paths[name] + '"/></svg>'
  );
}

// What the voice bubble says. Browsers refuse the microphone to a plain-http page anywhere but
// localhost, so the page's link, not a site setting, is what has to change.
export function voiceCopy() {
  return {
    unsupported: "Voice input needs Chrome or Edge",
    insecure: "Voice input needs this page's https link",
    idle: "Hold Ctrl+Shift+Space to dictate",
    held: "Listening · release Ctrl+Shift+Space to type",
    recent: "Recent dictations",
  };
}

// The box's markup. Each part's id is the box's id and the part's name (`chatInput`, `chatVoice`),
// and the recent dictations follow the bubble, so Tab goes from the bubble into them. The picker
// names no camera, so a phone offers its photo library among its ways to choose an image.
/** @param {{ id: string, placeholder: string, accept: string }} box */
export function messageBoxHtml(box) {
  const attribute = (value) => String(value).replace(/[&<>"']/g, (character) => "&#" + character.charCodeAt(0) + ";");
  const id = (part) => attribute(box.id + part);
  return (
    '<div class="composer-field" id="' +
    id("Field") +
    '"><textarea id="' +
    id("Input") +
    '" placeholder="' +
    attribute(box.placeholder) +
    '"></textarea><div class="composer-tools"><button class="icon-button composer-tool" id="' +
    id("Attach") +
    '" type="button" aria-label="Attach images" data-tip="Attach images" data-tip-align="start">' +
    messageBoxIcon("paperclip") +
    '</button><input id="' +
    id("AttachInput") +
    '" type="file" accept="' +
    attribute(box.accept) +
    '" multiple hidden><div class="voice-dock chat-voice-dock" id="' +
    id("VoiceDock") +
    '"><button class="voice-bubble chat-voice" id="' +
    id("Voice") +
    '" type="button" aria-label="Recent dictations" aria-expanded="false" aria-controls="' +
    id("VoiceRecent") +
    '" data-tip-align="end">' +
    messageBoxIcon("mic") +
    '<span class="chat-voice-dot voice-dot" aria-hidden="true"></span><span class="chat-voice-bars voice-bars" id="' +
    id("VoiceBars") +
    '" aria-hidden="true">' +
    "<span></span>".repeat(9) +
    '</span></button><section class="voice-card voice-recent" id="' +
    id("VoiceRecent") +
    '" role="dialog" aria-label="Recent dictations" hidden><p class="voice-card-title">Recent dictations</p><button class="icon-button pixel-icon voice-close" id="' +
    id("VoiceRecentClose") +
    '" type="button" aria-label="Close recent dictations" data-tip="Close">' +
    messageBoxIcon("close") +
    '</button><ul id="' +
    id("VoiceRecentList") +
    '"></ul><p class="voice-empty" id="' +
    id("VoiceRecentEmpty") +
    '">Nothing dictated yet.</p><p class="voice-footer">Hold Ctrl+Shift+Space, speak, release. Heard by this browser&#39;s speech recognition, which sends your voice to the browser&#39;s maker.</p></section></div></div></div>'
  );
}

// What a key event means for dictation: whether it starts or stops listening, and whether the page
// must not see it. Releasing Ctrl or Shift first also stops, and that release still reaches the page.
export function dictationKey(event) {
  if (event.code === "Space" && event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey) {
    if (event.type === "keyup") return { action: "stop", swallow: true };
    return { action: event.repeat ? null : "start", swallow: true };
  }
  if (event.type === "keyup" && (event.code === "Space" || event.key === "Control" || event.key === "Shift")) {
    return { action: "stop", swallow: false };
  }
  return null;
}

// Dictated text replaces the selection in the box, a space apart from the words beside it, and the
// caret lands right after it.
export function insertDictation(value, start, end, text) {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const inserted = before + (/\S$/.test(before) ? " " : "") + text;
  return { value: inserted + (/^[\p{L}\p{N}]/u.test(after) ? " " : "") + after, caret: inserted.length };
}

// A waveform bar's height for a level: a fifth of full height in silence, so it stays visible, up to
// full height at the loudest.
export function voiceBarScale(level) {
  return (1 + 4 * level) / 5;
}

// The voice bubble and its recent dictations, drawn from the state its box gives it. The box keeps
// the dictations and says what Copy and Paste do: the chrome listens, so it alone holds them.
// `render` takes whether this browser can listen, whether the page is secure, whether this box is
// listening, and whether it can take text. `fit` sizes the open card to the room its box has.
/**
 * @param {{ field: HTMLElement, dock: HTMLElement, button: HTMLButtonElement, bars: HTMLElement, card: HTMLElement, list: HTMLElement, empty: HTMLElement, close: HTMLButtonElement }} parts
 * @param {{ dictations: () => Array<{ text: string, at: number }>, paste: (text: string) => void, copy: ((text: string) => Promise<unknown>) | null, fit: (card: HTMLElement) => void, rebuildKeepingFocus: (container: HTMLElement, rebuild: () => void) => void }} host
 */
export function createVoiceBubble(parts, host) {
  // The list shows this many of the box's dictations, and a copied one says so this long.
  const listed = 5;
  const copiedMs = 1400;
  const copy = voiceCopy();
  let state = { supported: false, secure: true, listening: false, disabled: false };
  let open = false;
  // The entry whose Copy just worked, which shows a check for a moment.
  let copied = "";
  let copiedTimer;

  function render(next) {
    state = { ...state, ...next };
    const { button } = parts;
    button.disabled = !state.supported || state.disabled;
    button.setAttribute(
      "aria-label",
      !state.supported ? copy.unsupported : state.listening ? "Listening" : copy.recent,
    );
    button.setAttribute(
      "data-tip",
      !state.supported ? copy.unsupported : !state.secure ? copy.insecure : state.listening ? copy.held : copy.idle,
    );
    button.classList.toggle("recording", state.listening);
    parts.field.classList.toggle("is-dictating", state.listening);
    // A box that can no longer take text has no dictations to paste.
    if (button.disabled && open) setOpen(false);
  }

  function showLevels(levels) {
    Array.from(parts.bars.children).forEach((bar, index) => {
      /** @type {HTMLElement} */ (bar).style.transform = "scaleY(" + voiceBarScale(levels[index] || 0) + ")";
    });
  }

  function setOpen(next) {
    open = next;
    parts.card.hidden = !open;
    parts.button.setAttribute("aria-expanded", String(open));
    refresh();
  }

  // The recent dictations card, as the board's voice bubble draws it: the newest first, each with
  // when it was said, its words, Copy where the page has a clipboard, and Paste into this box.
  function refresh() {
    if (!open) return;
    host.fit(parts.card);
    const shown = host.dictations().slice(0, listed);
    parts.list.hidden = shown.length === 0;
    parts.empty.hidden = shown.length > 0;
    host.rebuildKeepingFocus(parts.list, () => parts.list.replaceChildren(...shown.map(entryItem)));
  }

  function entryItem(dictation, index) {
    const entry = dictation.at + ":" + index;
    const item = document.createElement("li");
    if (dictation.at > 0) {
      const said = document.createElement("span");
      said.className = "voice-meta";
      said.textContent = new Date(dictation.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      item.appendChild(said);
    }
    const words = document.createElement("p");
    words.className = "voice-text";
    words.textContent = dictation.text;
    item.appendChild(words);
    const actions = document.createElement("span");
    actions.className = "voice-actions";
    if (host.copy) {
      const isCopied = copied === entry;
      actions.appendChild(
        action(
          "copy:" + entry,
          "Copy: " + dictation.text,
          isCopied ? "Copied" : "Copy",
          messageBoxIcon(isCopied ? "check" : "copy"),
          () => copyEntry(dictation.text, entry),
        ),
      );
    }
    actions.appendChild(
      action(
        "paste:" + entry,
        "Paste into this box: " + dictation.text,
        "Paste into this box",
        messageBoxIcon("paste"),
        () => {
          host.paste(dictation.text);
          setOpen(false);
        },
      ),
    );
    item.appendChild(actions);
    return item;
  }

  function action(focusKey, label, tip, icon, act) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-button pixel-icon";
    button.dataset.focusKey = focusKey;
    button.setAttribute("aria-label", label);
    button.setAttribute("data-tip", tip);
    button.innerHTML = icon;
    button.onclick = act;
    return button;
  }

  // A copy the browser refuses shows no check.
  function copyEntry(text, entry) {
    host.copy(text).then(
      () => {
        copied = entry;
        clearTimeout(copiedTimer);
        copiedTimer = setTimeout(() => {
          copied = "";
          refresh();
        }, copiedMs);
        refresh();
      },
      () => {},
    );
  }

  function closeToBubble() {
    setOpen(false);
    parts.button.focus();
  }

  parts.button.onclick = () => setOpen(!open);
  parts.close.onclick = closeToBubble;
  // Escape from the bubble or from inside the list closes it, closes nothing else, and puts the
  // keyboard back on the bubble.
  parts.dock.addEventListener("keydown", (event) => {
    if (!open || event.key !== "Escape") return;
    event.stopPropagation();
    closeToBubble();
  });

  return { render, showLevels, setOpen, refresh, isOpen: () => open };
}
