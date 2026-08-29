import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const shellSource = readFileSync(
  new URL("../components/app-shell.tsx", import.meta.url),
  "utf8",
);
const markdownSource = readFileSync(
  new URL("../components/markdown.tsx", import.meta.url),
  "utf8",
);
const voiceSource = readFileSync(
  new URL("../components/voice-input.tsx", import.meta.url),
  "utf8",
);
const automationsSource = readFileSync(
  new URL("../components/automations-panel.tsx", import.meta.url),
  "utf8",
);
const chipSource = readFileSync(
  new URL("../components/tool-call-chip.tsx", import.meta.url),
  "utf8",
);

test("automation markdown links dispatch open-automations and the shell opens the tab", () => {
  assert.match(markdownSource, /ai-chat:open-automations/);
  assert.match(markdownSource, /automationMatch/);
  assert.match(chipSource, /ai-chat:open-automations/);
  assert.match(shellSource, /ai-chat:open-automations/);
  assert.match(shellSource, /const openLinkedAutomation/);
  assert.match(shellSource, /navigateChat\("automations"\)/);
  assert.match(shellSource, /setFocusedAutomationId\(id\)/);
  assert.match(shellSource, /highlightId=\{focusedAutomationId\}/);
});

test("automations panel can focus a linked automation by id", () => {
  assert.match(automationsSource, /id=\{`automation-\$\{automation\.id\}`\}/);
  assert.match(automationsSource, /await loadDetail\(highlightId\)/);
});

test("voice composer exposes cancel via the plus button and drops stale waveform state", () => {
  assert.match(voiceSource, /cancelSignal\?: number/);
  assert.match(voiceSource, /lastCancelSignalRef/);
  assert.match(voiceSource, /onStateChange\?\.\("idle"\)/);
  assert.match(shellSource, /cancelSignal=\{voiceCancelSignal\}/);
  assert.match(shellSource, /const resetVoiceComposer/);
  assert.match(shellSource, /Cancel voice input/);
  assert.match(shellSource, /<X className="size-4" \/>/);
  assert.match(shellSource, /voiceRecording && voiceState === "recording"/);
  assert.match(shellSource, /\[activeChatId, automationsOpen, notesOpen\]/);
});

test("agent completion uses the bundled default sound unless a custom sound is set", () => {
  const settingsSource = readFileSync(
    new URL("../components/settings-panel.tsx", import.meta.url),
    "utf8",
  );
  assert.match(shellSource, /const DEFAULT_FINISH_SOUND_URL = "\/sounds\/agent-completion\.mp3"/);
  assert.match(shellSource, /finishSound\?\.dataUrl \|\| DEFAULT_FINISH_SOUND_URL/);
  assert.doesNotMatch(shellSource, /createOscillator/);
  assert.match(settingsSource, /Removing a custom file restores that default/);
  assert.ok(
    existsSync(new URL("../public/sounds/agent-completion.mp3", import.meta.url)),
    "default completion sound must be shipped",
  );
});

test("automations can be searched by project name like notes", () => {
  const notesSource = readFileSync(new URL("../components/notes-void.tsx", import.meta.url), "utf8");
  assert.match(notesSource, /projectName\?\.includes\(query\)/);
  assert.match(automationsSource, /placeholder=\"Search automations\"/);
  assert.match(automationsSource, /projectName\?\.includes\(query\)/);
  assert.match(automationsSource, /NoteProjectMenu/);
  assert.match(automationsSource, /projectId: formProjectId/);
});
