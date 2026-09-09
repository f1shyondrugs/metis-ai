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
  assert.match(shell, /const latestAssistantHasRunningTool = Boolean\([\s\S]*?isLiveTool\(part\)/);
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

test("manual upward scrolling disables streaming auto-pin", () => {
  assert.match(shell, /suspendAutoScrollOnWheel = \(event: WheelEvent\)/);
  assert.match(shell, /event\.deltaY >= 0/);
  assert.match(shell, /userDetachedFromBottomRef\.current = true/);
  assert.match(shell, /stickToBottomRef\.current = false/);
  assert.match(shell, /transcriptScrollAction/);
  assert.match(shell, /shouldPinOpenedChat/);
  assert.match(shell, /el\.addEventListener\("wheel", suspendAutoScrollOnWheel/);
  assert.match(shell, /el\.addEventListener\("touchmove", suspendAutoScrollOnTouch/);
  assert.match(shell, /if \(y > lastTouchY \+ 2\) detachFromBottom\(\)/);
  assert.doesNotMatch(shell, /\}, \[loadEarlierMessages, paneKey, loadingChatId\]\)/);
});

test("opening a chat pins the transcript to the bottom and does not page history while pinning", () => {
  assert.match(shell, /enteringChatRef\.current = true/);
  assert.match(shell, /enteringChatRef\.current = false/);
  assert.match(shell, /useLayoutEffect\(\(\) => \{[\s\S]*?pinMessagesToBottom/);
  assert.match(shell, /pinScrollTop\(/);
  assert.match(shell, /\[overflow-anchor:none\]/);
  assert.doesNotMatch(shell, /if \(!loadingChatId\) enteringChatRef\.current = false/);
  assert.match(shell, /layoutResetToTop/);
  assert.match(shell, /if \(el\.scrollTop < 80\) void loadEarlierMessagesRef\.current\(\)/);
  assert.match(shell, /new ResizeObserver\(pinIfStuckToBottom\)/);
  assert.match(shell, /if \(enteringChatRef\.current\) return/);
});

test("completed and stale historical subagents are not shown as still running", () => {
  assert.match(shell, /sourceMessageIsLatestAssistant/);
  assert.match(shell, /Date\.now\(\) - createdAt > 15 \* 60_000/);
  assert.match(shell, /tool\.result === undefined && !isStaleHistoricalSubagent\(tool\)/);
  assert.match(shell, /const runningSubagents = subagentOutputs\.filter\(\(tool\) =>/);
  assert.match(shell, /isBarSubagentLive\(tool, childRunByChatId/);
  assert.match(shell, /isChatBarSubagent\(part\)/);
  assert.match(shell, /some\(\(part\) => part\.type === "tool" && isLiveTool\(part\)\)/);
  assert.match(shell, /aria-label=\{`Stop subagent \$\{tool\.subagent\.title \|\| tool\.name\}`\}/);
  assert.match(shell, /onClick=\{\(\) => void cancelSubagent\(tool\)\}/);
});

test("mobile chat restore does not auto-open the workspace overlay", () => {
  assert.match(shell, /function isMobileChatViewport\(\)/);
  assert.match(shell, /function workspaceOpenFromSession\(sessionOpen: boolean \| undefined\)/);
  assert.match(shell, /setWorkspaceOpen\(workspaceOpenFromSession\(session\.workspaceOpen\)\)/);
  assert.match(shell, /if \(isMobileChatViewport\(\)\) \{[\s\S]*?setWorkspaceOpen\(false\);/);
  assert.match(shell, /if \(!isMobileChatViewport\(\)\) setWorkspaceOpen\(true\)/);
});

test("composer input stays in the action row so wrap width does not jump", () => {
  assert.doesNotMatch(shell, /composer-single-line/);
  assert.doesNotMatch(shell, /composerMultiline/);
  assert.match(shell, /composer-input-area relative min-w-0 flex-1/);
  assert.match(shell, /useLayoutEffect\(\(\) => \{[\s\S]*textareaRef\.current[\s\S]*el\.style\.height = "auto"/);
  assert.match(shell, /el\.style\.overflowY = nextHeight >= 180 \? "auto" : "hidden"/);
});
