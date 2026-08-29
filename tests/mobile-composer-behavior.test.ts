import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const shell = readFileSync(new URL("../components/app-shell.tsx", import.meta.url), "utf8");
const toolGroup = readFileSync(new URL("../components/tool-call-chip.tsx", import.meta.url), "utf8");

test("agent mode control is desktop-only in the composer controls", () => {
  const start = shell.indexOf('aria-label={`Agent mode: ${selectedMode.name}`}');
  assert.ok(start >= 0);
  const snippet = shell.slice(start, start + 700);
  assert.match(snippet, /className="hidden[^\"]*md:flex"/);
});

test("opening a chat on mobile blurs the composer instead of opening the keyboard", () => {
  const start = shell.indexOf("const loadChat = useCallback");
  assert.ok(start >= 0);
  const snippet = shell.slice(start, start + 900);
  assert.match(snippet, /matchMedia\("\(max-width: 767px\), \(pointer: coarse\)"\)/);
  assert.match(snippet, /textareaRef\.current\?\.blur\(\)/);
  assert.match(snippet, /setComposerFocused\(false\)/);
});

test("automatic composer focus is skipped for mobile or coarse-pointer devices", () => {
  const start = shell.indexOf('const mobileInteraction = window.matchMedia("(max-width: 767px), (pointer: coarse)").matches;');
  assert.ok(start >= 0);
  const snippet = shell.slice(start, start + 350);
  assert.match(snippet, /if \(mobileInteraction\) return;/);
  assert.match(snippet, /focus\(\{ preventScroll: true \}\)/);
});

test("mobile keyboard positioning compensates only for viewport area not already resized", () => {
  assert.match(shell, /const visualShrink = Math\.max\(0, mobileKeyboardBaselineRef\.current - visibleBottom\)/);
  assert.match(shell, /const layoutShrink = Math\.max\(0, mobileKeyboardBaselineRef\.current - currentLayoutHeight\)/);
  assert.match(shell, /const obscured = Math\.max\(0, visualShrink - layoutShrink\)/);
  assert.match(shell, /composerFocused && \"max-md:fixed/);
});

test("Tasks render outside the collapsible edit/tool activity", () => {
  const activityStart = toolGroup.indexOf("const activityRunning");
  const todoSurface = toolGroup.indexOf("{todoTools.map((tool, index) => (", activityStart);
  const activityBranch = toolGroup.indexOf("{regularEntries.length === 1", activityStart);
  const groupOpen = toolGroup.indexOf("{groupOpen ? (", activityStart);
  const regularNested = toolGroup.indexOf("{regularEntries.map((tool, index) => (", groupOpen);
  assert.ok(activityStart >= 0 && todoSurface > activityStart && todoSurface < activityBranch);
  assert.ok(groupOpen >= 0 && regularNested > groupOpen);
  assert.equal(toolGroup.slice(groupOpen, regularNested).includes("{todoTools.map((tool, index) => ("), false);
});
