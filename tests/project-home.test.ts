import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const homeSource = readFileSync(new URL("../components/project-home.tsx", import.meta.url), "utf8");
const shellSource = readFileSync(new URL("../components/app-shell.tsx", import.meta.url), "utf8");

test("project hub shows a skeleton until the requested project payload is loaded", () => {
  assert.match(homeSource, /function ProjectHomeSkeleton\(/);
  assert.match(homeSource, /data-slot="project-home-skeleton"/);
  assert.match(homeSource, /aria-label="Loading project"/);
  assert.match(
    homeSource,
    /if \(!data \|\| data\.project\.id !== projectId\) return <ProjectHomeSkeleton \/>/,
  );
});

test("switching project hubs remounts, clears stale data, and aborts the previous fetch", () => {
  assert.match(shellSource, /<ProjectHome\s+key=\{projectHomeId\}/);
  assert.match(shellSource, /function openProjectHome\(projectId: string\) \{[\s\S]*?setPaneKey\(\(k\) => k \+ 1\)/);
  assert.match(homeSource, /useLayoutEffect\(/);
  assert.match(homeSource, /const controller = new AbortController\(\)/);
  assert.match(homeSource, /setData\(null\)/);
  assert.match(homeSource, /setName\(""\)/);
  assert.match(homeSource, /loadGenerationRef\.current \+= 1/);
  assert.match(homeSource, /generation !== loadGenerationRef\.current/);
  assert.match(homeSource, /return \(\) => controller\.abort\(\)/);
  assert.doesNotMatch(homeSource, /\.then\(load\)/);
});

test("project hub uploads files as multipart FormData", () => {
 assert.match(homeSource, /const form = new FormData\(\)/);
 assert.match(homeSource, /form\.set\("file", file, file\.name\)/);
});
