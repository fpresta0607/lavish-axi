# Composer voice input - before/after evidence

Task: give the review page's conversation composer the same voice input as the Code Goblins board: a microphone button, push-to-talk on Ctrl+Shift+Space, the browser's own speech recognition, and a live waveform, in this fork's goblin theme.

All screenshots come from the real `lavish-axi` flow: a scratch server on its own port and state directory, serving one sample artifact, captured in headless Chromium at 1440 x 900.
Chromium's fake microphone supplies the audio, so the waveform shows its real level, a beep once a second.
Headless Chromium has no speech service, so a stub recognizer stands in for it and "hears" one sentence when listening stops.

## BEFORE (code-goblins 0.1.79-codegoblins.1)

- `before.png` - the composer: the message box, Attach images, and the send buttons.

## AFTER

- `after-idle.png` - the microphone sits before Attach images; its tooltip, the browser's own title text, which screenshots do not show, reads "Hold Ctrl+Shift+Space or click to dictate".
- `after-recording.png` - listening after a click: the message box border turns the theme's accent green, the microphone becomes a red dot and nine level bars that move with the microphone, and the line under the row reads "Listening · click the microphone to type".
- `after-recording-page.png` - the same moment on the whole page.
- `after-dictated.png` - after the second click: what was heard is added at the caret after the text already typed ("Looks good. keep the nine level bars"), and nothing is sent.
