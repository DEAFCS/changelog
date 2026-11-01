// One Markdown entry per Copenhagen calendar day. New items are appended to
// the day's file as it is now, so a correction made by hand is kept: nothing
// already in the file is rewritten.
import { createHash } from "node:crypto";
import path from "node:path";
import { parseEntry, SECTIONS } from "./feed.mjs";

export const TYPES = ["new", "improved", "fixed"];
const HEADINGS = { new: "## New", improved: "## Improved", fixed: "## Fixed" };
const ENTRIES = "entries";

const DATE_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Copenhagen",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const TITLE_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

// The day a release belongs to: when it passed verification, in Copenhagen.
export function copenhagenDate(iso) {
  return DATE_FORMAT.format(new Date(iso));
}

export function dayTitle(date) {
  return `Patch Notes | ${TITLE_FORMAT.format(new Date(`${date}T00:00:00Z`))}`;
}

export function entryPath(date) {
  return path.posix.join(ENTRIES, date.slice(0, 4), `${date}.md`);
}

function normalize(text) {
  return text.toLowerCase().replace(/\s+/g, " ").replace(/[.\s]+$/, "").trim();
}

export function itemId({ area, text }) {
  return createHash("sha256")
    .update(`${normalize(area ?? "")}|${normalize(text)}`)
    .digest("hex")
    .slice(0, 12);
}

export function renderItem({ area, text }) {
  return area ? `- **${area}:** ${text}` : `- ${text}`;
}

export function readItems(markdown) {
  const { sections } = parseEntry(markdown ?? "");
  return TYPES.flatMap((type) =>
    sections[type].map(({ area, text }) => ({ type, area, text, id: itemId({ area, text }) })),
  );
}

function sectionType(line) {
  const trimmed = line.trim();
  return trimmed.startsWith("## ") ? (SECTIONS[trimmed.slice(3).trim()] ?? null) : undefined;
}

// Adds items under their sections, creating a missing section in New,
// Improved, Fixed order. Everything already in the file stays as it is.
export function appendItems(markdown, title, items) {
  const lines = (markdown ?? `# ${title}\n`).replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");

  for (const type of TYPES) {
    const bullets = items.filter((item) => item.type === type).map(renderItem);
    if (bullets.length === 0) {
      continue;
    }

    const heading = lines.findIndex((line) => sectionType(line) === type);
    if (heading >= 0) {
      let end = lines.findIndex((line, index) => index > heading && sectionType(line) !== undefined);
      if (end < 0) {
        end = lines.length;
      }
      let last = end - 1;
      while (last > heading && lines[last].trim() === "") {
        last--;
      }
      const insert = last === heading ? [""].concat(bullets) : bullets;
      lines.splice(last + 1, 0, ...insert);
      continue;
    }

    const later = lines.findIndex((line) => {
      const found = sectionType(line);
      return found && TYPES.indexOf(found) > TYPES.indexOf(type);
    });
    const block = [HEADINGS[type], "", ...bullets];
    if (later >= 0) {
      lines.splice(later, 0, ...block, "");
    } else {
      lines.push("", ...block);
    }
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

// Near-duplicates: most of the meaningful words are the same.
function words(text) {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2),
  );
}

export function similar(a, b) {
  const left = words(`${a.area ?? ""} ${a.text}`);
  const right = words(`${b.area ?? ""} ${b.text}`);
  if (left.size === 0 || right.size === 0) {
    return false;
  }
  const shared = [...left].filter((word) => right.has(word)).length;
  const jaccard = shared / (left.size + right.size - shared);
  const containment = shared / Math.min(left.size, right.size);
  return jaccard >= 0.7 || (containment >= 0.9 && Math.min(left.size, right.size) >= 4);
}

// Drops candidates already on the day (published or removed by hand) and
// repeats within the candidates themselves.
export function dedupe(candidates, known) {
  const kept = [];
  for (const candidate of candidates) {
    const item = { ...candidate, id: itemId(candidate) };
    const clash = (other) => other.id === item.id || similar(other, item);
    if (known.some(clash) || kept.some(clash)) {
      continue;
    }
    kept.push(item);
  }
  return kept;
}
