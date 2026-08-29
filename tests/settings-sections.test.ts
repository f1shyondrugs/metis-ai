import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const settingsSource = readFileSync(new URL("../components/settings-panel.tsx", import.meta.url), "utf8");

function parseSettingsSections(source: string) {
  const block = source.match(/const SETTINGS_SECTIONS[^=]*= \{([\s\S]*?)\n\};/);
  assert.ok(block, "SETTINGS_SECTIONS is defined");
  const sections: Record<string, string[]> = {};
  for (const match of block[1].matchAll(/(\w+): \[([\s\S]*?)\],/g)) {
    sections[match[1]] = [...match[2].matchAll(/id: "(settings-[^"]+)"/g)].map((item) => item[1]);
  }
  return sections;
}

function headingIdsInTab(source: string, tab: string) {
  const tabStart = source.indexOf(`<TabsContent value="${tab}"`);
  assert.ok(tabStart >= 0, `${tab} tab exists`);
  const tabEnd = source.indexOf("</TabsContent>", tabStart);
  return [...source.slice(tabStart, tabEnd).matchAll(/id="(settings-[^"]+)"/g)].map((item) => item[1]);
}

test("settings subsection links match the heading order in each tab", () => {
  const sections = parseSettingsSections(settingsSource);
  assert.deepEqual(sections.general, [
    "settings-default-model",
    "settings-subagent-model",
    "settings-token-compression",
    "settings-notifications",
    "settings-voice-input",
    "settings-browser",
    "settings-browser-storage",
    "settings-session",
  ]);
  for (const tab of Object.keys(sections)) {
    assert.deepEqual(headingIdsInTab(settingsSource, tab), sections[tab], tab);
  }
});

test("browser storage uses a dedicated manager instead of an inline origin list on General", () => {
  const general = settingsSource.slice(
    settingsSource.indexOf('<TabsContent value="general"'),
    settingsSource.indexOf("</TabsContent>", settingsSource.indexOf('<TabsContent value="general"')),
  );
  assert.match(general, /id="settings-browser-storage"/);
  assert.match(general, /setSettingsPane\("browser-storage"\)/);
  assert.doesNotMatch(general, /browserStorage\.map/);
  assert.doesNotMatch(general, /filteredBrowserStorage\.map/);
  assert.match(settingsSource, /data-slot="browser-storage-manager"/);
  assert.match(settingsSource, /filteredBrowserStorage\.map/);
  assert.match(settingsSource, /placeholder="Search websites"/);
  assert.match(settingsSource, /if \(item\.id === "settings-browser-storage"\) \{\s*setSettingsPane\("browser-storage"\);/);
});

test("provider editing stays inside the Models settings tab and OAuth names can be saved without reconnecting", () => {
  const editStart = settingsSource.indexOf("function editProviderConnection");
  const editEnd = settingsSource.indexOf("async function saveProviderConnection", editStart);
  const editBlock = settingsSource.slice(editStart, editEnd);
  assert.match(editBlock, /onSettingsTabChange\("models"\)/);
  assert.doesNotMatch(editBlock, /onSettingsTabChange\("providers"\)/);

  const oauthControls = settingsSource.slice(
    settingsSource.indexOf('{providerDraft.authType === "oauth" ? ('),
    settingsSource.indexOf(') : (', settingsSource.indexOf('{providerDraft.authType === "oauth" ? (')),
  );
  assert.match(oauthControls, /Save changes/);
  assert.match(oauthControls, /saveProviderConnection/);
  assert.match(oauthControls, /Reconnect OAuth/);
});
