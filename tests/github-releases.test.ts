import assert from "node:assert/strict";
import test from "node:test";
import { compareReleaseVersions, isReleaseNewer, type GithubRelease } from "../lib/github-releases";

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
