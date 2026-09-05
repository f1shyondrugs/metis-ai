import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type ProductionSlot = ".next-a" | ".next-b";

export async function activateProductionSlot(root: string, slot: ProductionSlot) {
  const deployPath = path.join(root, ".deploy.env");
  let content = "";
  try { content = await readFile(deployPath, "utf8"); } catch { /* create it below */ }
  const line = `NEXT_DIST_DIR=${slot}`;
  const lines = content.split(/\\r?\\n/);
  const index = lines.findIndex((item) => /^NEXT_DIST_DIR=/.test(item));
  if (index >= 0) lines[index] = line;
  else lines.unshift(line);
  const next = `${lines.filter((item, itemIndex) => item || itemIndex < lines.length - 1).join("\\n").replace(/\\n*$/, "\\n")}`;
  const temp = `${deployPath}.incoming`;
  await writeFile(temp, next, { mode: 0o600 });
  await rename(temp, deployPath);
}
