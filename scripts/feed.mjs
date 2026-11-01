// Ported from 5stackgg/changelog scripts/feed.mjs (18fbb58) with 5Stack's
// permission. DEAFCS: an entry's "# " heading becomes the day's title, and
// the README introduces DEAFCS. Entries are written by hand: the upstream
// nightly summarizer (changelog.mjs, redact.mjs) is not part of this repo.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ENTRIES = "entries";
const FEED = "feed";
const README_ENTRIES = 14;

// DEAFCS: "New Features", "Improvements" and "Fixes" are accepted too.
export const SECTIONS = {
  New: "new",
  Improved: "improved",
  Fixed: "fixed",
  "New Features": "new",
  Improvements: "improved",
  Fixes: "fixed",
};
const BULLET = /^- \*\*([^*]+):\*\* ([^*]+)$/;

// Keeps an entry to the one shape the feed parses: summary lines, the three
// known headings, and "- **Area:** text" bullets. A heading it doesn't know
// takes its bullets with it, so nothing lands under the wrong section.
export function conform(markdown) {
  const kept = [];
  // DEAFCS: the dropped lines themselves, for the private draft review.
  const removed = [];
  let section;

  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      kept.push("");
      continue;
    }

    if (trimmed.startsWith("## ")) {
      section = SECTIONS[trimmed.slice(3)] ? trimmed : null;
      if (section) {
        kept.push(section);
      } else {
        removed.push(trimmed);
      }
      continue;
    }

    if (trimmed.startsWith("#")) {
      removed.push(trimmed);
      continue;
    }

    if (section === undefined) {
      kept.push(trimmed.replaceAll("*", ""));
      continue;
    }

    if (section && BULLET.test(trimmed)) {
      kept.push(trimmed);
    } else {
      removed.push(trimmed);
    }
  }

  const filled = kept.filter((line, index) => {
    if (!line.startsWith("## ")) {
      return true;
    }
    const next = kept.slice(index + 1).find((after) => after !== "");
    return next !== undefined && !next.startsWith("## ");
  });

  return {
    markdown: filled.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    dropped: removed.length,
    removed,
  };
}

export function parseEntry(markdown) {
  let title = "";
  const summary = [];
  const sections = { new: [], improved: [], fixed: [] };
  let section;
  let item = null;

  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (line === "") {
      continue;
    }
    if (line.startsWith("# ")) {
      title ||= line.slice(2).trim();
      continue;
    }

    if (line.startsWith("## ")) {
      section = SECTIONS[line.slice(3).trim()] ?? null;
      item = null;
      continue;
    }

    if (section === undefined) {
      summary.push(line);
      continue;
    }

    const bullet = line.match(/^- (?:\*\*(.+?):\*\*\s*)?(.*)$/);
    if (bullet) {
      item = section ? { area: bullet[1] ?? "", text: bullet[2] } : null;
      if (item) {
        sections[section].push(item);
      }
      continue;
    }

    if (item) {
      item.text = `${item.text} ${line}`;
    }
  }

  return {
    ...(title ? { title } : {}),
    summary: summary.join(" "),
    sections,
  };
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// Each month's hash is of its file's exact bytes, so a reader can key its
// cache on it and tell a stale copy from the current one.
// DEAFCS: each day carries a revision that grows whenever items are added to
// it (state/days.json), and the index names the newest day and its revision,
// so a reader can tell that today's entry gained items.
// monitoredOn: the last day the production check ran (state/production.json),
// so a reader can see that automatic updates have stopped.
export function buildFeed(files, revisions = {}, monitoredOn = null) {
  const months = new Map();
  const areas = new Set();
  let latest = null;

  for (const [date, markdown] of [...files].sort(([a], [b]) => b.localeCompare(a))) {
    const day = { date, revision: revisions[date] ?? 1, ...parseEntry(markdown) };
    latest ??= { date, revision: day.revision };
    for (const item of Object.values(day.sections).flat()) {
      areas.add(item.area);
    }

    const month = date.slice(0, 7);
    if (!months.has(month)) {
      months.set(month, []);
    }
    months.get(month).push(day);
  }

  areas.delete("");

  const output = new Map();
  const index = { months: [], areas: [...areas].sort(), latest, monitoredOn };
  for (const [month, days] of months) {
    const body = json({ month, days });
    output.set(`${month}.json`, body);
    index.months.push({
      month,
      days: days.length,
      hash: createHash("sha256").update(body).digest("hex").slice(0, 16),
    });
  }
  output.set("index.json", json(index));

  return output;
}

export function readEntries(dir = ".") {
  const root = path.join(dir, ENTRIES);
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs
    .readdirSync(root, { recursive: true })
    .filter((file) => /^\d{4}-\d{2}-\d{2}\.md$/.test(path.basename(file)))
    .map((file) => [path.basename(file, ".md"), fs.readFileSync(path.join(root, file), "utf8")]);
}

function readRevisions(dir) {
  const file = path.join(dir, "state", "days.json");
  if (!fs.existsSync(file)) {
    return {};
  }
  const days = JSON.parse(fs.readFileSync(file, "utf8"));
  return Object.fromEntries(Object.entries(days).map(([date, day]) => [date, day.revision]));
}

export function writeFeed(dir = ".") {
  const production = path.join(dir, "state", "production.json");
  const monitoredOn = fs.existsSync(production)
    ? (JSON.parse(fs.readFileSync(production, "utf8")).checkedOn ?? null)
    : null;
  const output = buildFeed(readEntries(dir), readRevisions(dir), monitoredOn);
  const feed = path.join(dir, FEED);

  fs.mkdirSync(feed, { recursive: true });
  for (const file of fs.readdirSync(feed)) {
    if (file.endsWith(".json") && !output.has(file)) {
      fs.rmSync(path.join(feed, file));
    }
  }
  for (const [file, body] of output) {
    fs.writeFileSync(path.join(feed, file), body);
  }
}

export function writeReadme(dir = ".") {
  const entries = readEntries(dir)
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, README_ENTRIES)
    .map(([, markdown]) => markdown.trim().replace(/^(#+) /gm, "#$1 "));

  const readme = [
    "# DEAFCS changelog",
    "",
    "DEAFCS patch notes: new features, improvements and fixes, newest first. They also appear on the DEAFCS Changelog page (Info, then Changelog).",
    "",
    ...entries.flatMap((entry) => [entry, ""]),
    `Older days are in [${ENTRIES}](${ENTRIES}).`,
    "",
  ].join("\n");

  fs.writeFileSync(path.join(dir, "README.md"), readme);
}

if (import.meta.main) {
  writeFeed();
  writeReadme();
}
