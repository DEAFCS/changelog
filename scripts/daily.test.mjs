import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { appendItems, copenhagenDate, readItems } from "./entry.mjs";
import { parseTrailers } from "./notes.mjs";
import { publish } from "./publish.mjs";
import { makeRecord, releaseId, validateRecord } from "./release.mjs";
import { parseArgs, writeRecord } from "./record-release.mjs";

const sha = (char) => char.repeat(40);
const digest = (char) => `sha256:${char.repeat(64)}`;

// A repository as it is right after setup: last production commits known,
// nothing published yet.
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "changelog-"));
  fs.mkdirSync(path.join(dir, "state"));
  fs.writeFileSync(
    path.join(dir, "state/releases.json"),
    JSON.stringify({ lastDeployed: { web: sha("a"), api: sha("b") }, processed: {} }),
  );
  return dir;
}

function record(dir, { web, api, at }) {
  return writeRecord(dir, { verified: true, verifiedAt: at, web, api }).record;
}

const read = (dir, file) => fs.readFileSync(path.join(dir, file), "utf8");
const json = (dir, file) => JSON.parse(read(dir, file));
const pending = (dir) => fs.readdirSync(path.join(dir, "releases/pending"));

// A fake GitHub: the commits between two production commits, by repository.
function github(ranges) {
  return async (url) => {
    const match = url.match(/\/repos\/DEAFCS\/([\w-]+)\/compare\/(\w+)\.\.\.(\w+)/);
    if (match) {
      const range = ranges[`${match[1]}:${match[2].slice(0, 1)}..${match[3].slice(0, 1)}`];
      if (range === "behind") {
        return { status: "behind", total_commits: 0, commits: [] };
      }
      return { status: "ahead", total_commits: (range ?? []).length, commits: range ?? [] };
    }
    return [];
  };
}

let counter = 0;
const commit = (message) => ({
  sha: `${++counter}`.padStart(7, "0"),
  parents: [{}],
  author: { login: "dev", type: "User" },
  commit: { message },
});

test("first, second and third release of a day build one entry without repeats", async () => {
  const dir = repo();
  const hub = github({
    "deafcs-web:a..c": [commit("feat(team): team info\n\nChangelog-New: Teams: Team pages show team info.")],
    "deafcs-web:c..d": [
      commit("fix(tournaments): region servers\n\nChangelog-Fixed: Tournaments: Region servers are picked correctly."),
      // The same item again, worded slightly differently.
      commit("feat(team): more team info\n\nChangelog-New: Teams: Team pages show the team info."),
    ],
    "api-deafcs:b..e": [commit("feat(match): faster scoreboard\n\nChangelog-Improved: Matches: The scoreboard loads faster.")],
  });

  record(dir, { web: { to: sha("c"), image: digest("1") }, at: "2026-10-31T10:00:00Z" });
  let report = await publish(dir, { github: hub });
  assert.deepEqual(report.processed.map(({ date, added }) => [date, added]), [["2026-10-31", 1]]);
  const file = "entries/2026/2026-10-31.md";
  assert.equal(read(dir, file), "# Patch Notes | October 31, 2026\n\n## New\n\n- **Teams:** Team pages show team info.\n");
  assert.deepEqual(json(dir, "feed/index.json").latest, { date: "2026-10-31", revision: 1 });

  record(dir, { web: { to: sha("d"), image: digest("2") }, at: "2026-10-31T11:00:00Z" });
  report = await publish(dir, { github: hub });
  assert.equal(report.added, 1);

  record(dir, { api: { to: sha("e"), image: digest("3") }, at: "2026-10-31T12:30:00Z" });
  await publish(dir, { github: hub });

  assert.equal(
    read(dir, file),
    [
      "# Patch Notes | October 31, 2026",
      "",
      "## New",
      "",
      "- **Teams:** Team pages show team info.",
      "",
      "## Improved",
      "",
      "- **Matches:** The scoreboard loads faster.",
      "",
      "## Fixed",
      "",
      "- **Tournaments:** Region servers are picked correctly.",
      "",
    ].join("\n"),
  );
  // Each addition is a new revision of the same day, so the page shows it as unread.
  assert.deepEqual(json(dir, "feed/index.json").latest, { date: "2026-10-31", revision: 3 });
  assert.equal(json(dir, "feed/2026-10.json").days.length, 1);
  assert.deepEqual(json(dir, "state/releases.json").lastDeployed, { web: sha("d"), api: sha("e") });
  assert.deepEqual(pending(dir), []);
});

test("a release already processed is skipped, and a second run changes nothing", async () => {
  const dir = repo();
  const hub = github({ "deafcs-web:a..c": [commit("x\n\nChangelog-New: Teams: Team info.")] });
  const first = record(dir, { web: { to: sha("c"), image: digest("1") }, at: "2026-10-31T10:00:00Z" });
  await publish(dir, { github: hub });
  const before = read(dir, "entries/2026/2026-10-31.md");

  // Recorded again (a retried release step): same digests, same ID.
  const again = record(dir, { web: { to: sha("c"), image: digest("1") }, at: "2026-10-31T10:05:00Z" });
  assert.equal(again.id, first.id);
  const report = await publish(dir, { github: hub });
  assert.deepEqual(report.skipped, [first.id]);
  assert.equal(read(dir, "entries/2026/2026-10-31.md"), before);
  assert.deepEqual(json(dir, "feed/index.json").latest.revision, 1);

  const idle = await publish(dir, { github: hub });
  assert.deepEqual([idle.processed, idle.skipped, idle.flagged], [[], [], []]);
});

test("releases recorded at the same time are all processed once, in deployment order", async () => {
  const dir = repo();
  const hub = github({
    "deafcs-web:a..c": [commit("x\n\nChangelog-New: Teams: Team info.")],
    "deafcs-web:c..d": [commit("y\n\nChangelog-Fixed: Tournaments: Region servers work.")],
  });
  // Written in the opposite order to when they were verified.
  record(dir, { web: { to: sha("d"), image: digest("2"), from: sha("c") }, at: "2026-10-31T10:01:00Z" });
  record(dir, { web: { to: sha("c"), image: digest("1") }, at: "2026-10-31T10:00:00Z" });
  const report = await publish(dir, { github: hub });
  assert.deepEqual(report.processed.map(({ added }) => added), [1, 1]);
  assert.equal(json(dir, "state/releases.json").lastDeployed.web, sha("d"));
  assert.equal(readItems(read(dir, "entries/2026/2026-10-31.md")).length, 2);
});

test("a run that starts again from a newer main loses nothing (the workflow's retry)", async () => {
  // Two runs began from the same main. Run 1 pushed first; run 2's push is
  // rejected, so the workflow resets to run 1's result and publishes again.
  const base = repo();
  const hub = github({
    "deafcs-web:a..c": [commit("x\n\nChangelog-New: Teams: Team info.")],
    "api-deafcs:b..e": [commit("y\n\nChangelog-Improved: Matches: Faster scoreboard.")],
  });
  record(base, { web: { to: sha("c"), image: digest("1") }, at: "2026-10-31T10:00:00Z" });
  const run1 = fs.mkdtempSync(path.join(os.tmpdir(), "run1-"));
  fs.cpSync(base, run1, { recursive: true });
  await publish(run1, { github: hub });

  // Meanwhile a second release was recorded on top of run 1's result.
  record(run1, { api: { to: sha("e"), image: digest("3") }, at: "2026-10-31T10:02:00Z" });
  await publish(run1, { github: hub });
  const items = readItems(read(run1, "entries/2026/2026-10-31.md"));
  assert.deepEqual(items.map(({ type }) => type), ["new", "improved"]);
  assert.equal(Object.keys(json(run1, "state/releases.json").processed).length, 2);
});

test("the day follows Copenhagen time, also across midnight and summer time", () => {
  assert.equal(copenhagenDate("2026-10-31T22:59:30Z"), "2026-10-31");
  assert.equal(copenhagenDate("2026-10-31T23:00:30Z"), "2026-11-01");
  assert.equal(copenhagenDate("2026-07-01T21:59:00Z"), "2026-07-01");
  assert.equal(copenhagenDate("2026-07-01T22:01:00Z"), "2026-07-02");
});

test("a release crossing midnight goes into the day it was verified", async () => {
  const dir = repo();
  const hub = github({ "deafcs-web:a..c": [commit("x\n\nChangelog-New: Teams: Team info.")] });
  record(dir, { web: { to: sha("c"), image: digest("1") }, at: "2026-10-31T23:03:00Z" });
  const report = await publish(dir, { github: hub });
  assert.equal(report.processed[0].date, "2026-11-01");
  assert.ok(fs.existsSync(path.join(dir, "entries/2026/2026-11-01.md")));
});

test("WEB-only and API-only releases move only their own side", async () => {
  const dir = repo();
  const hub = github({ "api-deafcs:b..e": [commit("y\n\nChangelog-Fixed: Matches: Fixed.")] });
  record(dir, { api: { to: sha("e"), image: digest("3") }, at: "2026-10-31T10:00:00Z" });
  await publish(dir, { github: hub });
  assert.deepEqual(json(dir, "state/releases.json").lastDeployed, { web: sha("a"), api: sha("e") });
});

test("unverified, incomplete or rolled-back releases are flagged, not guessed", async () => {
  const dir = repo();
  fs.mkdirSync(path.join(dir, "releases/pending"), { recursive: true });
  const write = (name, body) => fs.writeFileSync(path.join(dir, "releases/pending", name), body);

  const good = makeRecord({ web: { to: sha("c"), image: digest("1") }, verifiedAt: "2026-10-31T10:00:00Z" });
  write("failed.json", JSON.stringify({ ...good, verified: false }));
  write("short-commit.json", JSON.stringify({ ...good, web: { to: "2facca57" } }));
  write("bad-digest.json", JSON.stringify({ ...good, web: { to: sha("c"), image: "latest" } }));
  write("broken.json", "{not json");
  write("tampered.json", JSON.stringify({ ...good, web: { to: sha("e") } }));
  const rollback = makeRecord({ web: { to: sha("f") }, verifiedAt: "2026-10-31T11:00:00Z" });
  write("rollback.json", JSON.stringify(rollback));

  const report = await publish(dir, { github: github({ "deafcs-web:a..f": "behind" }) });
  assert.deepEqual(report.flagged.map(({ file }) => file).sort(), [
    "bad-digest.json",
    "broken.json",
    "failed.json",
    "rollback.json",
    "short-commit.json",
    "tampered.json",
  ]);
  assert.deepEqual(pending(dir), []);
  assert.equal(fs.readdirSync(path.join(dir, "releases/flagged")).length, 6);
  assert.equal(fs.existsSync(path.join(dir, "entries")), false);
  assert.match(json(dir, "releases/flagged/rollback.json").flagged.reason, /behind/);
  assert.deepEqual(json(dir, "state/releases.json").lastDeployed.web, sha("a"));

  const noPrevious = repo();
  fs.writeFileSync(path.join(noPrevious, "state/releases.json"), JSON.stringify({ lastDeployed: {}, processed: {} }));
  record(noPrevious, { web: { to: sha("c") }, at: "2026-10-31T10:00:00Z" });
  const missing = await publish(noPrevious, { github: github({}) });
  assert.match(missing.flagged[0].reason, /no previous production commit/);
});

test("a GitHub error keeps the release and later ones pending, and the next run publishes them", async () => {
  const dir = repo();
  const hub = github({
    "deafcs-web:a..c": [commit("x\n\nChangelog-New: Teams: Team info.")],
    "deafcs-web:c..d": [commit("y\n\nChangelog-Fixed: Matches: The scoreboard loads again.")],
  });
  record(dir, { web: { to: sha("c") }, at: "2026-10-31T10:00:00Z" });
  record(dir, { web: { to: sha("d") }, at: "2026-10-31T11:00:00Z" });
  let calls = 0;
  const flaky = async (url) => {
    if (url.includes("compare") && ++calls === 2) {
      throw new Error("GitHub request failed with status 502");
    }
    return hub(url);
  };
  const report = await publish(dir, { github: flaky });
  assert.equal(report.processed.length, 1);
  assert.match(report.failed.message, /502/);
  assert.equal(pending(dir).length, 1);
  assert.equal(json(dir, "state/releases.json").lastDeployed.web, sha("c"));

  const retry = await publish(dir, { github: hub });
  assert.equal(retry.added, 1);
  assert.deepEqual(pending(dir), []);
});

test("commit titles become notes only when they are clearly for players", async () => {
  const dir = repo();
  const hub = github({
    "deafcs-web:a..c": [
      commit("feat(match): server bar under the match header and instant Scoreboard handoff\n\nLong body about code."),
      commit("fix(tournaments): free agent sign-up date shows the full local time"),
      commit("perf(leaderboard): leaderboard pages load faster"),
      // Held: staff words, a non-player scope, free-form titles, too short.
      commit("feat(polls): Community Polls on the homepage and in Admin Settings"),
      commit("fix(auth): a role drop re-checks the open page"),
      commit("fix(web): restore header buttons"),
      commit("Count the Play queue per region group"),
      commit("feat(match): tweak"),
      commit("fix(match): logout closes chat sockets"),
      // Never a note: tests, chores, docs.
      commit("test(match): local demo"),
      commit("chore: bump"),
    ],
  });
  record(dir, { web: { to: sha("c") }, at: "2026-10-31T10:00:00Z" });
  const report = await publish(dir, { github: hub });
  assert.equal(
    read(dir, "entries/2026/2026-10-31.md"),
    [
      "# Patch Notes | October 31, 2026",
      "",
      "## New",
      "",
      "- **Matches:** Server bar under the match header and instant Scoreboard handoff.",
      "",
      "## Improved",
      "",
      "- **Leaderboards:** Leaderboard pages load faster.",
      "",
      "## Fixed",
      "",
      "- **Tournaments:** Free agent sign-up date shows the full local time.",
      "",
    ].join("\n"),
  );
  assert.equal(report.held, 6);
  const held = report.review[0].items.map(({ note }) => note);
  assert.ok(held.some((note) => note.includes("Admin Settings")));
  assert.ok(held.some((note) => note.includes("Count the Play queue")));
});

test("held notes never reach the public repository; only their count does", async () => {
  const dir = repo();
  const hub = github({
    "deafcs-web:a..c": [
      commit("fix(auth): sign-out now closes live connections"),
      commit("x\n\nChangelog-Fixed: Matches: Hasura now loads the scoreboard, see https://evil.example"),
      commit("x\n\nChangelog-Fixed: Matches: The scoreboard loads again."),
    ],
  });
  record(dir, { web: { to: sha("c") }, at: "2026-10-31T10:00:00Z" });
  const report = await publish(dir, { github: hub });
  assert.equal(report.added, 1);
  assert.equal(report.held, 2);

  const published = fs
    .readdirSync(dir, { recursive: true })
    .filter((file) => !fs.statSync(path.join(dir, file)).isDirectory())
    .map((file) => read(dir, file))
    .join("\n");
  assert.doesNotMatch(published, /sign-out|Hasura|evil/);
  assert.equal(Object.values(json(dir, "state/releases.json").processed)[0].held, 2);
});

test("a release with nothing for players is processed without an entry", async () => {
  const dir = repo();
  const hub = github({
    "deafcs-web:a..c": [commit("test(match): local demo"), commit("feat(ops): logs\n\nChangelog: skip")],
    "deafcs-web:c..d": [commit("chore(deps): bump")],
  });
  record(dir, { web: { to: sha("c") }, at: "2026-10-31T10:00:00Z" });
  record(dir, { web: { to: sha("d") }, at: "2026-10-31T11:00:00Z" });
  const report = await publish(dir, { github: hub });
  assert.deepEqual(report.processed.map(({ added }) => added), [0, 0]);
  assert.equal(report.held, 0);
  assert.equal(fs.existsSync(path.join(dir, "entries")), false);
  assert.deepEqual(json(dir, "state/days.json"), {});
  assert.equal(json(dir, "feed/index.json").latest, null);
});

test("a hand correction survives the next release, and removed items don't come back", async () => {
  const dir = repo();
  const hub = github({
    "deafcs-web:a..c": [
      commit("x\n\nChangelog-New: Teams: Team pages show team info.\nChangelog-Fixed: Matches: The scoreboard loads again."),
    ],
    "deafcs-web:c..d": [
      commit("y\n\nChangelog-Fixed: Matches: The scoreboard loads again.\nChangelog-Fixed: FAQ: Search finds answers."),
    ],
  });
  record(dir, { web: { to: sha("c"), image: digest("1") }, at: "2026-10-31T10:00:00Z" });
  await publish(dir, { github: hub });

  // Anders edits on GitHub: rewords the Teams item, removes the scoreboard
  // item and adds a note of his own.
  const file = path.join(dir, "entries/2026/2026-10-31.md");
  fs.writeFileSync(
    file,
    "# Patch Notes | October 31, 2026\n\nA busy day.\n\n## New\n\n- **Teams:** Team pages now show the roster and region.\n- **Events:** Halloween Cup sign-ups are open.\n",
  );
  // The correction alone (a push to entries/) syncs the state.
  const sync = await publish(dir, { github: hub });
  assert.equal(sync.processed.length, 0);
  assert.equal(json(dir, "feed/index.json").latest.revision, 2);

  record(dir, { web: { to: sha("d"), image: digest("2") }, at: "2026-10-31T12:00:00Z" });
  await publish(dir, { github: hub });
  assert.equal(
    fs.readFileSync(file, "utf8"),
    [
      "# Patch Notes | October 31, 2026",
      "",
      "A busy day.",
      "",
      "## New",
      "",
      "- **Teams:** Team pages now show the roster and region.",
      "- **Events:** Halloween Cup sign-ups are open.",
      "",
      "## Fixed",
      "",
      "- **FAQ:** Search finds answers.",
      "",
    ].join("\n"),
  );
  const days = json(dir, "state/days.json")["2026-10-31"];
  const scoreboard = Object.values(days.items).find(({ text }) => text.startsWith("The scoreboard"));
  assert.equal(scoreboard.status, "removed");
});

test("trailers are read strictly; anything else in a message is ignored", () => {
  assert.deepEqual(
    parseTrailers("feat: x\n\nChangelog-New: Teams: Team info.\nChangelog-Fixed: No area here.\nchangelog-improved:  FAQ:  Faster.\nChangelog-Secret: x"),
    {
      skip: false,
      items: [
        { type: "new", area: "Teams", text: "Team info." },
        { type: "fixed", area: "", text: "No area here." },
        { type: "improved", area: "FAQ", text: "Faster." },
      ],
    },
  );
  assert.equal(parseTrailers("fix: x\n\nChangelog: skip").skip, true);
});

test("trailer items with internal details or em dashes are dropped by the leak gate", async () => {
  const dir = repo();
  const hub = github({
    "deafcs-web:a..c": [
      commit(
        "x\n\nChangelog-Fixed: Matches: Hasura pods restart less.\nChangelog-Fixed: Matches: Fixed in 2facca57.\nChangelog-New: Teams: Faster — and nicer.\nChangelog-New: Teams: Team info.",
      ),
    ],
  });
  record(dir, { web: { to: sha("c"), image: digest("1") }, at: "2026-10-31T10:00:00Z" });
  const report = await publish(dir, { github: hub });
  assert.equal(report.held, 3);
  assert.equal(report.added, 1);
});

test("appendItems keeps everything already in the file and the section order", () => {
  const markdown = "# T\n\nSummary.\n\n## Fixed\n\n- **A:** one.\n";
  assert.equal(
    appendItems(markdown, "T", [
      { type: "new", area: "B", text: "two." },
      { type: "fixed", area: "C", text: "three." },
    ]),
    "# T\n\nSummary.\n\n## New\n\n- **B:** two.\n\n## Fixed\n\n- **A:** one.\n- **C:** three.\n",
  );
});

test("release records need verification and full commits, and IDs follow the commits", () => {
  const web = { to: sha("c") };
  assert.throws(() => writeRecord(repo(), { verified: false, verifiedAt: "2026-10-31T10:00:00Z", web }), /--verified/);
  assert.throws(
    () => writeRecord(repo(), { verified: true, verifiedAt: "2026-10-31T10:00:00Z", web: { to: "2facca57" } }),
    /full commit hash/,
  );
  assert.throws(() => writeRecord(repo(), { verified: true, verifiedAt: "2026-10-31 10:00", web }), /time zone/);
  // The image digest is optional and doesn't change the ID.
  assert.equal(releaseId({ web }), releaseId({ web: { ...web, image: digest("1") } }));
  assert.notEqual(releaseId({ web }), releaseId({ web: { to: sha("d") } }));
  assert.notEqual(releaseId({ web }), releaseId({ web, api: { to: sha("e") } }));
  assert.equal(validateRecord(makeRecord({ web, verifiedAt: "2026-10-31T10:00:00+01:00" })), null);

  const args = parseArgs(["--verified", "--web-to", sha("c"), "--verified-at", "2026-10-31T10:00:00Z", "--no-push"]);
  assert.deepEqual(args, {
    verified: true,
    push: false,
    verifiedAt: "2026-10-31T10:00:00Z",
    web: { to: sha("c"), image: undefined },
    api: null,
  });
});

test("a production commit GitHub doesn't know is flagged, and later releases still publish", async () => {
  const dir = repo();
  const hub = github({ "deafcs-web:a..d": [commit("x\n\nChangelog-New: Teams: Team info.")] });
  const unknownCommit = async (url) => {
    if (url.includes(`/compare/${sha("a")}...${sha("c")}`)) {
      throw new Error("GitHub request failed with status 404");
    }
    return hub(url);
  };
  record(dir, { web: { to: sha("c") }, at: "2026-10-31T10:00:00Z" });
  record(dir, { web: { to: sha("d") }, at: "2026-10-31T11:00:00Z" });
  const report = await publish(dir, { github: unknownCommit });
  assert.match(report.flagged[0].reason, /not on GitHub/);
  assert.equal(report.failed, null);
  assert.equal(report.added, 1);
  assert.equal(json(dir, "state/releases.json").lastDeployed.web, sha("d"));
});

test("a token without pull request access still publishes from the commit messages", async () => {
  const dir = repo();
  const hub = github({ "deafcs-web:a..c": [commit("x\n\nChangelog-New: Teams: Team info.")] });
  const contentsOnly = async (url) => {
    if (url.endsWith("/pulls")) {
      throw new Error("GitHub request failed with status 403");
    }
    return hub(url);
  };
  record(dir, { web: { to: sha("c") }, at: "2026-10-31T10:00:00Z" });
  const report = await publish(dir, { github: contentsOnly });
  assert.equal(report.added, 1);
  assert.equal(report.failed, null);
});

test("rewritten or unrelated histories are flagged with the reason, never skipped or misreported", async () => {
  for (const status of ["diverged", "behind"]) {
    const dir = repo();
    record(dir, { web: { to: sha("f") }, at: "2026-10-31T10:00:00Z" });
    const hub = async (url) => (url.includes("/compare/") ? { status, total_commits: 0, commits: [] } : []);
    const report = await publish(dir, { github: hub });
    assert.equal(report.processed.length, 0, status);
    assert.match(report.flagged[0].reason, new RegExp(`is ${status} of the previous one`));
    assert.equal(fs.existsSync(path.join(dir, "entries")), false);
    // The production commit stays at the last published one.
    assert.equal(json(dir, "state/releases.json").lastDeployed.web, sha("a"));
    assert.equal(Object.keys(json(dir, "state/releases.json").processed).length, 0);
  }
});

test("a WEB and an API commit about the same feature give one note, different changes stay apart", async () => {
  const dir = repo();
  const hub = github({
    "deafcs-web:a..c": [
      commit("feat(teams): Teams tab on profiles, roster history and roster rows in the team feed"),
      commit("feat(match): server bar under the match header"),
    ],
    "api-deafcs:b..e": [
      // Same feature as the WEB Teams note: dropped, kept for review.
      commit("feat(teams): roster history of who joined, left, was removed or disbanded"),
      // Same area, different change: kept.
      commit("feat(match): spectators see the scoreboard after a map ends"),
      // Same words but a fix, not a new feature: kept.
      commit("fix(teams): roster history no longer shows removed players twice"),
      // An explicit changelog line is never merged away.
      commit("x\n\nChangelog-New: Teams: Roster history shows who joined and left."),
    ],
  });
  record(dir, { web: { to: sha("c") }, api: { to: sha("e") }, at: "2026-10-31T10:00:00Z" });
  const report = await publish(dir, { github: hub });
  const items = readItems(read(dir, "entries/2026/2026-10-31.md")).map(({ area, text }) => `${area}: ${text}`);
  assert.deepEqual(items, [
    "Teams: Roster history shows who joined and left.",
    "Teams: Teams tab on profiles, roster history and roster rows in the team feed.",
    "Matches: Server bar under the match header.",
    "Matches: Spectators see the scoreboard after a map ends.",
    "Teams: Roster history no longer shows removed players twice.",
  ]);
  const merged = report.review[0].items.filter(({ reason }) => reason === "same feature as a WEB note");
  assert.equal(merged.length, 1);
  assert.match(merged[0].note, /who joined, left, was removed or disbanded/);
  // The release itself is tracked as usual.
  assert.equal(json(dir, "state/releases.json").lastDeployed.api, sha("e"));
});

test("sameFeature needs the same area, the same type and two feature words in common", async () => {
  const { sameFeature } = await import("./notes.mjs");
  const note = (type, area, text) => ({ type, area, text });
  assert.equal(sameFeature(note("new", "Teams", "Roster history on team pages"), note("new", "Teams", "Roster history of who left")), true);
  assert.equal(sameFeature(note("new", "Teams", "Roster history on team pages"), note("fixed", "Teams", "Roster history of who left")), false);
  assert.equal(sameFeature(note("new", "Teams", "Roster history"), note("new", "Matches", "Roster history")), false);
  // Generic words alone don't make two notes the same.
  assert.equal(sameFeature(note("new", "Matches", "Players see the new page"), note("new", "Matches", "Players see their new stats page")), false);
});

test("the read token is checked first: missing, expired or without access to a repository", async () => {
  const { checkAccess } = await import("./sources.mjs");
  assert.deepEqual(await checkAccess(async () => [], ""), ["GH_READ_TOKEN is not set"]);
  assert.deepEqual(await checkAccess(async () => [], "token"), []);

  const onlyWeb = async (url) => {
    if (url.includes("/api-deafcs/")) {
      throw new Error("GitHub request failed with status 404");
    }
    return [];
  };
  assert.deepEqual(await checkAccess(onlyWeb, "token"), [
    "GH_READ_TOKEN can't read the commits of DEAFCS/api-deafcs (status 404)",
  ]);

  const expired = async () => {
    throw new Error("GitHub request failed with status 401");
  };
  assert.equal((await checkAccess(expired, "token")).length, 2);
});
