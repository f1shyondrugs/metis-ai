import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "@/lib/config";
import type { GlobalModelSettings } from "@/lib/store";

export type SkillRecord = {
 id: string;
 source: string;
 sourceType: string;
 skillPath: string;
 computedHash: string;
};

type SkillsLock = {
 version?: number;
 skills?: Record<string, {
 source?: string;
 sourceType?: string;
 skillPath?: string;
 computedHash?: string;
 }>;
};

function lockPath() {
 return path.join(config.root, "skills-lock.json");
}

function resolvedSkillPath(id: string, configuredPath: string) {
 const candidates = [
 configuredPath,
 path.join(".agents", "skills", id, "SKILL.md"),
 path.join("skills", "manual", id, "SKILL.md"),
 path.join(".cursor", "skills", id, "SKILL.md"),
 path.join(".claude", "skills", id, "SKILL.md"),
 ].filter(Boolean);
 const root = path.resolve(config.root);
 for (const candidate of candidates) {
 const absolute = path.resolve(root, candidate);
 if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) continue;
 if (existsSync(absolute)) return path.relative(root, absolute);
 }
 return configuredPath;
}

export function listInstalledSkills(): SkillRecord[] {
 try {
 const lock = JSON.parse(readFileSync(lockPath(), "utf8")) as SkillsLock;
 return Object.entries(lock.skills || {}).map(([id, skill]) => ({
 id,
 source: skill.source || "",
 sourceType: skill.sourceType || "github",
 skillPath: resolvedSkillPath(id, skill.skillPath || ""),
 computedHash: skill.computedHash || "",
 }));
 } catch {
 return [];
 }
}

export function skillEnabled(id: string, settings?: GlobalModelSettings) {
 const flags = settings?.enabledSkills;
 if (!flags || !(id in flags)) return true;
 return flags[id] !== false;
}

export function enabledSkills(settings?: GlobalModelSettings): SkillRecord[] {
 return listInstalledSkills().filter((skill) => skillEnabled(skill.id, settings));
}

export function readSkillMarkdown(id: string) {
 const skill = listInstalledSkills().find((item) => item.id === id);
 if (!skill?.skillPath) return null;
 try {
 return readFileSync(path.join(config.root, skill.skillPath), "utf8").slice(0, 20_000);
 } catch {
 return null;
 }
}

export function addManualSkill(id: string, content: string): SkillRecord {
 const normalizedId = id.trim().toLowerCase();
 if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(normalizedId)) {
 throw new Error("Skill id must be 2-64 characters using letters, numbers, dots, hyphens, or underscores.");
 }
 if (!content.trim()) throw new Error("SKILL.md content is required.");
 const relativePath = path.join("skills", "manual", normalizedId, "SKILL.md");
 const absolutePath = path.join(config.root, relativePath);
 mkdirSync(path.dirname(absolutePath), { recursive: true });
 writeFileSync(absolutePath, content, "utf8");

 let lock: SkillsLock = { version: 1, skills: {} };
 try { lock = JSON.parse(readFileSync(lockPath(), "utf8")) as SkillsLock; } catch { /* create it below */ }
 lock.version = lock.version || 1;
 lock.skills = lock.skills || {};
 const record = {
 source: "manual",
 sourceType: "local",
 skillPath: relativePath,
 computedHash: createHash("sha256").update(content).digest("hex"),
 };
 lock.skills[normalizedId] = record;
 const temporary = `${lockPath()}.tmp-${process.pid}`;
 writeFileSync(temporary, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
 renameSync(temporary, lockPath());
 return { id: normalizedId, ...record };
}

export function skillsCatalogPrompt(settings?: GlobalModelSettings) {
 const skills = enabledSkills(settings);
 if (!skills.length) return "";
 return [
 "Installed skills (enabled in Settings → Agent → Skills). Read a listed SKILL.md with the read_file tool when the task matches; do not invent skills that are not listed.",
 skills.map((skill) => `- ${skill.id} (${skill.source}): ${skill.skillPath}`).join("\n"),
 ].join("\n");
}
