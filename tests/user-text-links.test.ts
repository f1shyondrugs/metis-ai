import assert from "node:assert/strict";
import test from "node:test";
import { parseRichUserText } from "../lib/user-text-links";

test("markdown links hide raw brackets and keep internal workspace URLs", () => {
  const parts = parseRichUserText(
    "Sieh [Context Plan](workspace://plan/e38a7b08-17af-4a4c-9faf-e2fe41802989) und https://example.com/x",
  );
  assert.deepEqual(
    parts.filter((part) => part.kind === "link").map((part) => ({
      href: part.kind === "link" ? part.href : "",
      label: part.kind === "link" ? part.label : "",
    })),
    [
      {
        href: "workspace://plan/e38a7b08-17af-4a4c-9faf-e2fe41802989",
        label: "Context Plan",
      },
      { href: "https://example.com/x", label: "https://example.com/x" },
    ],
  );
  assert.equal(parts.filter((part) => part.kind === "text").some((part) => part.text.includes("[Context Plan]")), false);
});

test("mentions stay outside markdown links", () => {
  const parts = parseRichUserText("Hello @Notes and [Note](note://abc)", ["Notes"]);
  assert.equal(parts[1]?.kind, "mention");
  assert.equal(parts[1]?.text, "@Notes");
  assert.equal(parts[3]?.kind, "link");
  if (parts[3]?.kind === "link") assert.equal(parts[3].href, "note://abc");
});
