import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkProduction, decide, observe } from "./production.mjs";
import { publish } from "./publish.mjs";
import { makeRecord } from "./release.mjs";

const sha = (char) => char.repeat(40);
const urls = { web: "https://deafcs.example/api/version", api: "https://api.deafcs.example/system/version" };

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "production-"));
  fs.mkdirSync(path.join(dir, "state"));
  fs.writeFileSync(
    path.join(dir, "state/releases.json"),
    JSON.stringify({ lastDeployed: { web: sha("a"), api: sha("b") }, processed: {} }),
  );
  return dir;
}

// A fake deafcs.net: what each version endpoint answers right now.
function site(answers) {
  return async (url) => {
    const answer = answers[url.includes("api.") ? "api" : "web"];
    if (answer instanceof Error) {
      throw answer;
    }
    if (answer === 503) {
      return { ok: false, json: async () => ({}) };
    }
    return { ok: true, json: async () => ({ commit: answer }) };
  };
}

const at = (minute) => new Date(Date.parse("2026-10-31T15:00:00Z") + minute * 60_000);
const pending = (dir) =>
  fs.existsSync(path.join(dir, "releases/pending")) ? fs.readdirSync(path.join(dir, "releases/pending")) : [];

test("a new commit counts as released only after 10 minutes live", async () => {
  const dir = repo();
  const answers = { web: sha("c"), api: sha("b") };
  for (const minute of [0, 5, 9]) {
    const { record } = await checkProduction(dir, { urls, fetcher: site(answers), now: at(minute) });
    assert.equal(record, null, `minute ${minute}`);
  }
  const { record } = await checkProduction(dir, { urls, fetcher: site(answers), now: at(10) });
  assert.deepEqual(record.web, { to: sha("c") });
  assert.equal(record.api, undefined);
  assert.equal(record.verifiedAt, "2026-10-31T15:10:00Z");
  assert.deepEqual(pending(dir), [`${record.id}.json`]);
});

test("a release replaced or rolled back inside the window is never recorded", async () => {
  const dir = repo();
  await checkProduction(dir, { urls, fetcher: site({ web: sha("c"), api: sha("b") }), now: at(0) });
  // Rolled back to the published commit after 5 minutes.
  await checkProduction(dir, { urls, fetcher: site({ web: sha("a"), api: sha("b") }), now: at(5) });
  const { record } = await checkProduction(dir, { urls, fetcher: site({ web: sha("a"), api: sha("b") }), now: at(20) });
  assert.equal(record, null);
  assert.deepEqual(pending(dir), []);

  // Two quick releases in a row: only the one that stayed is recorded.
  await checkProduction(dir, { urls, fetcher: site({ web: sha("c"), api: sha("b") }), now: at(30) });
  await checkProduction(dir, { urls, fetcher: site({ web: sha("d"), api: sha("b") }), now: at(35) });
  const later = await checkProduction(dir, { urls, fetcher: site({ web: sha("d"), api: sha("b") }), now: at(45) });
  assert.deepEqual(later.record.web, { to: sha("d") });
});

test("WEB and API released together become one record", async () => {
  const dir = repo();
  const answers = { web: sha("c"), api: sha("e") };
  await checkProduction(dir, { urls, fetcher: site(answers), now: at(0) });
  await checkProduction(dir, { urls, fetcher: site({ web: sha("c"), api: sha("e") }), now: at(3) });
  const { record } = await checkProduction(dir, { urls, fetcher: site(answers), now: at(13) });
  assert.deepEqual([record.web, record.api], [{ to: sha("c") }, { to: sha("e") }]);
});

test("a site that is down never settles, and a build without its commit is reported", async () => {
  const dir = repo();
  await checkProduction(dir, { urls, fetcher: site({ web: sha("c"), api: sha("b") }), now: at(0) });
  const down = await checkProduction(dir, { urls, fetcher: site({ web: 503, api: new Error("timeout") }), now: at(15) });
  assert.equal(down.record, null);
  assert.deepEqual(down.problems, ["web: no answer from the version endpoint", "api: no answer from the version endpoint"]);

  const unknown = await checkProduction(dir, { urls, fetcher: site({ web: "unknown", api: sha("b") }), now: at(20) });
  assert.equal(unknown.record, null);
  assert.match(unknown.problems[0], /doesn't report a full commit/);
});

test("the published commit is never recorded again", () => {
  const answer = (commit) => ({ answered: true, commit });
  const { state, problems } = observe({}, { web: answer(sha("a")), api: answer(sha("b")) }, at(0));
  assert.deepEqual(problems, []);
  assert.equal(state.web.commit, sha("a"));
  assert.equal(decide(state, { web: sha("a"), api: sha("b") }, ["web", "api"], at(60)), null);
});

test("deploy, verified, published: the whole path, and recording by hand gives the same release", async () => {
  const dir = repo();
  const answers = { web: sha("c"), api: sha("b") };
  await checkProduction(dir, { urls, fetcher: site(answers), now: at(0) });
  const { record } = await checkProduction(dir, { urls, fetcher: site(answers), now: at(12) });
  assert.equal(record.id, makeRecord({ web: { to: sha("c") }, verifiedAt: "2026-10-31T15:00:00Z" }).id);

  const github = async (url) =>
    url.includes("/compare/")
      ? {
          status: "ahead",
          total_commits: 1,
          commits: [
            {
              sha: "1",
              parents: [{}],
              author: { login: "theft", type: "User" },
              commit: { message: "feat(teams): team pages show the roster history" },
            },
          ],
        }
      : [];
  const report = await publish(dir, { github });
  assert.equal(report.added, 1);
  assert.equal(
    fs.readFileSync(path.join(dir, "entries/2026/2026-10-31.md"), "utf8"),
    "# Patch Notes | October 31, 2026\n\n## New\n\n- **Teams:** Team pages show the roster history.\n",
  );

  // The next check sees the same production: nothing new.
  const next = await checkProduction(dir, { urls, fetcher: site(answers), now: at(30) });
  assert.equal(next.record, null);
});

test("two releases within 10 minutes: the second one carries the first one's changes", async () => {
  const dir = repo();
  // Theft deploys commit c, then 4 minutes later commit d on top of it.
  await checkProduction(dir, { urls, fetcher: site({ web: sha("c"), api: sha("b") }), now: at(0) });
  await checkProduction(dir, { urls, fetcher: site({ web: sha("d"), api: sha("b") }), now: at(4) });
  const { record } = await checkProduction(dir, { urls, fetcher: site({ web: sha("d"), api: sha("b") }), now: at(14) });
  assert.deepEqual(record.web, { to: sha("d") });

  // Publishing reads every commit from the last published one (a) to d, so
  // c's change is in the same day's notes, nothing is lost.
  const message = (sha1, text) => ({ sha: sha1, parents: [{}], author: { login: "theft", type: "User" }, commit: { message: text } });
  const github = async (url) =>
    url.includes(`/compare/${sha("a")}...${sha("d")}`)
      ? {
          status: "ahead",
          total_commits: 2,
          commits: [
            message("1", "x\n\nChangelog-New: Teams: Team pages show the roster history."),
            message("2", "fix(tournaments): region servers are picked correctly in tournaments"),
          ],
        }
      : [];
  const report = await publish(dir, { github });
  assert.equal(report.added, 2);
});

test("a check without a usable answer restarts the 10 minutes", async () => {
  const dir = repo();
  await checkProduction(dir, { urls, fetcher: site({ web: sha("c"), api: sha("b") }), now: at(0) });
  await checkProduction(dir, { urls, fetcher: site({ web: 503, api: sha("b") }), now: at(5) });
  const early = await checkProduction(dir, { urls, fetcher: site({ web: sha("c"), api: sha("b") }), now: at(10) });
  assert.equal(early.record, null);
  const later = await checkProduction(dir, { urls, fetcher: site({ web: sha("c"), api: sha("b") }), now: at(20) });
  assert.deepEqual(later.record.web, { to: sha("c") });
});

test("an image built without its commit is reported, never recorded", async () => {
  const dir = repo();
  for (const minute of [0, 10, 20]) {
    const { record, problems } = await checkProduction(dir, {
      urls,
      fetcher: site({ web: null, api: sha("b") }),
      now: at(minute),
    });
    assert.equal(record, null);
    assert.deepEqual(problems, ["web: production doesn't report a full commit (none)"]);
  }
  assert.deepEqual(pending(dir), []);
});

test("an endpoint without a usable answer for 30 minutes fails the run; a short blip doesn't", async () => {
  const dir = repo();
  await checkProduction(dir, { urls, fetcher: site({ web: sha("a"), api: sha("b") }), now: at(0) });
  const blip = await checkProduction(dir, { urls, fetcher: site({ web: 503, api: sha("b") }), now: at(10) });
  assert.deepEqual(blip.outages, []);
  const back = await checkProduction(dir, { urls, fetcher: site({ web: sha("a"), api: sha("b") }), now: at(20) });
  assert.deepEqual(back.outages, []);

  for (const minute of [30, 40, 50]) {
    const { outages } = await checkProduction(dir, { urls, fetcher: site({ web: sha("a"), api: new Error("down") }), now: at(minute) });
    assert.deepEqual(outages, minute >= 60 ? ["api"] : []);
  }
  const long = await checkProduction(dir, { urls, fetcher: site({ web: sha("a"), api: new Error("down") }), now: at(60) });
  assert.deepEqual(long.outages, ["api"]);
  // An HTML page instead of the JSON answer (an old build) counts as unusable too.
  const html = { ok: true, json: async () => { throw new SyntaxError("Unexpected token <"); } };
  const old = await checkProduction(dir, { urls, fetcher: async () => html, now: at(100) });
  assert.deepEqual(old.outages, ["api"]);
});

test("the state changes once a day, so the schedule never goes 60 days without a commit", async () => {
  const dir = repo();
  const fetcher = site({ web: sha("a"), api: sha("b") });
  const file = path.join(dir, "state/production.json");
  await checkProduction(dir, { urls, fetcher, now: new Date("2026-11-01T08:00:00Z") });
  const morning = fs.readFileSync(file, "utf8");
  await checkProduction(dir, { urls, fetcher, now: new Date("2026-11-01T20:00:00Z") });
  assert.equal(fs.readFileSync(file, "utf8"), morning, "no change within the same day");
  await checkProduction(dir, { urls, fetcher, now: new Date("2026-11-02T00:03:00Z") });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).checkedOn, "2026-11-02");

  // The feed says when production was last checked.
  const { writeFeed } = await import("./feed.mjs");
  writeFeed(dir);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "feed/index.json"), "utf8")).monitoredOn, "2026-11-02");
});

test("the monitoring date only moves on a successful check, not when a run just started", async () => {
  const dir = repo();
  const file = path.join(dir, "state/production.json");
  const checkedOn = () => JSON.parse(fs.readFileSync(file, "utf8")).checkedOn;

  await checkProduction(dir, { urls, fetcher: site({ web: sha("a"), api: sha("b") }), now: new Date("2026-11-01T08:00:00Z") });
  assert.equal(checkedOn(), "2026-11-01");

  // Next day: API down, WEB built without its commit, or an old HTML page.
  for (const answers of [{ web: sha("a"), api: 503 }, { web: null, api: sha("b") }, { web: sha("a"), api: new Error("down") }]) {
    await checkProduction(dir, { urls, fetcher: site(answers), now: new Date("2026-11-02T08:00:00Z") });
    assert.equal(checkedOn(), "2026-11-01");
  }

  await checkProduction(dir, { urls, fetcher: site({ web: sha("a"), api: sha("b") }), now: new Date("2026-11-02T08:10:00Z") });
  assert.equal(checkedOn(), "2026-11-02");
});
