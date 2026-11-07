// Changelog lines for commits that were pushed without them, most often
// upstream fixes cherry-picked into a DEAFCS repository. A pushed commit is
// never rewritten, so its player note lives here instead:
//
//   notes/overrides.json
//   {
//     "streamer": {
//       "<full commit>": ["Changelog-Fixed: Streams: Audio stays in sync ..."],
//       "<full commit>": "skip"
//     }
//   }
//
// An override is read only while a release's commit range is collected
// (scripts/sources.mjs), so it can't publish anything before production runs
// that commit. It replaces the commit's own message body. "skip" marks a
// commit with nothing for players, such as a security fix.
//
// This file is public like the rest of the repository: it holds player text
// and commit hashes only.
import fs from "node:fs";
import path from "node:path";
import { renderItem } from "./entry.mjs";
import { parseTrailers } from "./notes.mjs";
import { violations } from "./redact.mjs";
import { SIDES } from "./release.mjs";

export const OVERRIDES = "notes/overrides.json";
const SHA = /^[0-9a-f]{40}$/;

// Every problem with the file; an empty list means it can be used.
export function validateOverrides(overrides, blocked = []) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    return ["the file is not a JSON object"];
  }
  const problems = [];
  for (const [side, commits] of Object.entries(overrides)) {
    if (!SIDES.includes(side)) {
      problems.push(`${side}: not a known side (${SIDES.join(", ")})`);
      continue;
    }
    if (!commits || typeof commits !== "object" || Array.isArray(commits)) {
      problems.push(`${side}: not an object of commits`);
      continue;
    }
    for (const [sha, value] of Object.entries(commits)) {
      const where = `${side} ${sha.slice(0, 12)}`;
      if (!SHA.test(sha)) {
        problems.push(`${where}: not a full commit hash`);
        continue;
      }
      if (value === "skip") {
        continue;
      }
      if (!Array.isArray(value) || value.length === 0) {
        problems.push(`${where}: must be "skip" or a list of Changelog lines`);
        continue;
      }
      for (const line of value) {
        const { skip, items } = parseTrailers(String(line));
        if (skip || items.length !== 1 || !items[0].area) {
          problems.push(`${where}: "${String(line).slice(0, 40)}" is not one Changelog-New/Improved/Fixed: Area: text line`);
          continue;
        }
        const found = violations(renderItem(items[0]), blocked);
        if (found.length > 0) {
          problems.push(`${where}: a line fails the filter (${found.join(", ")})`);
        }
      }
    }
  }
  return problems;
}

// The overrides for every side; a missing file means none. A broken file
// throws, so a run stops before it publishes anything from it.
export function readOverrides(dir, blocked = []) {
  const file = path.join(dir, OVERRIDES);
  if (!fs.existsSync(file)) {
    return {};
  }
  const overrides = JSON.parse(fs.readFileSync(file, "utf8"));
  const problems = validateOverrides(overrides, blocked);
  if (problems.length > 0) {
    throw new Error(`${OVERRIDES} can't be used: ${problems.join("; ")}`);
  }
  return overrides;
}
