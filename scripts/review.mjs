// Turns the review queue (state/review.json) into issues in a private
// repository (DEAFCS/Private-Issues by default): one issue per release with
// held notes, and one per flagged release, so Anders or Theft can add a note
// by hand if it should be public. Run by the Publish workflow after
// publish.mjs, in the same commit.
//
// - The queue keeps only release IDs, commit ranges and counts. The held
//   notes are recalculated from the commit ranges here, so they are never
//   lost: not by a failed run, a missing or expired REVIEW_TOKEN, or a release
//   that was processed long ago.
// - One issue per queue entry, never two: an existing issue with the entry's
//   title is reused, so a run that made the issue but couldn't push its state
//   doesn't make a second one.
// - Without a working REVIEW_TOKEN the entries stay queued and the run fails
//   once per problem (GitHub emails it), then only warns until it is fixed or
//   more releases are queued.
// - The logs are public: they print release IDs, counts and issue numbers,
//   never held text. A dry run only reads.
//
// Recovery on your own computer, never in CI (prints held text):
//   GH_READ_TOKEN=... node scripts/review.mjs --show <release ID>
import { notesFor } from "./notes.mjs";
import { readOverrides } from "./overrides.mjs";
import { collect } from "./sources.mjs";
import { loadState, saveState } from "./state.mjs";

export const REVIEW_REPO = process.env.REVIEW_REPO || "DEAFCS/Private-Issues";

export const issueTitle = (key, entry) =>
  entry.flagged ? `Changelog review: flagged ${key.slice("flagged:".length)}` : `Changelog review: release ${key} (${entry.date})`;

// The held notes of one queued release, recalculated from its commit ranges
// with the same overrides publishing used.
export async function heldNotes(entry, github, blocked = [], overrides = {}) {
  const changes = [];
  for (const range of entry.ranges ?? []) {
    changes.push(...(await collect(range, github, overrides[range.side])));
  }
  return (await notesFor(changes, { blocked })).review;
}

export function reviewBody(key, entry, held = [], runUrl = "") {
  const lines = [`<!-- changelog-review:${key} -->`];
  if (entry.flagged) {
    lines.push(
      `The Publish workflow flagged \`releases/flagged/${key.slice("flagged:".length)}\` and did not publish it.`,
      "",
      `Reason: ${entry.flagged}`,
      "",
      "Fix the record and move it back to releases/pending, or delete it to skip the release (MAINTAINING.md, Flagged releases).",
    );
  } else {
    lines.push(
      `Release ${key}, published on ${entry.date}. These notes were held back and are not on deafcs.net:`,
      "",
      ...held.map(({ reason, note }) => `- **${reason}**: ${note.replaceAll("\n", " ")}`),
      "",
      `To publish one, add it as a bullet to entries/${entry.date.slice(0, 4)}/${entry.date}.md in DEAFCS/changelog (GitHub's editor is fine). The workflow keeps it and never adds it twice. Close this issue when done.`,
    );
  }
  if (runUrl) {
    lines.push("", `Run: ${runUrl}`);
  }
  return `${lines.join("\n")}\n`;
}

// REST client for the review repository, with the review token.
export function issuesClient(token, fetcher = fetch, repo = REVIEW_REPO) {
  const request = async (method, url, body) => {
    const response = await fetcher(`https://api.github.com/repos/${repo}${url}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      throw new Error(`review repository request failed with status ${response.status}`);
    }
    return response.json();
  };
  return {
    // Every review issue so far, open or closed, by title.
    async titles() {
      const found = new Map();
      for (let page = 1; page <= 20; page++) {
        const batch = await request("GET", `/issues?state=all&per_page=100&page=${page}`);
        for (const issue of batch) {
          if (!issue.pull_request && issue.title.startsWith("Changelog review: ")) {
            found.set(issue.title, issue.number);
          }
        }
        if (batch.length < 100) {
          break;
        }
      }
      return found;
    },
    async create(title, body) {
      return (await request("POST", "/issues", { title, body })).number;
    },
  };
}

export async function syncReview(dir, { github, issues = null, blocked = [], dryRun = false, runUrl = "", now = new Date() } = {}) {
  const state = loadState(dir);
  const review = state.review;
  const open = Object.entries(review.releases).filter(([, entry]) => !entry.issue);
  const report = { open: open.length, issued: [], reused: [], problem: null, alert: false };

  if (open.length > 0) {
    if (!issues) {
      report.problem = "REVIEW_TOKEN is not set";
    } else {
      try {
        const existing = await issues.titles();
        for (const [key, entry] of open) {
          const title = issueTitle(key, entry);
          if (existing.has(title)) {
            entry.issue = existing.get(title);
            report.reused.push({ key, issue: entry.issue });
          } else if (!dryRun) {
            const held = entry.flagged ? [] : await heldNotes(entry, github, blocked, readOverrides(dir, blocked));
            entry.issue = await issues.create(title, reviewBody(key, entry, held, runUrl));
            report.issued.push({ key, issue: entry.issue });
          } else {
            report.issued.push({ key, issue: "(dry run)" });
            continue;
          }
          entry.issuedAt = now.toISOString().replace(/\.\d{3}Z$/, "Z");
        }
      } catch (error) {
        report.problem = error.message.replace(/[\r\n]+/g, " ");
      }
    }
  }

  const stillOpen = Object.values(review.releases).filter((entry) => !entry.issue).length;
  report.open = stillOpen;
  if (report.problem && stillOpen > 0) {
    // Email once per problem, and again whenever more releases wait.
    const last = review.alerted;
    report.alert = !last || last.problem !== report.problem || stillOpen > last.open;
    if (report.alert) {
      review.alerted = { problem: report.problem, open: stillOpen, since: now.toISOString().replace(/\.\d{3}Z$/, "Z") };
    }
  } else if (stillOpen === 0) {
    review.alerted = null;
  }
  if (!dryRun) {
    saveState(dir, state);
  }
  return report;
}

if (import.meta.main) {
  const { blocklist } = await import("./redact.mjs");
  const { githubClient } = await import("./sources.mjs");
  const blocked = blocklist(process.env.CHANGELOG_BLOCKLIST);

  const show = process.argv.indexOf("--show");
  if (show >= 0) {
    if (process.env.GITHUB_ACTIONS) {
      console.log("--show prints held text and never runs in GitHub Actions (public logs).");
      process.exit(1);
    }
    const key = process.argv[show + 1];
    const entry = loadState(".").review.releases[key];
    if (!entry) {
      console.log(`No review entry ${key} in state/review.json.`);
      process.exit(1);
    }
    const held = entry.flagged ? [] : await heldNotes(entry, githubClient(), blocked, readOverrides(".", blocked));
    process.stdout.write(reviewBody(key, entry, held));
    process.exit(0);
  }

  const token = process.env.REVIEW_TOKEN;
  const report = await syncReview(".", {
    github: githubClient(),
    issues: token ? issuesClient(token) : null,
    blocked,
    dryRun: process.env.DRY_RUN === "true",
    runUrl: process.env.RUN_URL ?? "",
  });
  for (const { key, issue } of report.issued) {
    console.log(`Review issue ${issue} for ${key}`);
  }
  for (const { key, issue } of report.reused) {
    console.log(`Review issue ${issue} already existed for ${key}`);
  }
  if (report.open > 0) {
    console.log(`::warning::${report.open} release(s) wait for a private review issue: ${report.problem}. Nothing is lost; see MAINTAINING.md, Held notes.`);
  }
  if (report.alert) {
    console.log(`::error::Held notes or flagged releases need review, but ${report.problem}.`);
    process.exitCode = 1;
  }
}
