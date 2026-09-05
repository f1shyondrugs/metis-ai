import assert from "node:assert/strict";
import test from "node:test";
import {
  createReleaseManifest,
  normalizeReleaseTag,
  releaseChannelForTag,
  versionFromReleaseTag,
} from "../lib/release-manifest";

test("normalizes only valid SemVer release tags", () => {
  assert.equal(normalizeReleaseTag("v1.2.3"), "v1.2.3");
  assert.equal(normalizeReleaseTag("refs/tags/1.2.3-beta.1"), "v1.2.3-beta.1");
  assert.equal(normalizeReleaseTag("main"), null);
  assert.equal(normalizeReleaseTag("v1.2"), null);
});

test("classifies stable, prerelease, and development builds", () => {
  assert.equal(releaseChannelForTag("v1.2.3"), "stable");
  assert.equal(releaseChannelForTag("v1.2.3-rc.1"), "prerelease");
  assert.equal(releaseChannelForTag(null), "development");
});

test("creates a stable manifest only when tag and package versions agree", () => {
  const manifest = createReleaseManifest({
    packageVersion: "1.2.3",
    releaseTag: "v1.2.3",
    commit: "abc123",
    builtAt: "2026-09-05T00:00:00.000Z",
  });
  assert.deepEqual(manifest, {
    schemaVersion: 1,
    version: "1.2.3",
    packageVersion: "1.2.3",
    tag: "v1.2.3",
    commit: "abc123",
    channel: "stable",
    isRelease: true,
    builtAt: "2026-09-05T00:00:00.000Z",
  });
  assert.equal(versionFromReleaseTag(manifest.tag!), "1.2.3");
});

test("development builds retain package version but are not releases", () => {
  const manifest = createReleaseManifest({ packageVersion: "1.2.3", commit: "abc123" });
  assert.equal(manifest.version, "1.2.3");
  assert.equal(manifest.channel, "development");
  assert.equal(manifest.isRelease, false);
  assert.equal(manifest.tag, null);
});

test("rejects a tag that disagrees with the package version", () => {
  assert.throws(
    () => createReleaseManifest({ packageVersion: "1.2.3", releaseTag: "v1.2.4" }),
    /does not match package version/,
  );
});
