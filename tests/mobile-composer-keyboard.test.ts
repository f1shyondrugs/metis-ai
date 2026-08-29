import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const shell = readFileSync(new URL("../components/app-shell.tsx", import.meta.url), "utf8");
const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");

test("mobile chat navigation does not autofocus the composer", () => {
  assert.match(shell, /mobileInteraction = window\.matchMedia\("\(max-width: 767px\), \(pointer: coarse\)"\)\.matches/);
  assert.match(shell, /if \(mobileInteraction\) return;/);
});

test("mobile keyboard resizes content with visual viewport fallback", () => {
  assert.match(layout, /interactiveWidget: "resizes-content"/);
  assert.match(shell, /window\.visualViewport/);
  assert.match(shell, /mobileKeyboardInset/);
  assert.match(shell, /composerFocused && "max-md:fixed/);
});
