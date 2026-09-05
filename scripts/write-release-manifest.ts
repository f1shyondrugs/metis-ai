import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createReleaseManifest } from "../lib/release-manifest";

const execFileAsync = promisify(execFile);

async function currentCommit(root: string) {
  const configured = process.env.METIS_RELEASE_COMMIT?.trim() || process.env.GITHUB_SHA?.trim();
  if (configured) return configured;
  try {
    const result = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root, timeout: 2_000 });
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

async function main() {
  const root = process.cwd();
  const distDir = process.env.NEXT_DIST_DIR || ".next";
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { version?: unknown };
  const packageVersion = typeof packageJson.version === "string" ? packageJson.version : "";
  const releaseTag = process.env.METIS_RELEASE_TAG || process.env.GITHUB_REF_NAME || null;
  const manifest = createReleaseManifest({
    packageVersion,
    releaseTag,
    releaseVersion: process.env.METIS_RELEASE_VERSION || (releaseTag ? undefined : packageVersion),
    commit: await currentCommit(root),
  });

  const outputDir = path.isAbsolute(distDir) ? distDir : path.join(root, distDir);
  await writeFile(
    path.join(outputDir, "release-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  console.log(`Wrote ${distDir}/release-manifest.json for ${manifest.channel} ${manifest.version}`);
}

void main();
