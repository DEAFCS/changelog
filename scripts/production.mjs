// The production check: which WEB and API commits deafcs.net runs now, and
// whether a new one has been live long enough to count as a verified
// release. It runs in the Changelog workflow every 10 minutes, so it sees
// every deployment, whoever made it, and needs nothing on the VPS.
//
// WEB and API each answer GET <version URL> with { "commit": "<full hash>" }
// (the commit their image was built from). A new commit counts as released
// once the site has served it, healthy, for STABLE_MINUTES across checks. A
// release that fails or is rolled back inside that window is never recorded.
// Several deployments in a row are recorded once, as the range from the last
// published commit to the one that stayed.
//
// state/production.json remembers, per side, the commit last seen and since
// when.
import fs from "node:fs";
import path from "node:path";
import { makeRecord } from "./release.mjs";

export const STABLE_MINUTES = 10;
// Checks run 10 minutes apart, so the check that ends the window lands within
// a second of its end, and by chance just before it. Counting it anyway saves a
// whole extra 10 minutes. A commit is still seen in every check of the window.
export const EARLY_SECONDS = 30;
export const PRODUCTION = "state/production.json";
const SHA = /^[0-9a-f]{40}$/;

// One check's answers, per side: { answered, commit }. answered is false when
// the endpoint couldn't be reached or didn't answer 200 with JSON; commit is
// what it reported (null when the image was built without one).
//
// A commit must be seen in every check for the whole window: any check
// without a usable answer restarts its clock, so a release that crashes,
// restarts or is replaced in between isn't counted as verified.
export function observe(state, seen, now) {
  const next = { ...state };
  const problems = [];
  for (const side of ["web", "api"]) {
    const { answered, commit } = seen[side] ?? { answered: false };
    if (!answered || !SHA.test(commit ?? "")) {
      problems.push(
        answered
          ? `${side}: production doesn't report a full commit (${commit === null ? "none" : `"${String(commit).slice(0, 20)}"`})`
          : `${side}: no answer from the version endpoint`,
      );
      // unusableSince: when this side stopped giving a usable answer, so a
      // long outage can fail the run (see outages below).
      if (state[side]?.since || !state[side]?.unusableSince) {
        next[side] = { ...state[side], since: null, unusableSince: state[side]?.unusableSince ?? now.toISOString() };
      }
      continue;
    }
    if (state[side]?.commit !== commit || !state[side]?.since) {
      next[side] = { commit, since: now.toISOString() };
    }
  }
  // checkedOn is the last day of a successful check: both WEB and API
  // answered with a full commit. It reaches the feed (monitoredOn) only
  // through the run's commit, so a run that started but failed, a dry run, or
  // a run whose push didn't land never counts. Once a day it changes, so the
  // workflow commits at least daily, which keeps GitHub from pausing the
  // schedule after 60 days without activity.
  const today = now.toISOString().slice(0, 10);
  if (problems.length === 0 && next.checkedOn !== today) {
    next.checkedOn = today;
  }
  return { state: next, problems };
}

export const OUTAGE_MINUTES = 30;

// Sides that have given no usable answer for OUTAGE_MINUTES or longer. A
// short blip is retried quietly; a long one fails the run, so GitHub emails it.
export function outages(state, now, minutes = OUTAGE_MINUTES) {
  return ["web", "api"].filter((side) => {
    const since = Date.parse(state[side]?.unusableSince ?? "");
    return !Number.isNaN(since) && now.getTime() - since >= minutes * 60_000;
  });
}

// The problems worth an email: a side that answers without a full commit,
// and a side without a usable answer for OUTAGE_MINUTES. alerted keeps the
// ones already emailed, so the run fails once when they start or change, then
// only logs them until they clear (like the review queue, scripts/review.mjs).
export function alerting(state, problems, down) {
  const noCommit = problems.filter((problem) => problem.includes("doesn't report a full commit"));
  // A side without its commit counts as an outage too; that's one problem.
  const current = [
    ...noCommit,
    ...down
      .filter((side) => !noCommit.some((problem) => problem.startsWith(`${side}:`)))
      .map((side) => `${side}: no usable answer for ${OUTAGE_MINUTES}+ minutes`),
  ].sort();
  if (current.length === 0) {
    const { alerted, ...rest } = state;
    return { state: rest, alert: false };
  }
  const alert = JSON.stringify(current) !== JSON.stringify(state.alerted ?? []);
  return { state: { ...state, alerted: current }, alert };
}

// A release when a side settled on a commit that isn't published yet. Only
// sides that answered in this check count, so a site that is down never
// "settles".
export function decide(state, lastDeployed, answered, now, stableMinutes = STABLE_MINUTES) {
  const sides = {};
  let verifiedAt = null;
  for (const side of ["web", "api"]) {
    const seen = state[side];
    if (!answered.includes(side) || !seen?.since || seen.commit === lastDeployed[side]) {
      continue;
    }
    const stableAt = new Date(Date.parse(seen.since) + stableMinutes * 60_000);
    if (Number.isNaN(stableAt.getTime()) || stableAt.getTime() - EARLY_SECONDS * 1000 > now.getTime()) {
      continue;
    }
    sides[side] = { to: seen.commit };
    // Counted early, the release is verified now, never in the future.
    const verified = stableAt > now ? now : stableAt;
    if (!verifiedAt || verified > verifiedAt) {
      verifiedAt = verified;
    }
  }
  if (Object.keys(sides).length === 0) {
    return null;
  }
  return makeRecord({ ...sides, verifiedAt: verifiedAt.toISOString().replace(/\.\d{3}Z$/, "Z") });
}

async function readCommit(url, fetcher) {
  if (!url) {
    return { answered: false };
  }
  try {
    const response = await fetcher(url, { headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      return { answered: false };
    }
    const body = await response.json();
    return { answered: true, commit: typeof body?.commit === "string" ? body.commit.trim().toLowerCase() : null };
  } catch {
    return { answered: false };
  }
}

export async function checkProduction(dir, { urls, fetcher = fetch, now = new Date() } = {}) {
  const file = path.join(dir, PRODUCTION);
  const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const releases = JSON.parse(fs.readFileSync(path.join(dir, "state/releases.json"), "utf8"));

  const seen = { web: await readCommit(urls.web, fetcher), api: await readCommit(urls.api, fetcher) };
  const observed = observe(state, seen, now);
  const answered = ["web", "api"].filter((side) => seen[side].answered && SHA.test(seen[side].commit ?? ""));
  const record = decide(observed.state, releases.lastDeployed, answered, now);
  const down = outages(observed.state, now);
  const alerted = alerting(observed.state, observed.problems, down);

  if (JSON.stringify(alerted.state) !== JSON.stringify(state)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(alerted.state, null, 2)}\n`);
  }
  if (record) {
    const pending = path.join(dir, "releases", "pending", `${record.id}.json`);
    fs.mkdirSync(path.dirname(pending), { recursive: true });
    fs.writeFileSync(pending, `${JSON.stringify(record, null, 2)}\n`);
  }
  return { record, problems: observed.problems, outages: down, alert: alerted.alert, reported: alerted.state.alerted ?? [] };
}

if (import.meta.main) {
  const { record, problems, outages: down, alert, reported } = await checkProduction(".", {
    urls: { web: process.env.WEB_VERSION_URL, api: process.env.API_VERSION_URL },
  });
  for (const problem of problems) {
    console.log(`Production check: ${problem}`);
  }
  console.log(record ? `Recorded release ${record.id}` : "No new verified release");
  if (down.length > 0) {
    console.log(`Production check: no usable answer for ${OUTAGE_MINUTES}+ minutes from ${down.join(" and ")}`);
  }
  // Fail loudly, so GitHub emails it, when a side starts answering without a
  // full commit (built without it) or has given no usable answer for
  // OUTAGE_MINUTES. Later runs with the same problem only warn. A dry run
  // saves no state, so it only warns: the first real run emails instead.
  if (alert && process.env.DRY_RUN !== "true") {
    console.log("::error::Production check: a new problem; later runs only warn until it clears.");
    process.exitCode = 2;
  } else if (reported.length > 0) {
    console.log(`::warning::Production check: ${reported.length} problem(s) reported before, not emailed again until they clear.`);
  }
}
