import { readFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const RELEASE_MANIFEST_SCHEMA_VERSION = 1;
const SEMVER_VERSION = "\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?";
const SEMVER_TAG = new RegExp(`^v?(${SEMVER_VERSION})$`);

export type ReleaseChannel = "stable" | "prerelease" | "development";

export type ReleaseManifest = {
  schemaVersion: number;
  version: string;
  packageVersion: string;
  tag: string | null;
  commit: string | null;
  channel: ReleaseChannel;
  isRelease: boolean;
  builtAt: string;
};

export type ReleaseManifestInput = {
  packageVersion: string;
  releaseTag?: string | null;
  releaseVersion?: string | null;
  commit?: string | null;
  builtAt?: string;
};

export function normalizeReleaseTag(value: string | null | undefined): string | null {
  const candidate = value?.trim().replace(/^refs\/tags\//, "");
  if (!candidate) return null;
  const match = SEMVER_TAG.exec(candidate);
  return match ? `v${match[1]}` : null;
}

export function versionFromReleaseTag(tag: string): string {
  const match = SEMVER_TAG.exec(tag);
  if (!match) throw new Error(`Invalid release tag: ${tag}`);
  return match[1];
}

export function releaseChannelForTag(tag: string | null): ReleaseChannel {
  if (!tag) return "development";
  return versionFromReleaseTag(tag).includes("-") ? "prerelease" : "stable";
}

export function createReleaseManifest(input: ReleaseManifestInput): ReleaseManifest {
  const packageVersion = input.packageVersion.trim();
  if (!packageVersion) throw new Error("packageVersion is required");

  const tag = normalizeReleaseTag(input.releaseTag);
  const taggedVersion = tag ? versionFromReleaseTag(tag) : null;
  const version = (input.releaseVersion?.trim() || taggedVersion || packageVersion).replace(/^v/i, "");
  if (!SEMVER_TAG.test(version)) throw new Error(`Invalid release version: ${version}`);
  if (taggedVersion && taggedVersion !== version) {
    throw new Error(`Release tag ${tag} does not match release version ${version}`);
  }
  if (taggedVersion && packageVersion !== version) {
    throw new Error(`Release version ${version} does not match package version ${packageVersion}`);
  }

  return {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    version,
    packageVersion,
    tag,
    commit: input.commit?.trim() || null,
    channel: releaseChannelForTag(tag),
    isRelease: Boolean(tag),
    builtAt: input.builtAt || new Date().toISOString(),
  };
}

async function currentCommit(root: string): Promise<string | null> {
  const configured = process.env.METIS_RELEASE_COMMIT?.trim() || process.env.GITHUB_SHA?.trim();
  if (configured) return configured;
  try {
    const result = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root, timeout: 2_000 });
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function loadReleaseManifest(root: string): Promise<ReleaseManifest> {
  const distDir = process.env.NEXT_DIST_DIR || ".next";
  try {
    const manifestDir = path.isAbsolute(distDir) ? distDir : path.join(root, distDir);
    const raw = await readFile(path.join(manifestDir, "release-manifest.json"), "utf8");
    return JSON.parse(raw) as ReleaseManifest;
  } catch {
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { version?: unknown };
    const packageVersion = typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
    const configuredTag = process.env.METIS_RELEASE_TAG || process.env.GITHUB_REF_NAME || null;
    return createReleaseManifest({
      packageVersion,
      releaseTag: configuredTag,
      releaseVersion: process.env.METIS_RELEASE_VERSION,
      commit: await currentCommit(root),
    });
  }
}
