import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const shellSource = readFileSync(new URL("../components/app-shell.tsx", import.meta.url), "utf8");

test("mobile sidebar stays open when selecting normal sidebar content", () => {
  const sidebarStart = shellSource.indexOf("const sidebar = (mobile = false) => (");
  const sidebarEnd = shellSource.indexOf("useEffect(() =>", sidebarStart);
  assert.ok(sidebarStart >= 0 && sidebarEnd > sidebarStart, "sidebar render block should be present");
  const sidebarSource = shellSource.slice(sidebarStart, sidebarEnd);

  assert.doesNotMatch(sidebarSource, /setMobileNavOpen\(false\)/);
});

test("loading or creating a chat does not implicitly dismiss the mobile sidebar", () => {
  const applyStart = shellSource.indexOf("const applySnapshot = useCallback");
  const prefetchStart = shellSource.indexOf("const prefetchChat = useCallback", applyStart);
  assert.ok(applyStart >= 0 && prefetchStart > applyStart, "chat navigation helpers should be present");
  const chatNavigationSource = shellSource.slice(applyStart, prefetchStart);

  assert.doesNotMatch(chatNavigationSource, /setMobileNavOpen\(false\)/);
});

test("route synchronization does not override an open mobile sidebar", () => {
  const routeStart = shellSource.indexOf("if (routeChatId === \"automations\" || routeView === \"automations\")");
  const routeEnd = shellSource.indexOf("useEffect(() =>", routeStart + 1);
  assert.ok(routeStart >= 0 && routeEnd > routeStart, "route synchronization block should be present");
  const routeSource = shellSource.slice(routeStart, routeEnd);

  assert.doesNotMatch(routeSource, /setMobileNavOpen\(false\)/);
});
