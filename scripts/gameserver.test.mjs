import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { IMAGES, parseImage, resolveGameServer } from "./gameserver.mjs";
import { notesFor } from "./notes.mjs";
import { checkProduction } from "./production.mjs";
import { publish } from "./publish.mjs";
import { makeRecord, releaseId, validateRecord } from "./release.mjs";

const sha = (char) => char.repeat(40);
const digest = (char) => `sha256:${char.repeat(64)}`;
const SW = "ghcr.io/deafcs/game-server-sw";
const urls = { web: "https://deafcs.example/api/version", api: "https://api.deafcs.example/system/version" };
const at = (minute) => new Date(Date.parse("2026-11-04T15:00:00Z") + minute * 60_000);

// Production: WEB and API on their published commits, game servers as given.
function repo({ gameserver = sha("c") } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gameserver-"));
  fs.mkdirSync(path.join(dir, "state"));
  fs.writeFileSync(
    path.join(dir, "state/releases.json"),
    JSON.stringify({ lastDeployed: { web: sha("a"), api: sha("b"), ...(gameserver ? { gameserver } : {}) }, processed: {} }),
  );
  // Release sw-v0.0.1 (commit c) is already known.
  fs.writeFileSync(
    path.join(dir, IMAGES),
    JSON.stringify({ [`${SW}@${digest("1")}`]: { release: "sw-v0.0.1", commit: sha("c"), publishedAt: "2026-11-01T10:00:00Z" } }),
  );
  return dir;
}

function site(gameServer) {
  return async (url) => {
    const body = url.includes("api.") ? { commit: sha("b"), ...(gameServer === undefined ? {} : { gameServer }) } : { commit: sha("a") };
    return { ok: true, json: async () => body };
  };
}

// GitHub releases and the registry: sw-v0.0.2 is commit d with image digest 2,
// sw-v0.0.3 commit e with digest 3. Counts lookups.
function tools({ registryDown = false } = {}) {
  const calls = { registry: 0 };
  const releases = [
    { tag_name: "sw-v0.0.3", published_at: "2026-11-04T12:00:00Z", commit: sha("e"), digest: digest("3") },
    { tag_name: "sw-v0.0.2", published_at: "2026-11-03T12:00:00Z", commit: sha("d"), digest: digest("2") },
    { tag_name: "css-v0.0.9", published_at: "2026-11-04T12:00:00Z", commit: sha("e"), digest: digest("9") },
  ];
  return {
    calls,
    github: async (url) => {
      if (url.includes("/releases?")) {
        return releases.map(({ tag_name, published_at }) => ({ tag_name, published_at, draft: false }));
      }
      const tag = url.match(/git\/ref\/tags\/(.+)$/)?.[1];
      const release = releases.find((entry) => entry.tag_name === tag);
      if (release) {
        return { object: { type: "commit", sha: release.commit } };
      }
      throw new Error("GitHub request failed with status 404");
    },
    registry: async (repository, reference) => {
      calls.registry++;
      if (registryDown) {
        throw new Error("registry request failed with status 503");
      }
      const prefix = repository.endsWith("-css") ? "css" : "sw";
      return releases.find((entry) => entry.tag_name === `${prefix}-${reference}`)?.digest ?? null;
    },
  };
}

const check = (dir, gameServer, minute, helpers = tools()) =>
  checkProduction(dir, {
    urls,
    fetcher: site(gameServer),
    now: at(minute),
    gameServer: (reported) => resolveGameServer(dir, reported, helpers),
  });

test("an image is read as repository, prefix and digest or tag", () => {
  assert.deepEqual(parseImage(`${SW}@${digest("1")}`), { repository: SW, prefix: "sw", digest: digest("1"), tag: null });
  assert.deepEqual(parseImage("ghcr.io/deafcs/game-server-css:v0.0.9"), {
    repository: "ghcr.io/deafcs/game-server-css",
    prefix: "css",
    digest: null,
    tag: "v0.0.9",
  });
  assert.equal(parseImage("ghcr.io/someone/else@sha256:abc"), null);
  assert.equal(parseImage(`${SW}@sha256:short`), null);
  assert.equal(parseImage(SW), null);
});

test("WEB and API releases keep their IDs; game servers only join when they are in the release", () => {
  const old = createHash("sha256").update(`web=${sha("c")};api=-`).digest("hex").slice(0, 16);
  assert.equal(releaseId({ web: { to: sha("c") } }), old);
  const record = makeRecord({ gameserver: { to: sha("e") }, verifiedAt: "2026-11-04T15:10:00Z" });
  assert.equal(validateRecord(record), null);
  assert.notEqual(record.id, releaseId({}));
});

test("tracking off: the API's game-server images change nothing", async () => {
  const dir = repo();
  for (const minute of [0, 20]) {
    const result = await checkProduction(dir, { urls, fetcher: site({ server: `${SW}@${digest("3")}` }), now: at(minute) });
    assert.deepEqual([result.record, result.problems], [null, []]);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "state/production.json"), "utf8")).gameserver, undefined);
});

test("an API without game-server images is no release and no problem", async () => {
  const dir = repo();
  for (const minute of [0, 40]) {
    const result = await check(dir, undefined, minute);
    assert.deepEqual([result.record, result.problems, result.outages, result.alert], [null, [], [], false]);
  }
});

test("a new release counts after 10 minutes, found once in the registry", async () => {
  const dir = repo();
  const helpers = tools();
  const reported = { server: `${SW}@${digest("2")}`, practice: `${SW}@${digest("2")}` };
  assert.equal((await check(dir, reported, 0, helpers)).record, null);
  assert.equal((await check(dir, reported, 5, helpers)).record, null);
  const { record } = await check(dir, reported, 10, helpers);
  assert.deepEqual(record.gameserver, { to: sha("d") });
  assert.equal(record.web, undefined);
  // Remembered: later checks don't ask the registry again.
  const lookups = helpers.calls.registry;
  await check(dir, reported, 20, helpers);
  assert.equal(helpers.calls.registry, lookups);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, IMAGES), "utf8"))[`${SW}@${digest("2")}`].release, "sw-v0.0.2");
});

test("match and practice on different releases: the newer counts, and catching up publishes nothing twice", async () => {
  const dir = repo();
  const split = { server: `${SW}@${digest("2")}`, practice: `${SW}@${digest("3")}` };
  await check(dir, split, 0);
  const { record } = await check(dir, split, 10);
  assert.deepEqual(record.gameserver, { to: sha("e") });
  // Published: the range c..e already covers d.
  const state = JSON.parse(fs.readFileSync(path.join(dir, "state/releases.json"), "utf8"));
  state.lastDeployed.gameserver = sha("e");
  fs.writeFileSync(path.join(dir, "state/releases.json"), JSON.stringify(state));
  fs.rmSync(path.join(dir, "releases"), { recursive: true });
  const same = { server: `${SW}@${digest("3")}`, practice: `${SW}@${digest("3")}` };
  for (const minute of [20, 40]) {
    assert.equal((await check(dir, same, minute)).record, null);
  }
});

test("an image that isn't a release (built by hand) is reported once, never recorded", async () => {
  const dir = repo();
  const handBuilt = { server: `${SW}@${digest("f")}` };
  const first = await check(dir, handBuilt, 0);
  assert.deepEqual(first.problems, ["gameserver: the server image isn't a game-server release"]);
  assert.equal(first.alert, true);
  for (const minute of [10, 20, 30, 40]) {
    const later = await check(dir, handBuilt, minute);
    assert.deepEqual([later.record, later.alert], [null, false]);
  }
  // Back on a release: the problem clears and nothing from the hand build is recorded.
  const fixed = { server: `${SW}@${digest("1")}` };
  assert.deepEqual((await check(dir, fixed, 50)).reported, []);
  assert.equal((await check(dir, fixed, 70)).record, null);
});

test("a registry outage is retried quietly, then reported once after 30 minutes", async () => {
  const dir = repo();
  const down = tools({ registryDown: true });
  const reported = { server: `${SW}@${digest("2")}` };
  for (const minute of [0, 10, 20]) {
    assert.equal((await check(dir, reported, minute, down)).alert, false, `minute ${minute}`);
  }
  assert.equal((await check(dir, reported, 30, down)).alert, true);
  assert.equal((await check(dir, reported, 40, down)).alert, false);
  // WEB and API kept their monitoring date: the outage is the game servers'.
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "state/production.json"), "utf8")).checkedOn, "2026-11-04");
});

test("game-server notes: trailers and in-match scopes publish, infrastructure is held, a WEB twin wins", async () => {
  const change = (title, body = "") => ({ side: "gameserver", kind: "commit", title, body, labels: [] });
  const { items, review } = await notesFor([
    change("fix(leaver): a player who leaves during warmup is no longer marked as a leaver"),
    change("fix(swiftly): SwiftlyS2 v1.5.1 for CS2 build 26150000"),
    change("feat(match): send each player's teammate color", "Changelog: skip"),
    change("fix(restore): restore round", "Changelog-Fixed: Matches: Restore Round brings back every player's money."),
    change("feat(timeout): tactical timeouts show the time left"),
    { side: "web", kind: "commit", title: "feat(matches): tactical timeouts show the time left on the match page", body: "", labels: [] },
  ]);
  assert.deepEqual(items, [
    { type: "fixed", area: "Matches", text: "Restore Round brings back every player's money." },
    { type: "fixed", area: "Matches", text: "A player who leaves during warmup is no longer marked as a leaver." },
    { type: "new", area: "Matches", text: "Tactical timeouts show the time left on the match page." },
  ]);
  assert.deepEqual(
    review.map((entry) => entry.reason),
    ['scope "swiftly" is not on the player-facing list', "same feature as a WEB note"],
  );
  assert.match(review[0].note, /^GAME SERVER commit: /);
  // The same scopes stay held for WEB and API commits, as before.
  const web = await notesFor([{ side: "api", kind: "commit", title: "fix(leaver): leavers are marked", body: "", labels: [] }]);
  assert.deepEqual(web.items, []);
});

test("a game-server release publishes into the day's entry and keeps hand edits", async () => {
  const dir = repo();
  fs.mkdirSync(path.join(dir, "entries/2026"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "entries/2026/2026-11-04.md"),
    "# Patch Notes | November 4, 2026\n\nWritten by hand.\n\n## Fixed\n\n- **Teams:** Team pages load again.\n",
  );
  const record = makeRecord({ gameserver: { to: sha("d") }, verifiedAt: "2026-11-04T15:10:00Z" });
  fs.mkdirSync(path.join(dir, "releases/pending"), { recursive: true });
  fs.writeFileSync(path.join(dir, `releases/pending/${record.id}.json`), JSON.stringify(record));
  const github = async (url) => {
    assert.match(url, new RegExp(`/repos/DEAFCS/game-server/compare/${sha("c")}\\.\\.\\.${sha("d")}`));
    return {
      status: "ahead",
      total_commits: 1,
      commits: [
        {
          sha: "1",
          parents: [{}],
          author: { login: "theft", type: "User" },
          commit: { message: "fix(surrender): a surrender vote ends the map for both teams" },
        },
      ],
    };
  };
  const report = await publish(dir, { github: async (url) => (url.includes("/compare/") ? github(url) : []) });
  assert.equal(report.added, 1);
  assert.equal(
    fs.readFileSync(path.join(dir, "entries/2026/2026-11-04.md"), "utf8"),
    "# Patch Notes | November 4, 2026\n\nWritten by hand.\n\n## Fixed\n\n- **Teams:** Team pages load again.\n- **Matches:** A surrender vote ends the map for both teams.\n",
  );
  const state = JSON.parse(fs.readFileSync(path.join(dir, "state/releases.json"), "utf8"));
  assert.equal(state.lastDeployed.gameserver, sha("d"));
  assert.deepEqual([state.lastDeployed.web, state.lastDeployed.api], [sha("a"), sha("b")]);
  assert.equal(state.processed[record.id].gameserver, sha("d"));
});

test("without a known previous game-server commit the release is flagged, not guessed", async () => {
  const dir = repo({ gameserver: null });
  const record = makeRecord({ gameserver: { to: sha("d") }, verifiedAt: "2026-11-04T15:10:00Z" });
  fs.mkdirSync(path.join(dir, "releases/pending"), { recursive: true });
  fs.writeFileSync(path.join(dir, `releases/pending/${record.id}.json`), JSON.stringify(record));
  const report = await publish(dir, { github: async () => [] });
  assert.equal(report.added, 0);
  assert.match(report.flagged[0].reason, /gameserver: no previous production commit is known/);
});
