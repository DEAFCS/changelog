// Publishes every verified release waiting in releases/pending, oldest first,
// into the day's entry, then rebuilds the feed. Run by the Publish workflow;
// the workflow commits the result in one commit, so an entry, its state and
// the feed always change together, and a release counts as processed only
// once that commit is on main.
//
// The logs are public: they print release IDs, counts and our own reasons,
// never commit text or patch-note text.
import fs from "node:fs";
import path from "node:path";
import { appendItems, copenhagenDate, dayTitle, dedupe, entryPath } from "./entry.mjs";
import { writeFeed, writeReadme } from "./feed.mjs";
import { notesFor } from "./notes.mjs";
import { validateRecord } from "./release.mjs";
import { collect, NotAheadError } from "./sources.mjs";
import { loadState, saveState, syncAll } from "./state.mjs";

const PENDING = "releases/pending";
const FLAGGED = "releases/flagged";

function readPending(dir) {
  const root = path.join(dir, PENDING);
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs
    .readdirSync(root)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      let record = null;
      try {
        record = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
      } catch {}
      return { file, record };
    })
    .sort(
      (a, b) =>
        String(a.record?.verifiedAt ?? "").localeCompare(String(b.record?.verifiedAt ?? "")) ||
        a.file.localeCompare(b.file),
    );
}

function flag(dir, file, record, reason) {
  fs.mkdirSync(path.join(dir, FLAGGED), { recursive: true });
  fs.writeFileSync(
    path.join(dir, FLAGGED, file),
    `${JSON.stringify({ ...(record ?? {}), flagged: { reason } }, null, 2)}\n`,
  );
  fs.rmSync(path.join(dir, PENDING, file));
}

export async function publish(dir, { github, blocked = [] } = {}) {
  const state = loadState(dir);
  syncAll(dir, state.days);
  const report = { processed: [], skipped: [], flagged: [], failed: null, added: 0, held: 0, review: [] };
  // A flagged release waits for a person; the review issue says why.
  const queueFlagged = (file, reason) => {
    state.review.releases[`flagged:${file}`] ??= { flagged: reason, issue: null };
  };

  for (const { file, record } of readPending(dir)) {
    const problem = validateRecord(record);
    if (problem) {
      flag(dir, file, record, problem);
      report.flagged.push({ file, reason: problem });
      queueFlagged(file, problem);
      continue;
    }
    if (state.releases.processed[record.id]) {
      fs.rmSync(path.join(dir, PENDING, file));
      report.skipped.push(record.id);
      continue;
    }

    const ranges = [];
    let missing = null;
    for (const side of ["web", "api"]) {
      if (!record[side]) {
        continue;
      }
      const from = record[side].from ?? state.releases.lastDeployed[side];
      if (!from) {
        missing = `${side}: no previous production commit is known; add "from" to the record`;
        break;
      }
      if (from !== record[side].to) {
        ranges.push({ side, from, to: record[side].to });
      }
    }
    if (missing) {
      flag(dir, file, record, missing);
      report.flagged.push({ file, reason: missing });
      queueFlagged(file, missing);
      continue;
    }

    const date = copenhagenDate(record.verifiedAt);
    const day = (state.days[date] ??= { revision: 0, items: {} });
    let notes;
    try {
      const changes = [];
      for (const range of ranges) {
        changes.push(...(await collect(range, github)));
      }
      notes = await notesFor(changes, { blocked });
    } catch (error) {
      if (error instanceof NotAheadError) {
        flag(dir, file, record, error.message);
        report.flagged.push({ file, reason: error.message });
        queueFlagged(file, error.message);
        continue;
      }
      // Stop here: later releases build on this one's range, so they wait too.
      // Nothing of this release has been written; the next run retries it.
      report.failed = { id: record.id, message: error.message };
      break;
    }

    const fresh = dedupe(notes.items, Object.values(day.items));
    if (fresh.length > 0) {
      const target = path.join(dir, entryPath(date));
      const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, appendItems(current, dayTitle(date), fresh));
      for (const { id, type, area, text } of fresh) {
        day.items[id] = { type, area, text, status: "published", source: `release:${record.id}` };
      }
      day.revision += 1;
    }

    state.releases.processed[record.id] = {
      date,
      verifiedAt: record.verifiedAt,
      web: record.web?.to ?? null,
      api: record.api?.to ?? null,
      added: fresh.length,
      held: notes.review.length,
    };
    for (const side of ["web", "api"]) {
      if (record[side]) {
        state.releases.lastDeployed[side] = record[side].to;
      }
    }
    fs.rmSync(path.join(dir, PENDING, file));
    report.processed.push({ id: record.id, date, added: fresh.length });
    report.added += fresh.length;
    report.held += notes.review.length;
    // Held notes stay recoverable: the queue keeps the commit ranges they came
    // from, and scripts/review.mjs recalculates them for the private issue.
    if (notes.review.length > 0) {
      state.review.releases[record.id] = {
        date,
        verifiedAt: record.verifiedAt,
        ranges,
        held: notes.review.length,
        issue: null,
      };
      report.review.push({ release: record.id, date, items: notes.review });
    }
  }

  // Days with nothing left (e.g. the only item was a release with no
  // player-facing change) never got a file, so they get no feed entry.
  for (const [date, day] of Object.entries(state.days)) {
    if (day.revision === 0 && Object.keys(day.items).length === 0) {
      delete state.days[date];
    }
  }
  saveState(dir, state);
  writeFeed(dir);
  writeReadme(dir);
  return report;
}

if (import.meta.main) {
  const { checkAccess, githubClient } = await import("./sources.mjs");
  const { blocklist } = await import("./redact.mjs");
  const github = githubClient();

  // A credential problem stops here, before any release is looked at, so it
  // is reported as one, not as releases flagged for review.
  const denied = await checkAccess(github);
  if (denied.length > 0) {
    for (const problem of denied) {
      console.log(problem);
    }
    console.log("Nothing processed. Fix GH_READ_TOKEN (see SETUP.md, step 3) and run again.");
    process.exit(1);
  }
  console.log("GH_READ_TOKEN can read deafcs-web and api-deafcs.");

  const report = await publish(".", {
    github,
    blocked: blocklist(process.env.CHANGELOG_BLOCKLIST),
  });

  for (const { id, date, added } of report.processed) {
    console.log(`Processed release ${id} for ${date}: ${added} new item(s)`);
  }
  for (const id of report.skipped) {
    console.log(`Already processed, skipped: ${id}`);
  }
  for (const { file, reason } of report.flagged) {
    console.log(`Flagged for review: ${file} (${reason})`);
  }
  console.log(`Added ${report.added}, held for review ${report.held}`);

  if (report.failed) {
    console.log(`Failed on release ${report.failed.id}; it stays pending and is retried on the next run.`);
    process.exitCode = 1;
  }
}
