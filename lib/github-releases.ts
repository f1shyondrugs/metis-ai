import { execFile } from "node:child_process";
import { readFile, mkdtemp, rm, writeFile, cp, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  loadReleaseManifest,
  normalizeReleaseTag,
  versionFromReleaseTag,
  type ReleaseManifest,
} from "@/lib/release-manifest";

const execFileAsync = promisify(execFile);
const RELEASE_URL = "https://api.github.com/repos/f1shyondrugs/metis-ai/releases/latest";
const USER_AGENT = "metis-ai-update-checker";
const cache: { etag?: string; release?: GithubRelease; checkedAt?: number } = {};
const CACHE_TTL_MS = 5 * 60_000;

export type GithubReleaseAsset = {
  name: string;
  browser_download_url: string;
  content_type?: string;
  size?: number;
};

export type GithubRelease = {
  tag_name: string;
  target_commitish?: string;
  name?: string;
  body?: string;
  html_url?: string;
  prerelease?: boolean;
  draft?: boolean;
  assets?: GithubReleaseAsset[];
};

export type UpdateStatus = "development" | "up-to-date" | "available";

export type UpdateCheck = {
  status: UpdateStatus;
  latestTag: string;
  currentRef: string;
  currentManifest: ReleaseManifest;
  updateAvailable: boolean;
  release: GithubRelease;
};

export async function fetchLatestRelease(fetcher: typeof fetch = fetch): Promise<GithubRelease> {
  const now = Date.now();
  if (cache.release && cache.checkedAt && now - cache.checkedAt < CACHE_TTL_MS) return cache.release;
  const headers: Record<string, string> = { "User-Agent": USER_AGENT, Accept: "application/vnd.github+json" };
  if (cache.etag) headers["If-None-Match"] = cache.etag;
  const response = await fetcher(RELEASE_URL, { headers, cache: "no-store" });
  if (response.status === 304 && cache.release) {
    cache.checkedAt = now;
    return cache.release;
  }
  if (!response.ok) throw new Error(`GitHub release lookup failed (${response.status}).`);
  const release = (await response.json()) as GithubRelease;
  if (!normalizeReleaseTag(release.tag_name)) throw new Error("GitHub returned a release without a valid SemVer tag.");
  if (release.draft || release.prerelease) throw new Error("GitHub returned a non-stable release for the stable channel.");
  cache.etag = response.headers.get("etag") || cache.etag;
  cache.release = release;
  cache.checkedAt = now;
  return release;
}

export async function resolveCurrentRef(root: string): Promise<string> {
  const configured = process.env.METIS_RELEASE_TAG?.trim();
  if (configured) return configured;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root, timeout: 2_000 });
    return stdout.trim();
  } catch {
    try {
      const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { version?: unknown };
      return typeof packageJson.version === "string" ? packageJson.version.trim() : "unknown";
    } catch {
      return "unknown";
    }
  }
}

function parseVersion(value: string) {
  const tag = normalizeReleaseTag(value);
  if (!tag) return null;
  const version = versionFromReleaseTag(tag);
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") || [],
  };
}

export function compareReleaseVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    const leftNumeric = /^\\d+$/.test(left);
    const rightNumeric = /^\\d+$/.test(right);
    if (leftNumeric && rightNumeric) return Number(left) > Number(right) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left > right ? 1 : -1;
  }
  return 0;
}

export function isReleaseNewer(release: GithubRelease, currentRef: string) {
  const current = currentRef.trim();
  const releaseTag = normalizeReleaseTag(release.tag_name);
  if (!releaseTag || !current || current === "unknown") return false;
  const currentTag = normalizeReleaseTag(current);
  if (currentTag) return compareReleaseVersions(releaseTag, currentTag) > 0;
  // A commit checkout is a development build. It is not safe to infer that a
  // stable release is newer without a versioned release marker.
  return false;
}

export async function checkForUpdate(root: string, fetcher?: typeof fetch): Promise<UpdateCheck> {
  const [release, currentManifest] = await Promise.all([
    fetchLatestRelease(fetcher),
    loadReleaseManifest(root),
  ]);
  const latestTag = normalizeReleaseTag(release.tag_name);
  if (!latestTag) throw new Error("Latest GitHub release has no valid SemVer tag.");
  const currentRef = currentManifest.tag || currentManifest.commit || "unknown";
  const updateAvailable = currentManifest.isRelease && compareReleaseVersions(latestTag, currentManifest.version) > 0;
  return {
    status: !currentManifest.isRelease ? "development" : updateAvailable ? "available" : "up-to-date",
    latestTag,
    currentRef,
    currentManifest,
    updateAvailable,
    release,
  };
}

export function releaseBundleAsset(release: GithubRelease) {
  const tag = normalizeReleaseTag(release.tag_name);
  if (!tag) return null;
  const expectedName = `metis-ai-${tag}.tar.gz`;
  return release.assets?.find((asset) => asset.name === expectedName) || null;
}

export async function prepareNativeReleaseUpdate(
  root: string,
  release: GithubRelease,
  activeSlot: ".next-a" | ".next-b",
  fetcher: typeof fetch = fetch,
) {
  const asset = releaseBundleAsset(release);
  if (!asset) throw new Error("The latest release does not contain the required native bundle asset.");
  const tag = normalizeReleaseTag(release.tag_name);
  if (!tag) throw new Error("The latest release does not have a valid SemVer tag.");
  const inactiveSlot = activeSlot === ".next-a" ? ".next-b" : ".next-a";
  const stage = await mkdtemp(path.join(os.tmpdir(), "metis-release-"));
  const archive = path.join(stage, asset.name);
  try {
    const response = await fetcher(asset.browser_download_url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/octet-stream" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Release bundle download failed (${response.status}).`);
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
    const source = path.join(stage, "source");
    await execFileAsync("mkdir", ["-p", source]);
    await execFileAsync("tar", ["-xzf", archive, "-C", source, "--strip-components=1"], { timeout: 60_000 });
    await execFileAsync(process.env.PNPM_BIN || "pnpm", ["install", "--frozen-lockfile"], {
      cwd: source,
      timeout: 15 * 60_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    await execFileAsync("bash", ["scripts/build-production-slot.sh", inactiveSlot], {
      cwd: source,
      env: {
        ...process.env,
        AI_CHAT_ROOT: source,
        METIS_RELEASE_TAG: tag,
        METIS_RELEASE_VERSION: versionFromReleaseTag(tag),
        METIS_RELEASE_COMMIT: release.target_commitish || "",
        NODE_ENV: "production",
      },
      timeout: 30 * 60_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const preparedSlot = path.join(root, inactiveSlot);
    const incomingSlot = `${preparedSlot}.incoming`;
    await rm(incomingSlot, { recursive: true, force: true });
    await cp(path.join(source, inactiveSlot), incomingSlot, { recursive: true });
    await rm(preparedSlot, { recursive: true, force: true });
    await rename(incomingSlot, preparedSlot);
    return { tag, activeSlot, preparedSlot: inactiveSlot, asset: asset.name };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
