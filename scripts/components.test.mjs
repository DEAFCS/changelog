import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  COMPONENT_IMAGES,
  enabledComponents,
  labelClient,
  parsePinned,
  resolveLabelled,
} from "./components.mjs";
import { itemId } from "./entry.mjs";
import { notesFor, titleNote } from "./notes.mjs";
import { OVERRIDES, readOverrides, validateOverrides } from "./overrides.mjs";
import { checkProduction } from "./production.mjs";
import { publish } from "./publish.mjs";
import { parseArgs } from "./record-release.mjs";
import { COMPONENT_SIDES, makeRecord, releaseId, SIDES, validateRecord } from "./release.mjs";
import { collect } from "./sources.mjs";

const sha = (char) => char.repeat(40);
const digest = (char) => `sha256:${char.repeat(64)}`;
const STREAMER = "ghcr.io/deafcs/game-streamer";
const PARSER = "ghcr.io/deafcs/demo-parser";
const urls = { web: "https://deafcs.example/api/version", api: "https://api.deafcs.example/system/version" };
const at = (minute) => new Date(Date.parse("2026-11-07T11:45:00Z") + minute * 60_000);
const ROOT = path.join(import.meta.dirname, "..");

// --- release IDs -------------------------------------------------------------

// Rebuilds each processed release from the sides it recorded: WEB/API
// releases from web/api, component releases (like the streamer release of
// 2026-11-07) with their component sides too.
test("every published release keeps its ID", () => {
  const { processed } = JSON.parse(fs.readFileSync(path.join(ROOT, "state/releases.json"), "utf8"));
  const ids = Object.entries(processed);
  assert.ok(ids.length > 20);
  for (const [id, entry] of ids) {
    const record = Object.fromEntries(SIDES.filter((side) => entry[side]).map((side) => [side, { to: entry[side] }]));
    assert.equal(releaseId(record), id, `release ${id}`);
  }
});

test("WEB/API-only releases keep the ID they had before components existed", () => {
  const { processed } = JSON.parse(fs.readFileSync(path.join(ROOT, "state/releases.json"), "utf8"));
  const webApi = Object.entries(processed).filter(([, entry]) => !COMPONENT_SIDES.some((side) => entry[side]));
  assert.ok(webApi.length > 20);
  for (const [id, entry] of webApi) {
    const legacy = createHash("sha256").update(`web=${entry.web ?? "-"};api=${entry.api ?? "-"}`).digest("hex").slice(0, 16);
    assert.equal(legacy, id, `release ${id}`);
  }
});

test("the streamer release of 2026-11-07 keeps its ID and stays streamer-only", () => {
  const { processed, lastDeployed } = JSON.parse(fs.readFileSync(path.join(ROOT, "state/releases.json"), "utf8"));
  const entry = processed.dacf8165fa7fd8a1;
  const streamer = "a34f3c1727e2e3ebcba2ea1d5945c5b4f7470a72";
  assert.deepEqual(
    { web: entry.web, api: entry.api, streamer: entry.streamer, date: entry.date, added: entry.added, held: entry.held },
    { web: null, api: null, streamer, date: "2026-11-07", added: 3, held: 0 },
  );
  assert.equal(releaseId({ streamer: { to: streamer } }), "dacf8165fa7fd8a1");
  assert.equal(lastDeployed.streamer, streamer);
});

test("a component joins the ID only when the release has it, in a fixed order", () => {
  const web = { to: sha("a") };
  assert.equal(releaseId({ web }), releaseId({ web, streamer: undefined }));
  assert.notEqual(releaseId({ web }), releaseId({ web, streamer: { to: sha("5") } }));
  // Same sides, written in another order: same ID.
  assert.equal(
    releaseId({ streamer: { to: sha("5") }, gameserver: { to: sha("9") } }),
    releaseId({ gameserver: { to: sha("9") }, streamer: { to: sha("5") } }),
  );
  const record = makeRecord({ streamer: { to: sha("5"), from: sha("4") }, verifiedAt: "2026-11-07T11:54:57Z" });
  assert.equal(validateRecord(record), null);
  assert.deepEqual(Object.keys(record).filter((key) => !["version", "verified", "verifiedAt", "id"].includes(key)), ["streamer"]);
  assert.match(validateRecord({ ...record, streamer: { to: "abc" } }), /streamer: the production commit is not a full commit hash/);
});

test("record-release takes streamer, demo-parser and game-server sides", () => {
  const args = parseArgs(["--verified", "--streamer-to", sha("5"), "--streamer-from", sha("4"), "--verified-at", "2026-11-07T11:54:57Z"]);
  assert.deepEqual(args.streamer, { to: sha("5"), image: undefined, from: sha("4") });
  assert.equal(args.web, null);
  assert.equal(args.demoparser, undefined);
  assert.deepEqual(parseArgs(["--demoparser-to", sha("6")]).demoparser, { to: sha("6"), image: undefined });
});

// --- the switch and image references -----------------------------------------

test("components are off unless CHANGELOG_COMPONENTS names them", () => {
  assert.deepEqual(enabledComponents({}), []);
  assert.deepEqual(enabledComponents({ CHANGELOG_COMPONENTS: "" }), []);
  assert.deepEqual(enabledComponents({ CHANGELOG_COMPONENTS: "true" }), []);
  assert.deepEqual(enabledComponents({ CHANGELOG_COMPONENTS: " Streamer , demoparser" }), ["streamer", "demoparser"]);
  assert.deepEqual(enabledComponents({ CHANGELOG_COMPONENTS: "demoparser,gameserver,web" }), ["gameserver", "demoparser"]);
});

test("only an allowed image pinned by digest is accepted", () => {
  assert.deepEqual(parsePinned(`${STREAMER}@${digest("1")}`, [STREAMER]), { repository: STREAMER, digest: digest("1") });
  assert.deepEqual(parsePinned(`${STREAMER}:a34f3c1@${digest("1")}`, [STREAMER]), { repository: STREAMER, digest: digest("1") });
  assert.equal(parsePinned(`${STREAMER}:latest`, [STREAMER]), null);
  assert.equal(parsePinned(`${PARSER}@${digest("1")}`, [STREAMER]), null);
  assert.equal(parsePinned(`registry.example:5000/deafcs/game-streamer@${digest("1")}`, [STREAMER]), null);
  assert.equal(parsePinned(`${STREAMER}@sha256:short`, [STREAMER]), null);
});

// --- digest -> commit ----------------------------------------------------------

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "components-"));
  fs.mkdirSync(path.join(dir, "state"));
  return dir;
}

// Labels by digest, and the commits GitHub knows, with lookups counted.
function lookups({ labels = {}, known = [], registryDown = false } = {}) {
  const calls = { labels: 0, github: 0 };
  return {
    calls,
    labels: async (repository, imageDigest) => {
      calls.labels++;
      if (registryDown) {
        throw new Error("registry request failed with status 503");
      }
      return labels[`${repository}@${imageDigest}`] ?? null;
    },
    github: async (url) => {
      calls.github++;
      const commit = url.match(/\/commits\/([0-9a-f]{40})$/)?.[1];
      if (commit && known.includes(commit)) {
        return { sha: commit };
      }
      throw new Error("GitHub request failed with status 404");
    },
  };
}

const revision = (commit) => ({ "org.opencontainers.image.revision": commit });

test("a streamer digest becomes the commit in its revision label, looked up once", async () => {
  const dir = tmp();
  const tools = lookups({ labels: { [`${STREAMER}@${digest("1")}`]: revision(sha("5")) }, known: [sha("5")] });
  assert.deepEqual(await resolveLabelled(dir, "streamer", `${STREAMER}@${digest("1")}`, tools), { answered: true, commit: sha("5") });
  assert.deepEqual(await resolveLabelled(dir, "streamer", `${STREAMER}@${digest("1")}`, tools), { answered: true, commit: sha("5") });
  assert.equal(tools.calls.labels, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, COMPONENT_IMAGES), "utf8")), {
    [`${STREAMER}@${digest("1")}`]: { commit: sha("5") },
  });
});

test("an image that can't be traced to a pushed commit is a problem and is never remembered", async () => {
  const dir = tmp();
  const tools = lookups({
    labels: {
      [`${PARSER}@${digest("1")}`]: revision(sha("6")), // not pushed
      [`${PARSER}@${digest("2")}`]: { "org.opencontainers.image.source": "x" }, // no revision
    },
    known: [],
  });
  const problem = async (ref) => (await resolveLabelled(dir, "demoparser", ref, tools)).problem;
  assert.match(await problem(`${PARSER}@${digest("1")}`), /^demoparser: the image's commit is not on GitHub$/);
  assert.match(await problem(`${PARSER}@${digest("2")}`), /^demoparser: the image has no full revision label$/);
  assert.match(await problem(`${PARSER}@${digest("3")}`), /^demoparser: the image isn't in the registry$/);
  assert.match(await problem(`${PARSER}:latest`), /^demoparser: the image isn't a demoparser image pinned by digest$/);
  assert.equal(fs.existsSync(path.join(dir, COMPONENT_IMAGES)), false);
});

test("a registry outage is no answer, and an API without the field reports nothing", async () => {
  const dir = tmp();
  assert.deepEqual(await resolveLabelled(dir, "streamer", `${STREAMER}@${digest("1")}`, lookups({ registryDown: true })), { answered: false });
  assert.equal(await resolveLabelled(dir, "streamer", undefined, lookups()), null);
  assert.equal(await resolveLabelled(dir, "streamer", null, lookups()), null);
});

test("labels are read through the amd64 manifest of a multi-platform index", async () => {
  const seen = [];
  const fetcher = async (url, options = {}) => {
    seen.push(url);
    const reply = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });
    if (url.startsWith("https://ghcr.io/token")) {
      assert.match(options.headers.authorization, /^Basic /);
      return reply({ token: "registry-bearer" });
    }
    assert.equal(options.headers.authorization, "Bearer registry-bearer");
    if (url.endsWith(`/manifests/${digest("1")}`)) {
      return reply({
        manifests: [
          { digest: digest("8"), platform: { os: "linux", architecture: "arm64" } },
          { digest: digest("9"), platform: { os: "linux", architecture: "amd64" } },
        ],
      });
    }
    if (url.endsWith(`/manifests/${digest("9")}`)) {
      return reply({ config: { digest: digest("c") } });
    }
    if (url.endsWith(`/blobs/${digest("c")}`)) {
      return reply({ config: { Labels: revision(sha("5")) } });
    }
    return reply(null, 404);
  };
  const labelsOf = labelClient("workflow-token", fetcher);
  assert.deepEqual(await labelsOf(STREAMER, digest("1")), revision(sha("5")));
  assert.equal(await labelsOf(STREAMER, digest("7")), null);
  // One token request per image repository.
  assert.equal(seen.filter((url) => url.startsWith("https://ghcr.io/token")).length, 1);
});

// --- the production check -------------------------------------------------------

function production({ streamer = sha("4") } = {}) {
  const dir = tmp();
  fs.writeFileSync(
    path.join(dir, "state/releases.json"),
    JSON.stringify({ lastDeployed: { web: sha("a"), api: sha("b"), ...(streamer ? { streamer } : {}) }, processed: {} }),
  );
  return dir;
}

function site(fields) {
  return async (url) => {
    const body = url.includes("api.") ? { commit: sha("b"), ...fields } : { commit: sha("a") };
    return { ok: true, json: async () => body };
  };
}

const labelled = (dir, tools) => ({ streamer: (reported) => resolveLabelled(dir, "streamer", reported, tools) });

test("a new streamer image that stays for 10 minutes is a verified streamer release", async () => {
  const dir = production();
  const tools = lookups({ labels: { [`${STREAMER}@${digest("2")}`]: revision(sha("5")) }, known: [sha("5")] });
  const fetcher = site({ streamer: `${STREAMER}@${digest("2")}` });
  assert.equal((await checkProduction(dir, { urls, fetcher, now: at(0), components: labelled(dir, tools) })).record, null);
  const { record } = await checkProduction(dir, { urls, fetcher, now: at(10), components: labelled(dir, tools) });
  assert.deepEqual(record.streamer, { to: sha("5") });
  assert.equal(record.web, undefined);
  assert.equal(record.verifiedAt, "2026-11-07T11:55:00Z");
});

test("with the switch off, the streamer field is not read at all", async () => {
  const dir = production();
  const tools = lookups();
  const fetcher = site({ streamer: `${STREAMER}@${digest("2")}` });
  await checkProduction(dir, { urls, fetcher, now: at(0) });
  const { record, problems } = await checkProduction(dir, { urls, fetcher, now: at(10) });
  assert.equal(record, null);
  assert.deepEqual(problems, []);
  assert.equal(tools.calls.labels, 0);
});

test("a streamer problem never blocks WEB/API or the monitoring date", async () => {
  const dir = production();
  const tools = lookups({ labels: { [`${STREAMER}@${digest("2")}`]: revision(sha("7")) }, known: [] });
  const fetcher = async (url) => ({
    ok: true,
    json: async () => (url.includes("api.") ? { commit: sha("b"), streamer: `${STREAMER}@${digest("2")}` } : { commit: sha("8") }),
  });
  await checkProduction(dir, { urls, fetcher, now: at(0), components: labelled(dir, tools) });
  const result = await checkProduction(dir, { urls, fetcher, now: at(10), components: labelled(dir, tools) });
  assert.deepEqual(result.record.web, { to: sha("8") });
  assert.equal(result.record.streamer, undefined);
  assert.deepEqual(result.problems, ["streamer: the image's commit is not on GitHub"]);
  const state = JSON.parse(fs.readFileSync(path.join(dir, "state/production.json"), "utf8"));
  assert.equal(state.checkedOn, "2026-11-07");
  // Reported once, so the run fails once and then only warns.
  assert.deepEqual(result.reported, ["streamer: the image's commit is not on GitHub"]);
});

test("an API from before the version fields reports no component and no problem", async () => {
  const dir = production();
  const fetcher = site({});
  await checkProduction(dir, { urls, fetcher, now: at(0), components: labelled(dir, lookups()) });
  const { record, problems } = await checkProduction(dir, { urls, fetcher, now: at(10), components: labelled(dir, lookups()) });
  assert.equal(record, null);
  assert.deepEqual(problems, []);
});

// --- notes ----------------------------------------------------------------------

test("each side has its own title scopes; the demo parser publishes only Changelog lines", () => {
  assert.deepEqual(titleNote("fix(stream): the live picture no longer stutters after a map change", "streamer").item.area, "Streams");
  assert.deepEqual(titleNote("fix(clips): new clips keep their sound in every highlight", "streamer").item.area, "Highlights");
  assert.match(titleNote("fix(stream): the live picture no longer stutters after a map change", "web").held, /not on the player-facing list/);
  assert.match(titleNote("fix(match): kills count the same way in every parsed demo", "demoparser").held, /not on the player-facing list/);
  assert.match(titleNote("bug: stop live audio drifting ahead of video on long streams (#91)", "streamer").held, /not feat\/fix\/perf\/ux/);
  assert.match(titleNote("fix(constructor): a scope that only exists on every object", "web").held, /not on the player-facing list/);
  assert.equal(titleNote("fix(match): the round timer shows the right time", "gameserver").item.area, "Matches");
});

test("the overrides file in this repository is valid", () => {
  assert.deepEqual(validateOverrides(JSON.parse(fs.readFileSync(path.join(ROOT, OVERRIDES), "utf8"))), []);
});

test("a broken override is refused before anything is published", () => {
  const good = ["Changelog-Fixed: Streams: Audio stays in sync."];
  assert.deepEqual(validateOverrides({ streamer: { [sha("1")]: good, [sha("2")]: "skip" } }), []);
  assert.match(validateOverrides({ streamer: { abc: good } })[0], /not a full commit hash/);
  assert.match(validateOverrides({ panel: { [sha("1")]: good } })[0], /not a known side/);
  assert.match(validateOverrides({ streamer: { [sha("1")]: [] } })[0], /must be "skip" or a list/);
  assert.match(validateOverrides({ streamer: { [sha("1")]: ["Streams got better"] } })[0], /is not one Changelog/);
  assert.match(validateOverrides({ streamer: { [sha("1")]: ["Changelog-Fixed: no area given"] } })[0], /is not one Changelog/);
  assert.match(validateOverrides({ streamer: { [sha("1")]: ["Changelog-Fixed: Streams: Fixed on mediamtx.internal"] } }, ["mediamtx"])[0], /fails the filter/);
  assert.match(validateOverrides([])[0], /not a JSON object/);

  const dir = tmp();
  fs.mkdirSync(path.join(dir, "notes"));
  fs.writeFileSync(path.join(dir, OVERRIDES), JSON.stringify({ streamer: { abc: good } }));
  assert.throws(() => readOverrides(dir), /can't be used/);
  fs.rmSync(path.join(dir, OVERRIDES));
  assert.deepEqual(readOverrides(dir), {});
});

// The real streamer stability range c5622ac..a34f3c1 (released 2026-11-07).
// Upstream 5Stack titles as published; DEAFCS-only commits with neutral titles.
const STREAMER_RANGE = [
  ["ec3d7b54a85f32b8105d8a6e934a02246df7f031", "ci: image publishing"],
  ["4ed77c6cafe06224a22a16865815d5af9d99ab08", "test: a streamer test"],
  ["7a0c5cd73ccc831872396b113aca3f4aa4e71572", "bug: stop live audio drifting ahead of video on long streams (#91)"],
  ["bebab764e4fcaba8f1ab4a71a601d0413d188534", "bug: bound live capture buffers under backpressure (#94)"],
  ["16c740bb492c189b83437e21f35a419630639cb4", "bug: highlight renders no longer hold the GPU forever when Steam parks the cs2 launch on its cloud dialog (#101)"],
  ["eb4bb81be89f2b965333978d7811f19f672b408c", "bug: post a clip's thumbnail before its upload closes the render (#106)"],
  ["491fc1a661217fd66f5faa1c78ae6470f009b2a6", "fix(console): a streamer fix"],
  ["15a1d4f1ffc45af35b8523a75a7ab9664549561b", "test(clips): a streamer test"],
  ["a34f3c1727e2e3ebcba2ea1d5945c5b4f7470a72", "test(stream): a streamer test"],
];

function streamerGithub(calls = { pulls: 0 }) {
  return async (url) => {
    if (url.includes("/repos/DEAFCS/game-streamer/compare/c5622ac26dd23337f197e917a5f1802350c7d4f2...a34f3c1727e2e3ebcba2ea1d5945c5b4f7470a72")) {
      return {
        status: "ahead",
        total_commits: STREAMER_RANGE.length,
        commits: STREAMER_RANGE.map(([commitSha, title]) => ({
          sha: commitSha,
          parents: [{}],
          author: { login: "dev", type: "User" },
          commit: { message: `${title}\n\n(cherry picked from an upstream commit)` },
        })),
      };
    }
    if (url.includes("/pulls")) {
      calls.pulls++;
      return [];
    }
    throw new Error("GitHub request failed with status 404");
  };
}

const RANGE = { side: "streamer", from: "c5622ac26dd23337f197e917a5f1802350c7d4f2", to: "a34f3c1727e2e3ebcba2ea1d5945c5b4f7470a72" };
const EXPECTED = [
  { type: "fixed", area: "Streams", text: "Audio stays in sync with the picture on long live streams." },
  { type: "improved", area: "Streams", text: "Live streams stay closer to real time when they fall behind." },
  {
    type: "fixed",
    area: "Highlights",
    text: "A clip's thumbnail is now saved before the clip is finished, so fewer clips appear without one.",
  },
];

test("the streamer release gives exactly its three notes, holds nothing and skips the rest", async () => {
  const overrides = readOverrides(ROOT);
  const calls = { pulls: 0 };
  const changes = await collect(RANGE, streamerGithub(calls), overrides.streamer);
  const { items, review } = await notesFor(changes);
  assert.deepEqual(items, EXPECTED);
  assert.deepEqual(review, []);
  // Overridden commits never ask for a pull request.
  assert.equal(calls.pulls, 4);
});

test("without its overrides the same range publishes nothing and only holds", async () => {
  const { items, review } = await notesFor(await collect(RANGE, streamerGithub()));
  assert.deepEqual(items, []);
  assert.equal(review.length, 5);
});

// --- publishing -------------------------------------------------------------------

test("a hand-recorded streamer release lands on its own day, after what is there, once", async () => {
  const dir = tmp();
  fs.writeFileSync(
    path.join(dir, "state/releases.json"),
    JSON.stringify({ lastDeployed: { web: sha("a"), api: sha("b") }, processed: {} }),
  );
  fs.mkdirSync(path.join(dir, "notes"));
  fs.copyFileSync(path.join(ROOT, OVERRIDES), path.join(dir, OVERRIDES));
  fs.mkdirSync(path.join(dir, "entries/2026"), { recursive: true });
  const existing = "# Patch Notes | November 7, 2026\n\n## New\n\n- **Profiles:** Season awards show their season and game mode.\n";
  fs.writeFileSync(path.join(dir, "entries/2026/2026-11-07.md"), existing);
  // An earlier day already published: revision 1.
  fs.writeFileSync(
    path.join(dir, "state/days.json"),
    JSON.stringify({
      "2026-11-07": {
        revision: 1,
        items: {
          [itemId({ area: "Profiles", text: "Season awards show their season and game mode." })]: {
            type: "new",
            area: "Profiles",
            text: "Season awards show their season and game mode.",
            status: "published",
            source: "release:x",
          },
        },
      },
    }),
  );
  const record = makeRecord({ streamer: { to: RANGE.to, from: RANGE.from }, verifiedAt: "2026-11-07T11:54:57Z" });
  fs.mkdirSync(path.join(dir, "releases/pending"), { recursive: true });
  fs.writeFileSync(path.join(dir, `releases/pending/${record.id}.json`), JSON.stringify(record));

  const report = await publish(dir, { github: streamerGithub() });
  assert.deepEqual(report.processed, [{ id: record.id, date: "2026-11-07", added: 3 }]);
  assert.equal(report.held, 0);
  const entry = fs.readFileSync(path.join(dir, "entries/2026/2026-11-07.md"), "utf8");
  assert.ok(entry.startsWith(existing.trimEnd()));
  for (const { area, text } of EXPECTED) {
    assert.equal(entry.split(`- **${area}:** ${text}`).length, 2, text);
  }
  const days = JSON.parse(fs.readFileSync(path.join(dir, "state/days.json"), "utf8"));
  assert.equal(days["2026-11-07"].revision, 2);
  const releases = JSON.parse(fs.readFileSync(path.join(dir, "state/releases.json"), "utf8"));
  assert.equal(releases.lastDeployed.streamer, RANGE.to);
  assert.deepEqual(releases.lastDeployed.web, sha("a"));
  assert.equal(releases.processed[record.id].streamer, RANGE.to);
  assert.equal(releases.processed[record.id].web, null);

  // Recorded again (by the production check later): processed once.
  fs.writeFileSync(path.join(dir, `releases/pending/${record.id}.json`), JSON.stringify(record));
  const again = await publish(dir, { github: streamerGithub() });
  assert.deepEqual(again.skipped, [record.id]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "state/days.json"), "utf8"))["2026-11-07"].revision, 2);
});

test("a streamer release without a known previous commit is flagged, not guessed", async () => {
  const dir = production({ streamer: null });
  const record = makeRecord({ streamer: { to: sha("5") }, verifiedAt: "2026-11-07T11:54:57Z" });
  fs.mkdirSync(path.join(dir, "releases/pending"), { recursive: true });
  fs.writeFileSync(path.join(dir, `releases/pending/${record.id}.json`), JSON.stringify(record));
  const report = await publish(dir, { github: streamerGithub() });
  assert.match(report.flagged[0].reason, /streamer: no previous production commit is known/);
});
