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
const quotaSource = readFileSync(
  new URL("../components/quota-gauges.tsx", import.meta.url),
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

test("mobile chat actions are touch-sized, edit is reachable, and run status stays with the transcript", () => {
  assert.match(shellSource, /onClick=\{\(\) => startEditing\(m\)\}/);
  assert.match(shellSource, /function startEditing\(message: Msg\)[\s\S]*message\.role !== "user"/);
  assert.doesNotMatch(shellSource, /startEditing[\s\S]{0,240}message\.id\.startsWith\("u-"\)/);
  assert.match(shellSource, /h-9 gap-1 rounded-lg px-2/);
  assert.match(shellSource, /className="flex min-w-0 items-center gap-2 px-1 text-xs text-muted-foreground md:hidden"/);
  assert.match(shellSource, /className="mb-2 hidden items-center justify-center gap-2 text-xs text-muted-foreground md:flex"/);
  assert.match(shellSource, /env\(safe-area-inset-bottom\)/);
});

test("mobile composer uses a centered header model picker and progressive secondary controls", () => {
  assert.match(shellSource, /open=\{mobileModelMenuOpen\}/);
  assert.match(shellSource, /w-\[min\(38vw,18rem\)\][\s\S]*aria-label=\{`Model:/);
  assert.match(shellSource, /className="flex flex-col gap-1"/);
  assert.match(shellSource, /aria-label=\{`Agent mode:[\s\S]*h-11 min-w-0 max-w-\[11rem\]/);
  assert.match(shellSource, /aria-label=\{`Runtime permissions:[\s\S]*className="hidden size-7[\s\S]*md:flex/);
  assert.match(shellSource, /className="hidden h-7[\s\S]*md:inline-flex"[\s\S]*title=\{`Model:/);
  assert.match(shellSource, /mobileComposerControls=\{\{/);
  assert.match(shellSource, /<span className="shrink-0">Context<\/span>[\s\S]*md:hidden/);
  assert.match(shellSource, /PlanUsageGauge[\s\S]*className="hidden h-7 px-1 text-\[10px\] md:inline-flex"/);
  assert.match(shellSource, /className="size-11 shrink-0 self-end rounded-full sm:size-9"/);
  assert.match(shellSource, /justify-center pb-\[10svh\]/);
  assert.match(shellSource, /text-center text-\[28px\] font-semibold/);
});


test("model selector remembers the last model per provider and keeps search collapsed by default", () => {
  assert.match(shellSource, /const \[lastModelByProvider, setLastModelByProvider\] = useState<Record<string, string>>\(\{\}\)/);
  assert.match(shellSource, /lastModelByProvider: nextLastModelByProvider/);
  assert.match(shellSource, /const rememberedModelId = lastModelByProvider\[provider\.value\]/);
  assert.match(shellSource, /void selectModel\(rememberedModelId\)/);
  assert.match(shellSource, /setModelSearchOpen\(false\);[\s\S]*setModelProviderFilter\(selectedKey\.providerKey\)/);
  assert.match(shellSource, /if \(modelSearchOpen\) modelSearchRef\.current\?\.focus\(\)/);
  assert.match(shellSource, /modelSearchOpen \? \([\s\S]*aria-label="Search models"[\s\S]*Search models/);
});

test("provider usage is text-only instead of a decorative gauge icon", () => {
  assert.match(quotaSource, /left !== null \? `\$\{left\.toFixed\(0\)\}%` : "—"/);
  assert.match(quotaSource, /text-muted-foreground\/60/);
  assert.doesNotMatch(quotaSource, /SemicircleGauge|UsageRing/);
  assert.doesNotMatch(quotaSource, /hover:bg-muted\/25/);
});


test("workspace does not show a loading skeleton for a fresh draft with no chat id", () => {
  assert.match(shellSource, /loadingChatId !== null && loadingChatId === activeChatId/);
});
