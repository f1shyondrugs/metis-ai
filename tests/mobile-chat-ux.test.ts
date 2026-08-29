import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const shell = readFileSync(new URL("../components/app-shell.tsx", import.meta.url), "utf8");
const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");

 test("mobile header gives the model a centered, viewport-bounded lane", () => {
  assert.match(shell, /absolute inset-y-0 left-14 right-\[6\.75rem\].*justify-center md:hidden/);
  assert.match(shell, /max-w-full items-center justify-center.*text-\[14px\]/);
});

test("agent and runtime mode controls are not rendered in the normal mobile composer row", () => {
  assert.match(shell, /aria-label=\{`Agent mode:.*className="hidden[^\"]*md:flex"/s);
  assert.match(shell, /aria-label=\{`Runtime permissions:.*className="hidden[^\"]*md:flex/s);
});

test("opening a chat on mobile dismisses composer focus instead of opening the keyboard", () => {
  assert.match(shell, /const loadChat = useCallback[\s\S]*?matchMedia\("\(max-width: 767px\), \(pointer: coarse\)"\)[\s\S]*?textareaRef\.current\?\.blur\(\)/);
  assert.match(shell, /const mobileInteraction = window\.matchMedia\("\(max-width: 767px\), \(pointer: coarse\)"\)\.matches;\s*if \(mobileInteraction\) return;/);
});

test("focused mobile composer stays above the software keyboard", () => {
  assert.match(layout, /interactiveWidget: "resizes-content"/);
  assert.match(shell, /const visualShrink = Math\.max\(0, mobileKeyboardBaselineRef\.current - visibleBottom\)/);
  assert.match(shell, /const layoutShrink = Math\.max\(0, mobileKeyboardBaselineRef\.current - currentLayoutHeight\)/);
  assert.match(shell, /const obscured = Math\.max\(0, visualShrink - layoutShrink\)/);
  assert.match(shell, /composerFocused && "max-md:fixed max-md:z-30"/);
  assert.match(shell, /style=\{composerFocused \? \{ bottom: mobileKeyboardInset \} : undefined\}/);
});

test("mobile composer footer always shows context and provider usage beside compact controls", () => {
  assert.doesNotMatch(shell, /showMobileContextUsage/);
  assert.match(shell, /<span className="shrink-0">Context<\/span>[\s\S]*?<ContextUsageText[\s\S]*?md:hidden/s);
  assert.match(shell, /<span className="shrink-0">Usage<\/span>[\s\S]*?<PlanUsageGauge/s);
  assert.match(shell, /order-2 ml-auto flex size-8[\s\S]*?<ModelOptionsMenu/s);
});

test("running tool activity replaces the redundant generic agent-running row", () => {
  assert.match(shell, /const latestAssistantHasRunningTool = Boolean\([\s\S]*?isToolRunning\(part\.status\)/);
  const guardedStatuses = shell.match(/activeChatIsRunning && !latestAssistantHasRunningTool/g) || [];
  assert.equal(guardedStatuses.length >= 2, true);
});

test("intermediate progress narration is visually quieter than the final answer", () => {
  assert.match(shell, /const hasLaterActivity = blocks\.slice\(bi \+ 1\)\.some\(\(candidate\) => candidate\.type !== "text"\)/);
  assert.match(shell, /hasLaterActivity && "text-\[14px\] leading-6 text-foreground\/75"/);
});


test("legacy Codex diagnostic rows are hidden from existing chat history", () => {
  assert.match(shell, /function isLegacyCodexNoiseTool/);
  assert.match(shell, /name === "codex error" \|\| name === "codex todo list"/);
  assert.match(shell, /visibleTools = \(m\.tools \|\| \[\]\)\.filter\(\(tool\) => !isLegacyCodexNoiseTool\(tool\)\)/);
});
