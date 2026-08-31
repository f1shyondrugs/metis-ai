import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const navSource = readFileSync(new URL("../components/project-nav.tsx", import.meta.url), "utf8");
const filesRoute = readFileSync(new URL("../app/api/projects/[id]/files/route.ts", import.meta.url), "utf8");
const projectsSource = readFileSync(new URL("../lib/projects.ts", import.meta.url), "utf8");
const projectHomeSource = readFileSync(new URL("../components/project-home.tsx", import.meta.url), "utf8");
const notesRoute = readFileSync(new URL("../app/api/notes/route.ts", import.meta.url), "utf8");

test("None project view hides chats that belong to a project", () => {
 assert.match(navSource, /if \(!activeProjectId\) return !chat\.projectId/);
 assert.doesNotMatch(navSource, /if \(!activeProjectId\) return true/);
});

test("Project Hub uploads use the normal chat JSON-base64 contract", () => {
 assert.match(projectHomeSource, /headers: \{ "Content-Type": "application\/json" \}/);
 assert.match(projectHomeSource, /data: await fileToBase64\(file\)/);
 assert.match(filesRoute, /body\.data/);
 assert.match(projectsSource, /bytes\?: Buffer \| Uint8Array/);
});

test("project files are automatically included in every project chat context", () => {
 assert.match(projectsSource, /automatically available in every chat under this project/);
 assert.match(projectsSource, /projectFileContext\.join\("\\n"\)/);
 assert.match(projectsSource, /readProjectFileBytes\(project\.id, file\.id, ownerId\)/);
 const shellSource = readFileSync(new URL("../components/app-shell.tsx", import.meta.url), "utf8");
 assert.match(shellSource, /attachProjectFileToNextChat/);
 assert.match(shellSource, /addPendingFiles\(\[new File\(\[blob\], file\.name/);
});

test("internal learned facts stay out of the Shared Notes API", () => {
 assert.match(notesRoute, /\.filter\(\(note\) => note\.kind !== "learned_fact"\)/);
 assert.match(notesRoute, /note\.kind !== "learned_fact" && note\.projectId/);
});

test("new-project dialog stays mounted; closing it or creating still collapses mobile nav", () => {
 assert.match(navSource, /function openCreate\(\) \{\s*setCreateOpen\(true\);\s*\}/);
 assert.doesNotMatch(navSource, /function openCreate\(\) \{[^}]*onCollapseNav/);
 assert.match(navSource, /if \(!open\) onCollapseNav\?\.\(\)/);
 assert.match(navSource, /onOpenProject\(body\.project\.id\);\s*onCollapseNav\?\.\(\)/);
 const shellSource = readFileSync(new URL("../components/app-shell.tsx", import.meta.url), "utf8");
 assert.match(shellSource, /function openProjectHome\(projectId: string\) \{[\s\S]*?setMobileNavOpen\(false\)/);
});
