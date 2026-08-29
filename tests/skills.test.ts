import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  enabledSkills,
  listInstalledSkills,
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
