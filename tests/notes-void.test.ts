import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const notes = readFileSync(new URL("../components/notes-void.tsx", import.meta.url), "utf8");
const pinned = readFileSync(new URL("../components/pinned-notes-panel.tsx", import.meta.url), "utf8");

test("empty note body can start a move without blocking text clicks", () => {
  assert.match(notes, /fromEditorEmpty/);
  assert.match(notes, /armed: true/);
  assert.match(notes, /target\.closest\("\.markdown-body, input, textarea, button, a, \[data-editor-control\]"\)/);
  assert.match(pinned, /startDrag\(event, note\)/);
});

test("every note can add todos from a top plus control", () => {
  assert.match(notes, /aria-label="Add todo"/);
  assert.match(notes, /setDraftTodoNoteId\(note\.id\)/);
  assert.doesNotMatch(notes, /note\.kind === "project" \? \(\s*<div/);
  assert.match(notes, /commitTodos\(note, \[/);
});
