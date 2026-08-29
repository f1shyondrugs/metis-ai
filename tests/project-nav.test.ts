import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const navSource = readFileSync(new URL("../components/project-nav.tsx", import.meta.url), "utf8");
const filesRoute = readFileSync(new URL("../app/api/projects/[id]/files/route.ts", import.meta.url), "utf8");
const projectsSource = readFileSync(new URL("../lib/projects.ts", import.meta.url), "utf8");

test("None project view hides chats that belong to a project", () => {
 assert.match(navSource, /if \(!activeProjectId\) return !chat\.projectId/);
 assert.doesNotMatch(navSource, /if \(!activeProjectId\) return true/);
});

test("project file uploads accept multipart bytes", () => {
 assert.match(filesRoute, /multipart\/form-data/);
 assert.match(filesRoute, /form\.get\("file"\)/);
 assert.match(projectsSource, /bytes\?: Buffer \| Uint8Array/);
});

test("new-project dialog stays mounted; closing it or creating still collapses mobile nav", () => {
 assert.match(navSource, /function openCreate\(\) \{\s*setCreateOpen\(true\);\s*\}/);
 assert.doesNotMatch(navSource, /function openCreate\(\) \{[^}]*onCollapseNav/);
 assert.match(navSource, /if \(!open\) onCollapseNav\?\.\(\)/);
 assert.match(navSource, /onOpenProject\(body\.project\.id\);\s*onCollapseNav\?\.\(\)/);
 const shellSource = readFileSync(new URL("../components/app-shell.tsx", import.meta.url), "utf8");
 assert.match(shellSource, /function openProjectHome\(projectId: string\) \{[\s\S]*?setMobileNavOpen\(false\)/);
});
