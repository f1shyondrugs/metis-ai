import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import test from "node:test";
import { checkForUpdate, compareReleaseVersions, isReleaseNewer, type GithubRelease } from "../lib/github-releases";

const release = (tag: string, commit?: string): GithubRelease => ({
  tag_name: tag,
  target_commitish: commit,
});

test("a different release tag is treated as an available update", () => {
  assert.equal(isReleaseNewer(release("v1.4.0"), "v1.3.2"), true);
  assert.equal(isReleaseNewer(release("1.4.0"), "v1.4.0"), false);
  assert.equal(isReleaseNewer(release("v1.4.0", "abc123"), "abc123"), false);
});

test("unknown, commit, or empty current refs do not claim a stable update", () => {
  assert.equal(isReleaseNewer(release("v1.4.0"), "unknown"), false);
  assert.equal(isReleaseNewer(release("v1.4.0", "abc123"), "abc123"), false);
  assert.equal(isReleaseNewer(release("v1.4.0"), ""), false);
});

test("compares release versions instead of tag strings", () => {
  assert.equal(compareReleaseVersions("v1.10.0", "v1.9.9"), 1);
  assert.equal(compareReleaseVersions("v1.2.3", "v1.2.3"), 0);
  assert.equal(compareReleaseVersions("v1.2.3-rc.1", "v1.2.3"), -1);
  assert.equal(compareReleaseVersions("v1.2.4", "v1.2.3"), 1);
});

test("stable channel reports a release for a development checkout", async () => {
  const root = await mkdtemp(`${os.tmpdir()}/metis-update-test-`);
  const previousDistDir = process.env.NEXT_DIST_DIR;
  try {
    await mkdir(`${root}/.next`, { recursive: true });
    await writeFile(`${root}/package.json`, JSON.stringify({ version: "1.0.0" }));
    await writeFile(`${root}/.next/release-manifest.json`, JSON.stringify({
      schemaVersion: 1, version: "1.0.0", packageVersion: "1.0.0", tag: null,
      commit: "abc123", channel: "development", isRelease: false, builtAt: new Date().toISOString(),
    }));
    process.env.NEXT_DIST_DIR = ".next";
    const result = await checkForUpdate(root, async () => new Response(JSON.stringify({
      tag_name: "v1.0.0", name: "v1.0.0", draft: false, prerelease: false,
    }), { status: 200 }));
    assert.equal(result.status, "available");
    assert.equal(result.updateAvailable, true);
  } finally {
    if (previousDistDir === undefined) delete process.env.NEXT_DIST_DIR;
    else process.env.NEXT_DIST_DIR = previousDistDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("commit channel reports a newer master commit", async () => {
  const root = await mkdtemp(`${os.tmpdir()}/metis-update-test-`);
  const previousDistDir = process.env.NEXT_DIST_DIR;
  try {
    await mkdir(`${root}/.next`, { recursive: true });
    await writeFile(`${root}/package.json`, JSON.stringify({ version: "1.0.0" }));
    await writeFile(`${root}/.next/release-manifest.json`, JSON.stringify({
      schemaVersion: 1, version: "1.0.0", packageVersion: "1.0.0", tag: null,
      commit: "abc123", channel: "development", isRelease: false, builtAt: new Date().toISOString(),
    }));
    process.env.NEXT_DIST_DIR = ".next";
    const result = await checkForUpdate(root, async () => new Response(JSON.stringify({
      sha: "def456", html_url: "https://github.com/f1shyondrugs/metis-ai/commit/def456",
      commit: { message: "new work" },
    }), { status: 200 }), "commits");
    assert.equal(result.status, "commit-available");
    assert.equal(result.latestCommit, "def456");
    assert.equal(result.updateAvailable, true);
  } finally {
    if (previousDistDir === undefined) delete process.env.NEXT_DIST_DIR;
    else process.env.NEXT_DIST_DIR = previousDistDir;
    await rm(root, { recursive: true, force: true });
  }
});
