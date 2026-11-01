import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { publish } from "./publish.mjs";
import { writeRecord } from "./record-release.mjs";
import { issueTitle, issuesClient, syncReview } from "./review.mjs";

const sha = (char) => char.repeat(40);

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-"));
  fs.mkdirSync(path.join(dir, "state"));
  fs.writeFileSync(
    path.join(dir, "state/releases.json"),
    JSON.stringify({ lastDeployed: { web: sha("a"), api: sha("b") }, processed: {} }),
  );
  return dir;
}

const read = (dir, file) => fs.readFileSync(path.join(dir, file), "utf8");
const queue = (dir) => JSON.parse(read(dir, "state/review.json"));
const everyFile = (dir) =>
  fs
    .readdirSync(dir, { recursive: true })
    .map((file) => path.join(dir, file))
    .filter((file) => fs.statSync(file).isFile())
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");

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

// A fake private review repository: issues by title. `fail` makes every call
// answer with that HTTP status, like an expired token.
function reviewRepo() {
  const issues = [];
  const repoState = { issues, fail: null, calls: 0 };
  const fetcher = async (url, { method = "GET", body } = {}) => {
    repoState.calls++;
    if (repoState.fail) {
      return { ok: false, status: repoState.fail, json: async () => ({}) };
    }
    if (method === "POST") {
      const { title, body: text } = JSON.parse(body);
      const number = issues.length + 1;
      issues.push({ number, title, body: text });
      return { ok: true, status: 201, json: async () => ({ number }) };
    }
    const page = Number(new URL(url).searchParams.get("page"));
    return { ok: true, status: 200, json: async () => (page === 1 ? issues.map(({ number, title }) => ({ number, title })) : []) };
  };
  return { repoState, client: issuesClient("token", fetcher) };
}

const HELD_WEB = "feat(search): pages, players and help in one search box";
const HELD_API = "Rework the internal queue workers";
const hub = github({
  "deafcs-web:a..c": [
    commit("feat(teams): roster history\n\nChangelog-New: Teams: Team pages show a roster history."),
    commit(HELD_WEB),
  ],
  "api-deafcs:b..d": [commit(`feat(matchmaking): ${HELD_API}`)],
  "deafcs-web:c..e": "behind",
});

async function processRelease(dir, { web, api, at }) {
  writeRecord(dir, { verified: true, verifiedAt: at, web, api });
  return publish(dir, { github: hub });
}

test("held notes are queued with their commit ranges, never their text", async () => {
  const dir = repo();
  const report = await processRelease(dir, { web: { to: sha("c") }, api: { to: sha("d") }, at: "2026-11-01T12:00:00Z" });
  assert.equal(report.added, 1);
  assert.equal(report.held, 2);
  const [[id, entry]] = Object.entries(queue(dir).releases);
  assert.deepEqual(entry, {
    date: "2026-11-01",
    verifiedAt: "2026-11-01T12:00:00Z",
    ranges: [
      { side: "web", from: sha("a"), to: sha("c") },
      { side: "api", from: sha("b"), to: sha("d") },
    ],
    held: 2,
    issue: null,
  });
  assert.ok(JSON.parse(read(dir, "state/releases.json")).processed[id]);
  const files = everyFile(dir);
  assert.ok(!files.includes("pages, players and help"));
  assert.ok(!files.includes("queue workers"));
});

test("without REVIEW_TOKEN nothing is lost: the run fails once, then warns until more releases wait", async () => {
  const dir = repo();
  await processRelease(dir, { web: { to: sha("c") }, at: "2026-11-01T12:00:00Z" });

  let report = await syncReview(dir, { github: hub, issues: null });
  assert.deepEqual([report.open, report.alert, report.problem], [1, true, "REVIEW_TOKEN is not set"]);
  report = await syncReview(dir, { github: hub, issues: null });
  assert.deepEqual([report.open, report.alert], [1, false]);

  // A second release with held notes alerts again.
  await processRelease(dir, { api: { to: sha("d") }, at: "2026-11-01T13:00:00Z" });
  report = await syncReview(dir, { github: hub, issues: null });
  assert.deepEqual([report.open, report.alert], [2, true]);
  assert.equal(Object.values(queue(dir).releases).filter((entry) => !entry.issue).length, 2);
});

test("enabling REVIEW_TOKEN after the releases were processed recovers every held note, once", async () => {
  const dir = repo();
  await processRelease(dir, { web: { to: sha("c") }, at: "2026-11-01T12:00:00Z" });
  await processRelease(dir, { api: { to: sha("d") }, at: "2026-11-01T13:00:00Z" });
  await syncReview(dir, { github: hub, issues: null });

  const { repoState, client } = reviewRepo();
  let report = await syncReview(dir, { github: hub, issues: client, runUrl: "https://run" });
  assert.equal(report.issued.length, 2);
  assert.equal(report.open, 0);
  assert.equal(queue(dir).alerted, null);
  const bodies = repoState.issues.map(({ body }) => body).join("\n");
  assert.ok(bodies.includes("pages, players and help in one search box"), "web note recalculated");
  assert.ok(bodies.includes("queue workers"), "api note recalculated");
  assert.ok(bodies.includes("entries/2026/2026-11-01.md"));
  assert.deepEqual(
    Object.values(queue(dir).releases).map((entry) => entry.issue).sort(),
    [1, 2],
  );

  // Later runs make no new issues.
  report = await syncReview(dir, { github: hub, issues: client });
  assert.deepEqual([report.issued.length, report.reused.length, repoState.issues.length], [0, 0, 2]);
});

test("a run that made the issue but lost its state reuses the issue", async () => {
  const dir = repo();
  await processRelease(dir, { web: { to: sha("c") }, at: "2026-11-01T12:00:00Z" });
  const before = read(dir, "state/review.json");
  const { repoState, client } = reviewRepo();
  await syncReview(dir, { github: hub, issues: client });
  assert.equal(repoState.issues.length, 1);

  // The push failed: the next attempt starts again from main without the issue number.
  fs.writeFileSync(path.join(dir, "state/review.json"), before);
  const report = await syncReview(dir, { github: hub, issues: client });
  assert.deepEqual([report.issued.length, report.reused.length, repoState.issues.length], [0, 1, 1]);
  assert.equal(Object.values(queue(dir).releases)[0].issue, 1);
});

test("an expired REVIEW_TOKEN keeps the queue, fails once, and recovers when renewed", async () => {
  const dir = repo();
  await processRelease(dir, { web: { to: sha("c") }, at: "2026-11-01T12:00:00Z" });
  const { repoState, client } = reviewRepo();
  repoState.fail = 401;

  let report = await syncReview(dir, { github: hub, issues: client });
  assert.deepEqual([report.open, report.alert], [1, true]);
  assert.match(report.problem, /status 401/);
  report = await syncReview(dir, { github: hub, issues: client });
  assert.deepEqual([report.open, report.alert], [1, false]);

  repoState.fail = null;
  report = await syncReview(dir, { github: hub, issues: client });
  assert.deepEqual([report.open, report.issued.length, repoState.issues.length], [0, 1, 1]);
  assert.equal(queue(dir).alerted, null);
});

test("a review failure leaves the published notes and feed as they are", async () => {
  const dir = repo();
  await processRelease(dir, { web: { to: sha("c") }, at: "2026-11-01T12:00:00Z" });
  const entry = read(dir, "entries/2026/2026-11-01.md");
  const feed = read(dir, "feed/index.json");
  const days = read(dir, "state/days.json");
  const { repoState, client } = reviewRepo();
  repoState.fail = 500;
  const report = await syncReview(dir, { github: hub, issues: client });
  assert.equal(report.alert, true);
  assert.equal(read(dir, "entries/2026/2026-11-01.md"), entry);
  assert.ok(entry.includes("Team pages show a roster history."));
  assert.equal(read(dir, "feed/index.json"), feed);
  assert.equal(read(dir, "state/days.json"), days);
});

test("the public log of a review run names releases and counts, never held text", async () => {
  const dir = repo();
  await processRelease(dir, { web: { to: sha("c") }, api: { to: sha("d") }, at: "2026-11-01T12:00:00Z" });
  const { client } = reviewRepo();
  const report = await syncReview(dir, { github: hub, issues: client });
  const logged = JSON.stringify(report);
  assert.ok(!logged.includes("pages, players and help"));
  assert.ok(!logged.includes("queue workers"));
  const missing = await syncReview(repo(), { github: hub, issues: null });
  assert.ok(!JSON.stringify(missing).includes("search box"));
});

test("a dry run reads the review repository but creates and saves nothing", async () => {
  const dir = repo();
  await processRelease(dir, { web: { to: sha("c") }, at: "2026-11-01T12:00:00Z" });
  const before = read(dir, "state/review.json");
  const { repoState, client } = reviewRepo();
  const report = await syncReview(dir, { github: hub, issues: client, dryRun: true });
  assert.equal(report.issued.length, 1);
  assert.equal(repoState.issues.length, 0);
  assert.equal(read(dir, "state/review.json"), before);
});

test("a flagged release gets one review issue with its reason", async () => {
  const dir = repo();
  await processRelease(dir, { web: { to: sha("c") }, at: "2026-11-01T12:00:00Z" });
  const report = await processRelease(dir, { web: { to: sha("e") }, at: "2026-11-01T13:00:00Z" });
  assert.equal(report.flagged.length, 1);
  const { repoState, client } = reviewRepo();
  await syncReview(dir, { github: hub, issues: client });
  await syncReview(dir, { github: hub, issues: client });
  const flagged = repoState.issues.filter(({ title }) => title.startsWith("Changelog review: flagged "));
  assert.equal(flagged.length, 1);
  assert.match(flagged[0].body, /Reason: .+/);
});

test("a held note published by hand is never added twice, and the release is not processed twice", async () => {
  const dir = repo();
  await processRelease(dir, { web: { to: sha("c") }, at: "2026-11-01T12:00:00Z" });
  const file = "entries/2026/2026-11-01.md";
  fs.appendFileSync(path.join(dir, file), "- **Search:** One search box finds pages, players and help.\n");

  // The production check records the same release again later.
  const report = await processRelease(dir, { web: { to: sha("c") }, at: "2026-11-01T12:30:00Z" });
  assert.deepEqual([report.skipped.length, report.added], [1, 0]);
  const entry = read(dir, file);
  assert.equal(entry.split("One search box").length - 1, 1);
  assert.equal(entry.split("roster history").length - 1, 1);
  const days = JSON.parse(read(dir, "state/days.json"));
  assert.equal(days["2026-11-01"].revision, 2);
  assert.equal(Object.keys(queue(dir).releases).length, 1);
});

test("issue titles are stable per release", () => {
  assert.equal(issueTitle("abc", { date: "2026-11-01" }), "Changelog review: release abc (2026-11-01)");
  assert.equal(issueTitle("flagged:x.json", { flagged: "why" }), "Changelog review: flagged x.json");
});
