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
const COMMIT_URL = "https://api.github.com/repos/f1shyondrugs/metis-ai/commits/master";
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

export type UpdateChannel = "releases" | "commits";
export type UpdateStatus = "development" | "up-to-date" | "available" | "commit-available";

export type GithubCommit = {
  sha: string;
  html_url?: string;
  commit?: { message?: string };
};

export type UpdateCheck = {
  channel: UpdateChannel;
  status: UpdateStatus;
  latestTag: string;
  latestCommit?: string;
  commitUrl?: string;
  commitMessage?: string;
  currentRef: string;
  currentManifest: ReleaseManifest;
  updateAvailable: boolean;
  release?: GithubRelease;
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

export async function fetchLatestCommit(fetcher: typeof fetch = fetch): Promise<GithubCommit> {
  const response = await fetcher(COMMIT_URL, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/vnd.github+json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`GitHub commit lookup failed (${response.status}).`);
  const commit = (await response.json()) as GithubCommit;
  if (!commit.sha) throw new Error("GitHub returned a commit without a SHA.");
  return commit;
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

export async function checkForUpdate(
  root: string,
  fetcher: typeof fetch = fetch,
  channel: UpdateChannel = "releases",
): Promise<UpdateCheck> {
  const currentManifest = await loadReleaseManifest(root);
  const currentRef = currentManifest.tag || currentManifest.commit || "unknown";
  if (channel === "commits") {
    const commit = await fetchLatestCommit(fetcher);
    const updateAvailable = Boolean(currentManifest.commit && commit.sha !== currentManifest.commit);
    return {
      channel,
      status: updateAvailable ? "commit-available" : "up-to-date",
      latestTag: currentManifest.tag || currentManifest.version,
      latestCommit: commit.sha,
      commitUrl: commit.html_url,
      commitMessage: commit.commit?.message,
      currentRef,
      currentManifest,
      updateAvailable,
    };
  }

  const release = await fetchLatestRelease(fetcher);
  const latestTag = normalizeReleaseTag(release.tag_name);
  if (!latestTag) throw new Error("Latest GitHub release has no valid SemVer tag.");
  const updateAvailable = !currentManifest.isRelease || compareReleaseVersions(latestTag, currentManifest.version) > 0;
  return {
    channel,
    status: updateAvailable ? "available" : "up-to-date",
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
  let operation = "starting native release update";
  try {
    operation = "downloading the verified release bundle";
    const response = await fetcher(asset.browser_download_url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/octet-stream" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Release bundle download failed (${response.status}).`);
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
    const source = path.join(stage, "source");
    operation = "creating the temporary update workspace";
    await execFileAsync("mkdir", ["-p", source]);
    operation = "extracting the release bundle";
    await execFileAsync("tar", ["-xzf", archive, "-C", source, "--strip-components=1"], { timeout: 60_000 });
    operation = "installing locked release dependencies";
    await execFileAsync(process.env.PNPM_BIN || "pnpm", ["install", "--frozen-lockfile"], {
      cwd: source,
      timeout: 15 * 60_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    operation = `building the inactive production slot ${inactiveSlot}`;
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
    operation = `installing the prepared ${inactiveSlot} slot`;
    const preparedSlot = path.join(root, inactiveSlot);
    const incomingSlot = `${preparedSlot}.incoming`;
    await rm(incomingSlot, { recursive: true, force: true });
    await cp(path.join(source, inactiveSlot), incomingSlot, { recursive: true });
    await rm(preparedSlot, { recursive: true, force: true });
    await rename(incomingSlot, preparedSlot);
    return { tag, activeSlot, preparedSlot: inactiveSlot, asset: asset.name };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stderr = error && typeof error === "object" && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr || "").trim()
      : "";
    throw new Error(`${operation} failed: ${message}${stderr ? ` — ${stderr.slice(-1200)}` : ""}`);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
