import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAgentCwd } from "@/lib/mcp";
import {
 isProjectLogoMime,
 MAX_PROJECT_FILE_BYTES,
 MAX_PROJECT_LOGO_BYTES,
 PROJECT_COLORS,
 PROJECT_ICONS,
} from "@/lib/project-constants";
import { getDatabase, parseData, transaction } from "@/lib/sqlite";
import { listChatsForUser } from "@/lib/db-store";
import type { ChatIndexEntry, Project, ProjectFile, SharedNote } from "@/lib/store";
import { decodeBase64Size, isTextAttachment, sanitizeFileName } from "@/lib/uploads";

const iso = () => new Date().toISOString();

export { PROJECT_COLORS, PROJECT_ICONS };

function clip(value: unknown, max: number) {
 return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function projectAssetsDir(projectId: string, ownerId?: string) {
 return path.join(getAgentCwd(ownerId), ".ai-chat-uploads", "projects", projectId);
}

function decodeBase64(data: string) {
 return Buffer.from(String(data || "").replace(/^data:[^;]+;base64,/, "").replace(/\s/g, ""), "base64");
}

function persistAsset(projectId: string, fileName: string, data: string | Buffer, ownerId?: string) {
 const dir = projectAssetsDir(projectId, ownerId);
 mkdirSync(dir, { recursive: true });
 const storedName = sanitizeFileName(fileName);
 if (!storedName || storedName.includes("..")) throw new Error("Invalid file name");
 writeFileSync(path.join(dir, storedName), Buffer.isBuffer(data) ? data : decodeBase64(data));
 return storedName;
}

function assetPath(projectId: string, storedName: string, ownerId?: string) {
 const base = path.basename(storedName);
 if (!base || base !== storedName || storedName.includes("..")) return null;
 return path.join(projectAssetsDir(projectId, ownerId), base);
}

function removeAsset(projectId: string, storedName: string | undefined, ownerId?: string) {
 if (!storedName) return;
 const full = assetPath(projectId, storedName, ownerId);
 if (full && existsSync(full)) unlinkSync(full);
}

function rowToProject(row: unknown): Project | null {
 const parsed = parseData<Project>(row);
 if (!parsed || typeof parsed.id !== "string") return null;
 return {
  id: parsed.id,
  ...(typeof parsed.ownerId === "string" ? { ownerId: parsed.ownerId } : {}),
  name: clip(parsed.name, 80) || "Untitled project",
  icon: PROJECT_ICONS.includes(parsed.icon as (typeof PROJECT_ICONS)[number]) ? parsed.icon : "folder",
  color: /^#[0-9a-f]{6}$/i.test(parsed.color || "") ? String(parsed.color) : PROJECT_COLORS[0],
  instructions: clip(parsed.instructions, 20_000),
  memoryMode: parsed.memoryMode === "project_only" ? "project_only" : "default",
  ...(parsed.logoMimeType && parsed.logoStoredName
   ? { logoMimeType: clip(parsed.logoMimeType, 120), logoStoredName: clip(parsed.logoStoredName, 160) }
   : {}),
  createdAt: parsed.createdAt || iso(),
  updatedAt: parsed.updatedAt || iso(),
 };
}

function rowToFile(row: unknown): ProjectFile | null {
 const parsed = parseData<ProjectFile>(row);
 if (!parsed || typeof parsed.id !== "string" || typeof parsed.projectId !== "string") return null;
 return {
  id: parsed.id,
  projectId: parsed.projectId,
  ...(typeof parsed.ownerId === "string" ? { ownerId: parsed.ownerId } : {}),
  name: clip(parsed.name, 200) || "file",
  mimeType: clip(parsed.mimeType, 120) || "text/plain",
  ...(parsed.text ? { text: clip(parsed.text, 200_000) } : {}),
  ...(parsed.storedName ? { storedName: clip(parsed.storedName, 160) } : {}),
  size: Math.max(0, Math.floor(Number(parsed.size) || 0)),
  createdAt: parsed.createdAt || iso(),
 };
}

function writeProject(project: Project) {
 getDatabase().prepare("UPDATE projects SET data = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(project), project.updatedAt, project.id);
 return project;
}

export function listProjects(ownerId?: string): Project[] {
 return getDatabase()
  .prepare("SELECT data FROM projects WHERE (? IS NULL OR owner_id = ?) ORDER BY updated_at DESC")
  .all(ownerId ?? null, ownerId ?? null)
  .map(rowToProject)
  .filter((item): item is Project => Boolean(item));
}

export function getProject(id: string, ownerId?: string): Project | null {
 if (!id.trim()) return null;
 return rowToProject(
  getDatabase().prepare("SELECT data FROM projects WHERE id = ? AND (? IS NULL OR owner_id = ?)").get(id, ownerId ?? null, ownerId ?? null),
 );
}

export function createProject(input: {
 name?: string;
 icon?: string;
 color?: string;
 instructions?: string;
 memoryMode?: Project["memoryMode"];
 ownerId?: string;
}): Project {
 const timestamp = iso();
 const count = listProjects(input.ownerId).length;
 const project: Project = {
  id: randomUUID(),
  ...(input.ownerId ? { ownerId: input.ownerId } : {}),
  name: clip(input.name, 80) || "New project",
  icon: PROJECT_ICONS.includes((input.icon || "") as (typeof PROJECT_ICONS)[number]) ? String(input.icon) : PROJECT_ICONS[count % PROJECT_ICONS.length],
  color: /^#[0-9a-f]{6}$/i.test(input.color || "") ? String(input.color) : PROJECT_COLORS[count % PROJECT_COLORS.length],
  instructions: clip(input.instructions, 20_000),
  memoryMode: input.memoryMode === "project_only" ? "project_only" : "default",
  createdAt: timestamp,
  updatedAt: timestamp,
 };
 getDatabase()
  .prepare("INSERT INTO projects (id, owner_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
  .run(project.id, project.ownerId ?? null, JSON.stringify(project), timestamp, timestamp);
 return project;
}

export function updateProject(
 id: string,
 patch: Partial<Pick<Project, "name" | "icon" | "color" | "instructions" | "memoryMode">>,
 ownerId?: string,
): Project | null {
 return transaction(() => {
  const current = getProject(id, ownerId);
  if (!current) return null;
  const timestamp = iso();
  const next: Project = {
   ...current,
   ...(patch.name !== undefined ? { name: clip(patch.name, 80) || current.name } : {}),
   ...(patch.icon && PROJECT_ICONS.includes(patch.icon as (typeof PROJECT_ICONS)[number]) ? { icon: patch.icon } : {}),
   ...(patch.color && /^#[0-9a-f]{6}$/i.test(patch.color) ? { color: patch.color } : {}),
   ...(patch.instructions !== undefined ? { instructions: clip(patch.instructions, 20_000) } : {}),
   ...(patch.memoryMode === "project_only" || patch.memoryMode === "default" ? { memoryMode: patch.memoryMode } : {}),
   updatedAt: timestamp,
  };
  return writeProject(next);
 });
}

export function setProjectLogo(
 id: string,
 input: { data: string; mimeType?: string },
 ownerId?: string,
): Project | null {
 const current = getProject(id, ownerId);
 if (!current) return null;
 const mime = clip(input.mimeType, 120).toLowerCase().split(";")[0]!.trim() || "image/png";
 if (!isProjectLogoMime(mime)) throw new Error("Logo must be a PNG, JPEG, WebP, GIF, or SVG image.");
 const size = decodeBase64Size(input.data);
 if (size <= 0 || size > MAX_PROJECT_LOGO_BYTES) {
  throw new Error(`Logo is too large (max ${MAX_PROJECT_LOGO_BYTES / 1024 / 1024}MB).`);
 }
 removeAsset(id, current.logoStoredName, ownerId);
 const ext = mime === "image/svg+xml" ? "svg" : mime.split("/")[1] === "jpeg" || mime === "image/jpg" ? "jpg" : mime.split("/")[1] || "png";
 const storedName = persistAsset(id, `logo-${randomUUID().slice(0, 8)}.${ext}`, input.data, ownerId);
 return writeProject({
  ...current,
  logoMimeType: mime === "image/jpg" ? "image/jpeg" : mime,
  logoStoredName: storedName,
  updatedAt: iso(),
 });
}

export function clearProjectLogo(id: string, ownerId?: string): Project | null {
 const current = getProject(id, ownerId);
 if (!current) return null;
 removeAsset(id, current.logoStoredName, ownerId);
 const next = { ...current, updatedAt: iso() };
 delete next.logoMimeType;
 delete next.logoStoredName;
 return writeProject(next);
}

export function readProjectLogo(id: string, ownerId?: string): { mimeType: string; buf: Buffer } | null {
 const project = getProject(id, ownerId);
 if (!project?.logoStoredName || !project.logoMimeType) return null;
 const full = assetPath(id, project.logoStoredName, ownerId);
 if (!full || !existsSync(full)) return null;
 return { mimeType: project.logoMimeType, buf: readFileSync(full) };
}

export function deleteProject(id: string, ownerId?: string) {
 return transaction(() => {
  const current = getProject(id, ownerId);
  if (!current) return null;
  const db = getDatabase();
  db.prepare("DELETE FROM project_files WHERE project_id = ?").run(id);
  db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    db.prepare("UPDATE automations SET project_id = NULL WHERE project_id = ?").run(id);
  rmSync(projectAssetsDir(id, ownerId), { recursive: true, force: true });
  const chatIds = listChatsForUser(ownerId, { includeArchived: true })
   .filter((chat) => chat.projectId === id)
   .map((chat) => chat.id);
  return { ok: true as const, chatIds };
 });
}

export function listProjectFiles(projectId: string, ownerId?: string): ProjectFile[] {
 if (!getProject(projectId, ownerId)) return [];
 return getDatabase()
  .prepare("SELECT data FROM project_files WHERE project_id = ? ORDER BY created_at DESC")
  .all(projectId)
  .map(rowToFile)
  .filter((item): item is ProjectFile => Boolean(item));
}

export function getProjectFile(projectId: string, fileId: string, ownerId?: string): ProjectFile | null {
 if (!getProject(projectId, ownerId)) return null;
 return rowToFile(
  getDatabase().prepare("SELECT data FROM project_files WHERE id = ? AND project_id = ?").get(fileId, projectId),
 );
}

export function readProjectFileBytes(
 projectId: string,
 fileId: string,
 ownerId?: string,
): { file: ProjectFile; buf: Buffer } | null {
 const file = getProjectFile(projectId, fileId, ownerId);
 if (!file) return null;
 if (file.storedName) {
  const full = assetPath(projectId, file.storedName, ownerId);
  if (!full || !existsSync(full)) return null;
  return { file, buf: readFileSync(full) };
 }
 return { file, buf: Buffer.from(file.text || "", "utf8") };
}

export function addProjectFile(input: {
 projectId: string;
 ownerId?: string;
 name: string;
 mimeType?: string;
 text?: string;
 data?: string;
 bytes?: Buffer | Uint8Array;
}): ProjectFile | null {
 if (!getProject(input.projectId, input.ownerId)) return null;
 const timestamp = iso();
 const name = sanitizeFileName(clip(input.name, 200) || "file");
 const rawBytes = input.bytes ? Buffer.from(input.bytes) : input.data ? decodeBase64(input.data) : null;
 const mimeType = clip(input.mimeType, 120) || (rawBytes ? "application/octet-stream" : "text/plain");
 let storedName: string | undefined;
 let text = clip(input.text, 200_000);
 let size = text.length;

 if (rawBytes) {
  if (rawBytes.length <= 0) throw new Error("Empty file");
  if (rawBytes.length > MAX_PROJECT_FILE_BYTES) {
   throw new Error(`File too large (max ${MAX_PROJECT_FILE_BYTES / 1024 / 1024}MB): ${name}`);
  }
  storedName = persistAsset(input.projectId, `${randomUUID().slice(0, 8)}-${name}`, rawBytes, input.ownerId);
  size = rawBytes.length;
  if (!text && isTextAttachment({ mimeType, name })) {
   try {
    text = clip(rawBytes.toString("utf8"), 200_000);
   } catch {
    text = "";
   }
  }
 }

 const file: ProjectFile = {
  id: randomUUID(),
  projectId: input.projectId,
  ...(input.ownerId ? { ownerId: input.ownerId } : {}),
  name,
  mimeType,
  ...(text ? { text } : {}),
  ...(storedName ? { storedName } : {}),
  size,
  createdAt: timestamp,
 };
 getDatabase()
  .prepare("INSERT INTO project_files (id, project_id, owner_id, name, mime_type, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
  .run(file.id, file.projectId, file.ownerId ?? null, file.name, file.mimeType, JSON.stringify(file), timestamp);
 getDatabase().prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(timestamp, input.projectId);
 return file;
}

export function deleteProjectFile(projectId: string, fileId: string, ownerId?: string) {
 const file = getProjectFile(projectId, fileId, ownerId);
 if (!file) return false;
 removeAsset(projectId, file.storedName, ownerId);
 return getDatabase().prepare("DELETE FROM project_files WHERE id = ? AND project_id = ?").run(fileId, projectId).changes > 0;
}

export function searchProjects(query: string, ownerId?: string): Project[] {
 const needle = query.trim().toLocaleLowerCase();
 if (!needle) return listProjects(ownerId);
 return listProjects(ownerId).filter((project) => `${project.name}\n${project.instructions}`.toLocaleLowerCase().includes(needle));
}

function listProjectNotes(projectId: string, ownerId?: string): SharedNote[] {
 return getDatabase()
  .prepare(
   `SELECT data FROM notes
    WHERE (? IS NULL OR owner_id = ?)
    AND archived = 0
    AND json_extract(data, '$.projectId') = ?
    ORDER BY updated_at DESC`,
  )
  .all(ownerId ?? null, ownerId ?? null, projectId)
  .map((row) => parseData<SharedNote>(row))
  .filter((note): note is SharedNote => Boolean(note?.id));
}

export function projectContextBlock(project: Project, ownerId?: string, chats?: ChatIndexEntry[]) {
 const files = listProjectFiles(project.id, ownerId);
 const notes = listProjectNotes(project.id, ownerId);
 const projectChats = (chats || listChatsForUser(ownerId)).filter((chat) => chat.projectId === project.id);
 return [
  `Active project: ${project.name}`,
  `Project instructions override the user's global custom instructions while this chat is in the project:\n${project.instructions || "(none)"}`,
  project.memoryMode === "project_only"
   ? "Memory mode is project_only: do not use global memories or personal context-hub facts. Stay inside this project's instructions, files, notes, and chats."
   : "Memory mode is default: global memories still apply, plus this project's files and notes.",
  files.length
   ? `Project files:\n${files.slice(0, 12).map((file) => `- ${file.name} (${file.mimeType})${file.text ? `\n${file.text.slice(0, 4_000)}` : ""}`).join("\n")}`
   : "Project files: (none)",
  notes.length
   ? `Project notes:\n${notes.slice(0, 16).map((note) => `- ${note.title || "Untitled"}:\n${(note.content || "").slice(0, 2_000)}`).join("\n\n")}`
   : "Project notes: (none)",
  projectChats.length
   ? `Other chats in this project:\n${projectChats.slice(0, 20).map((chat) => `- ${chat.title || "Untitled"} (${chat.id})`).join("\n")}`
   : "",
  "New notes created from this chat inherit this projectId. Do not create a canvas kind=project note in place of a sidebar project.",
 ].filter(Boolean).join("\n\n");
}
