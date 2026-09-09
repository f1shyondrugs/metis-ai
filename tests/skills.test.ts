import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  alwaysOnSkillsPrompt,
  enabledSkills,
  isAlwaysOnSkill,
  listInstalledSkills,
  listSkillSettings,
  parseSkillFrontmatter,
  skillEnabled,
 addManualSkill,
  skillsCatalogPrompt,
} from "../lib/skills";
import { autoSkillActivationPrompt, isVisualDesignTask } from "../lib/skill-routing";

test("installed skills come from the lockfile and default to enabled", () => {
  const skills = listInstalledSkills();
  assert.ok(skills.length >= 1);
  assert.ok(skills.every((skill) => skill.id && skill.skillPath));
  assert.equal(skillEnabled(skills[0].id), true);
  assert.equal(skillEnabled(skills[0].id, { enabledSkills: { [skills[0].id]: false } }), false);
});

test("disabled skills are omitted from the agent catalog", () => {
  const skills = listInstalledSkills();
  const disabled = Object.fromEntries(skills.map((skill) => [skill.id, false]));
  assert.equal(enabledSkills({ enabledSkills: disabled }).length, 0);
  assert.equal(skillsCatalogPrompt({ enabledSkills: disabled }), "");
  const catalog = skillsCatalogPrompt();
  assert.match(catalog, /Installed skills/);
  assert.ok(skills.some((skill) => catalog.includes(skill.id)));
});

test("manual skills reject unsafe ids", () => {
 assert.throws(() => addManualSkill("../outside", "# Skill"), /Skill id/);
});


test("skills resolve CLI installs through the canonical .agents directory", () => {
  const skills = listInstalledSkills();
  const design = skills.find((skill) => skill.id === "frontend-design");
  assert.ok(design, "frontend-design should be installed");
  assert.match(design.skillPath, /\.agents\/skills\/frontend-design\/SKILL\.md$/);
  assert.equal(existsSync(path.resolve(process.cwd(), design.skillPath)), true);
});

test("visual design work auto-activates the design bundle only for the matching task", () => {
  const message = "Mache die Handy UI overall cleaner, weniger AI look und fixe Farben";
  assert.equal(isVisualDesignTask(message), true);
  const prompt = autoSkillActivationPrompt(message);
  assert.match(prompt, /DESIGN bundle is active/);
  assert.match(prompt, /metis-design-director/);
  assert.match(prompt, /frontend-design/);
  assert.match(prompt, /design-taste-frontend/);
  assert.match(prompt, /design-system/);
  assert.match(prompt, /web-design-guidelines/);
  assert.match(prompt, /web-design-reviewer/);
  assert.equal(autoSkillActivationPrompt("Erkläre mir prepared statements"), "");
});

test("auto skill routing respects manual skill disable switches", () => {
  const prompt = autoSkillActivationPrompt("Redesign the mobile UI and audit the layout", {
    enabledSkills: { "web-design-guidelines": false },
  });
  assert.doesNotMatch(prompt, /- web-design-guidelines:/);
  assert.match(prompt, /- web-design-reviewer:/);
});


test("i-have-adhd is always-on while enabled and omitted from the match catalog", () => {
  const catalog = skillsCatalogPrompt();
  assert.doesNotMatch(catalog, /i-have-adhd/);
  const alwaysOn = alwaysOnSkillsPrompt();
  assert.match(alwaysOn, /Always-on skill i-have-adhd/);
  assert.match(alwaysOn, /Lead with the next action/);
  assert.equal(alwaysOnSkillsPrompt({ enabledSkills: { "i-have-adhd": false } }), "");
});

test("users can turn always-on off or on per skill", () => {
  assert.equal(isAlwaysOnSkill("i-have-adhd"), true);
  assert.equal(isAlwaysOnSkill("i-have-adhd", { alwaysOnSkills: { "i-have-adhd": false } }), false);
  assert.equal(isAlwaysOnSkill("playwright", { alwaysOnSkills: { playwright: true } }), true);
  const off = skillsCatalogPrompt({ alwaysOnSkills: { "i-have-adhd": false } });
  assert.match(off, /i-have-adhd/);
  assert.equal(alwaysOnSkillsPrompt({ alwaysOnSkills: { "i-have-adhd": false } }), "");
  const extra = alwaysOnSkillsPrompt({ alwaysOnSkills: { playwright: true } });
  assert.match(extra, /Always-on skill i-have-adhd/);
  assert.match(extra, /Always-on skill playwright/);
});

test("skill settings expose frontmatter titles", () => {
  const adhd = parseSkillFrontmatter(`---\nname: i-have-adhd\ndescription: 'Shape output. Invoke with /i-have-adhd; stays on until "stop adhd mode".'\n---\n\n# Title\n`);
  assert.equal(adhd.title, "i-have-adhd");
  assert.match(adhd.description, /stop adhd mode/);
  const listed = listSkillSettings();
  const frontend = listed.find((skill) => skill.id === "frontend-design");
  assert.ok(frontend);
  assert.equal(frontend.title, "frontend-design");
  assert.ok(frontend.description.length > 20);
  assert.equal(frontend.alwaysOn, false);
  const alwaysOn = listed.find((skill) => skill.id === "i-have-adhd");
  assert.equal(alwaysOn?.alwaysOn, true);
  assert.equal(alwaysOn?.title, "i-have-adhd");
});

test("skills settings UI lists titles and always-on inside a collapsible", () => {
  const source = readFileSync(path.join(process.cwd(), "components", "skills-settings.tsx"), "utf8");
  assert.match(source, /skill\.title/);
  assert.match(source, /alwaysOnSkills/);
  assert.match(source, /Collapsible/);
  assert.match(source, /Always on/);
  assert.match(source, /CollapsibleTrigger/);
});
