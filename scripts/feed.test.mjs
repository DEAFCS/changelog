// Ported from 5stackgg/changelog scripts/feed.test.mjs (18fbb58) with
// 5Stack's permission.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFeed, conform, parseEntry } from "./feed.mjs";

const entry = [
  "# Thursday, October 29, 2026",
  "",
  "A big day: AMD GPU support and broad speed-ups.",
  "",
  "## New",
  "- **Self-hosting:** AMD GPU nodes can now run live streams.",
  "- **Leaderboards:** The event leaderboard has an ELO Gained tab",
  "  that ranks players by rating gained.",
  "",
  "## Fixed",
  "- **Seasons:** Tournament matches count toward the season.",
  "",
].join("\n");

// DEAFCS: the "# " heading is kept as the title.
test("parseEntry splits the title, the summary and the sections", () => {
  assert.deepEqual(parseEntry(entry), {
    title: "Thursday, October 29, 2026",
    summary: "A big day: AMD GPU support and broad speed-ups.",
    sections: {
      new: [
        { area: "Self-hosting", text: "AMD GPU nodes can now run live streams." },
        {
          area: "Leaderboards",
          text: "The event leaderboard has an ELO Gained tab that ranks players by rating gained.",
        },
      ],
      improved: [],
      fixed: [{ area: "Seasons", text: "Tournament matches count toward the season." }],
    },
  });
});

test("parseEntry drops sections it doesn't know and bullets without an area keep an empty one", () => {
  const parsed = parseEntry(
    ["Summary.", "## Notes", "- **Docs:** ignored", "## Improved", "- Faster pages."].join("\n"),
  );

  assert.equal(parsed.summary, "Summary.");
  assert.equal(parsed.title, undefined);
  assert.deepEqual(parsed.sections.improved, [{ area: "", text: "Faster pages." }]);
  assert.deepEqual(parsed.sections.new, []);
});

test("buildFeed groups days by month, newest first, and lists every area once", () => {
  const output = buildFeed([
    ["2026-10-29", entry],
    ["2026-11-01", "Quiet day.\n\n## Fixed\n- **Matches:** One fix."],
    ["2026-10-30", "Another day.\n\n## Improved\n- **Seasons:** Faster."],
  ]);
  const index = JSON.parse(output.get("index.json"));

  assert.deepEqual([...output.keys()], ["2026-11.json", "2026-10.json", "index.json"]);
  assert.deepEqual(
    index.months.map(({ month, days }) => ({ month, days })),
    [
      { month: "2026-11", days: 1 },
      { month: "2026-10", days: 2 },
    ],
  );
  assert.deepEqual(index.areas, ["Leaderboards", "Matches", "Seasons", "Self-hosting"]);
  assert.deepEqual(
    JSON.parse(output.get("2026-10.json")).days.map((day) => day.date),
    ["2026-10-30", "2026-10-29"],
  );
});

test("buildFeed hashes each month's exact bytes, so only a changed month gets a new hash", () => {
  const hashOf = (files, month) =>
    JSON.parse(buildFeed(files).get("index.json")).months.find((m) => m.month === month).hash;
  const before = [
    ["2026-10-29", entry],
    ["2026-11-01", "Quiet day.\n\n## Fixed\n- **Matches:** One fix."],
  ];
  const redone = [before[0], ["2026-11-01", "Quiet day.\n\n## Fixed\n- **Matches:** A fix."]];

  assert.match(hashOf(before, "2026-10"), /^[0-9a-f]{16}$/);
  assert.equal(hashOf(before, "2026-10"), hashOf(redone, "2026-10"));
  assert.notEqual(hashOf(before, "2026-11"), hashOf(redone, "2026-11"));
});

test("conform keeps the entry format and drops what the feed couldn't read", () => {
  const { markdown, dropped } = conform(
    [
      "A **big** day.",
      "",
      "## New",
      "- **Demos:** Anyone can upload demos.",
      "- **Demos**: colon outside the bold.",
      "- **HUD** text with **bold** inside",
      "### Extra heading",
      "",
      "## Notes",
      "- **Matches:** under an unknown heading.",
      "",
      "## Improved",
      "  - an indented bullet with no area",
      "",
      "## Fixed",
      "- **Seasons:** Tournament matches count.",
    ].join("\n"),
  );

  assert.equal(
    markdown,
    [
      "A big day.",
      "",
      "## New",
      "- **Demos:** Anyone can upload demos.",
      "",
      "## Fixed",
      "- **Seasons:** Tournament matches count.",
    ].join("\n"),
  );
  assert.equal(dropped, 6);
});
