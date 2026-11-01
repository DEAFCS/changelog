// What the publisher remembers between runs:
// - state/releases.json: every processed release (by its immutable ID) and the
//   last production commit per side, which is where the next range starts.
// - state/days.json: per day, a revision that grows when items are added, and
//   every item ever published with its status. An item deleted from the
//   Markdown by hand becomes "removed" and is never added again.
// - state/review.json: every release with held notes, and every flagged
//   release, with the private review issue made for it (scripts/review.mjs).
//   It keeps only release IDs, commit ranges and counts, never held text: the
//   held notes are recalculated from the ranges, so they stay recoverable.
import fs from "node:fs";
import path from "node:path";
import { entryPath, readItems } from "./entry.mjs";

export const RELEASES = "state/releases.json";
export const DAYS = "state/days.json";
export const REVIEW = "state/review.json";

function readJson(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
}

export function loadState(dir) {
  return {
    releases: readJson(path.join(dir, RELEASES), { lastDeployed: {}, processed: {} }),
    days: readJson(path.join(dir, DAYS), {}),
    review: readJson(path.join(dir, REVIEW), { alerted: null, releases: {} }),
  };
}

export function saveState(dir, { releases, days, review }) {
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  const sorted = Object.fromEntries(Object.entries(days).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(path.join(dir, RELEASES), `${JSON.stringify(releases, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, DAYS), `${JSON.stringify(sorted, null, 2)}\n`);
  // Written once there is something to remember, then always.
  if (review && (review.alerted || Object.keys(review.releases).length > 0 || fs.existsSync(path.join(dir, REVIEW)))) {
    fs.writeFileSync(path.join(dir, REVIEW), `${JSON.stringify(review, null, 2)}\n`);
  }
}

function entryDates(dir) {
  const root = path.join(dir, "entries");
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs
    .readdirSync(root, { recursive: true })
    .map((file) => path.basename(file))
    .filter((file) => /^\d{4}-\d{2}-\d{2}\.md$/.test(file))
    .map((file) => file.slice(0, 10));
}

// Brings the state in line with the Markdown as people left it. A bullet
// that disappeared was removed by hand; a bullet nobody published was added
// by hand, and counts as new for unread.
export function syncDay(date, markdown, day = { revision: 0, items: {} }) {
  const present = new Map(readItems(markdown).map((item) => [item.id, item]));
  let added = 0;
  for (const [id, item] of Object.entries(day.items)) {
    if (item.status === "published" && !present.has(id)) {
      item.status = "removed";
    } else if (item.status === "removed" && present.has(id)) {
      item.status = "published";
    }
  }
  for (const [id, { type, area, text }] of present) {
    if (!day.items[id]) {
      day.items[id] = { type, area, text, status: "published", source: "manual" };
      added++;
    }
  }
  if (added > 0 || (day.revision === 0 && present.size > 0)) {
    day.revision += 1;
  }
  return day;
}

export function syncAll(dir, days) {
  const dates = new Set([...entryDates(dir), ...Object.keys(days)]);
  for (const date of dates) {
    const file = path.join(dir, entryPath(date));
    const markdown = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    days[date] = syncDay(date, markdown, days[date]);
  }
  return days;
}
