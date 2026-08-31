import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const homeSource = readFileSync(new URL("../components/project-home.tsx", import.meta.url), "utf8");
const shellSource = readFileSync(new URL("../components/app-shell.tsx", import.meta.url), "utf8");

test("new chat omits the normal helper subtitle and uses a balanced revert icon", () => {
  assert.doesNotMatch(shellSource, /How can I help you today\?/);
  assert.match(shellSource, /<CornerUpLeft className="size-3\.5 shrink-0" \/>\s*Revert/);
});

test("new chats reuse the last equipped model instead of the server default", () => {
  assert.match(shellSource, /localStorage\.getItem\(MODEL_STORAGE_KEY\)/);
  assert.match(shellSource, /setModelId\(nextNewChatModelId\)/);
  assert.doesNotMatch(shellSource, /setModelId\(stateRef\.current\.defaultModelId \|\| \"\"\)/);
});

test("new chats restore saved model suboptions before server preferences finish loading", () => {
  assert.match(shellSource, /localStorage\.getItem\(PARAMS_STORAGE_KEY\)/);
  assert.match(shellSource, /if \(Array\.isArray\(saved\)\) return saved as ModelParamSelection\[\];/);
  assert.match(shellSource, /setModelParams\(nextNewChatParams\)/);
  assert.match(shellSource, /stateRef\.current\.modelId === nextNewChatModelId/);
  assert.match(shellSource, /persistModelParamsByModel\(nextParamMap\)/);
});

test("legacy server model preferences cannot overwrite the latest local model", () => {
  assert.doesNotMatch(shellSource, /const nextId = settings\.modelId/);
  assert.doesNotMatch(shellSource, /if \(!activeChatIdRef\.current\) setModelId\(nextId\)/);
});

test("background chat streams cannot mutate the visible chat or close Notes", () => {
  assert.match(shellSource, /if \(!isActiveChat && event !== "question"\) continue;/);
  assert.match(shellSource, /if \(activeChatIdRef\.current === chatId\) \{\s*setMessages/);
  assert.match(shellSource, /current && !activeChatIncognito && !notesOpen && !automationsOpen/);
});

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
  assert.match(shellSource, /!notesOpen && !automationsOpen && !projectHomeId && activeChatId \? <NotesVoid/);
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

test("project hub uploads files with the normal chat JSON-base64 method", () => {
  assert.match(homeSource, /headers: \{ "Content-Type": "application\/json" \}/);
  assert.match(homeSource, /data: await fileToBase64\(file\)/);
  assert.match(homeSource, /className=\"hidden\"/);
  assert.match(homeSource, /fileInputRef\.current\?\.click\(\)/);
  assert.match(homeSource, /Attach \$\{file\.name\} to the next chat/);
  assert.match(homeSource, /await load\(\)/);
});

test("project hub header stays usable on narrow screens", () => {
  assert.match(homeSource, /grid-cols-\[3\.5rem_minmax\(0,1fr\)\]/);
  assert.match(homeSource, /col-span-2 grid grid-cols-2 gap-2 sm:col-span-1/);
  assert.match(homeSource, /project-home-scroll/);
});

test("the unfiltered project chip is labelled All instead of None", () => {
  const projectNavSource = readFileSync(new URL("../components/project-nav.tsx", import.meta.url), "utf8");
  assert.match(projectNavSource, />\s*All\s*<\/button>/);
  assert.doesNotMatch(projectNavSource, />\s*None\s*<\/button>/);
});
