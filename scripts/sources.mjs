// Reads what a production release changed in the private DEAFCS repositories:
// the commits between the previous and the new production commit, each folded
// into the pull request that merged it when there is one. Adapted from
// 5stackgg/changelog scripts/changelog.mjs (18fbb58) with 5Stack's permission.
export const ORG = "DEAFCS";

export const SIDES = {
  web: { repo: "deafcs-web", area: "the DEAFCS website" },
  api: { repo: "api-deafcs", area: "the DEAFCS website (server side)" },
};

const SKIP_LABELS = ["no-changelog", "internal"];
const SKIP_TYPES = ["test", "tests", "ci", "chore", "build", "refactor", "style", "revert", "docs"];
const MAX_COMMITS = 300;

export class NotAheadError extends Error {}

export function githubClient(token = process.env.GH_READ_TOKEN, fetcher = fetch) {
  return async (url) => {
    const response = await fetcher(`https://api.github.com${url}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) {
      // The body can quote private repository content; only the status is logged.
      throw new Error(`GitHub request failed with status ${response.status}`);
    }
    return response.json();
  };
}

// Can the read token see the commits of both private repositories? Checked
// before anything else, so a missing, expired or wrongly scoped token fails
// the run with a clear message, instead of every release looking like a
// commit GitHub doesn't know. Needs Contents: read, nothing more.
export async function checkAccess(github, token = process.env.GH_READ_TOKEN) {
  if (!token) {
    return ["GH_READ_TOKEN is not set"];
  }
  const problems = [];
  for (const { repo } of Object.values(SIDES)) {
    try {
      await github(`/repos/${ORG}/${repo}/commits?per_page=1`);
    } catch (error) {
      const status = error.message.match(/status (\d+)/)?.[1] ?? "unknown";
      problems.push(`GH_READ_TOKEN can't read the commits of ${ORG}/${repo} (status ${status})`);
    }
  }
  return problems;
}

function isBot(user) {
  return user?.type === "Bot" || user?.login?.endsWith("[bot]");
}

// The pull request that merged a commit, if the token may read pull requests.
// A token with Contents read only (403) simply uses the commit messages.
async function pullsOf(github, repo, sha) {
  try {
    return await github(`/repos/${ORG}/${repo}/commits/${sha}/pulls`);
  } catch (error) {
    if (/status (403|404)/.test(error.message)) {
      return [];
    }
    throw error;
  }
}

export async function collect({ side, from, to }, github) {
  const { repo } = SIDES[side];
  const commits = [];
  for (let page = 1; ; page++) {
    let compare;
    try {
      compare = await github(`/repos/${ORG}/${repo}/compare/${from}...${to}?per_page=100&page=${page}`);
    } catch (error) {
      // GitHub doesn't know the commit: built from something never pushed.
      // Flag it rather than block every later release behind it.
      if (/status 404/.test(error.message)) {
        throw new NotAheadError(`${side}: the production commit is not on GitHub`);
      }
      throw error;
    }
    if (compare.status !== "ahead" && compare.status !== "identical") {
      // A rollback or a commit from another branch: the range can't be trusted.
      throw new NotAheadError(`${side}: the new production commit is ${compare.status} of the previous one`);
    }
    commits.push(...compare.commits);
    if (compare.commits.length < 100 || commits.length >= compare.total_commits) {
      break;
    }
  }
  if (commits.length > MAX_COMMITS) {
    throw new NotAheadError(`${side}: ${commits.length} commits is more than one release should cover`);
  }

  const items = [];
  const seen = new Set();
  for (const commit of commits) {
    if (commit.parents.length > 1 || isBot(commit.author)) {
      continue;
    }
    const pulls = await pullsOf(github, repo, commit.sha);
    const pull = pulls.find((entry) => entry.merged_at);
    if (pull) {
      if (seen.has(pull.number) || isBot(pull.user)) {
        continue;
      }
      seen.add(pull.number);
      items.push({
        side,
        kind: "pull request",
        title: pull.title ?? "",
        body: pull.body ?? "",
        labels: (pull.labels ?? []).map((label) => label.name.toLowerCase()),
      });
    } else {
      const [title, ...rest] = (commit.commit.message ?? "").split("\n");
      items.push({ side, kind: "commit", title, body: rest.join("\n"), labels: [] });
    }
  }
  return items;
}

// Tests, chores and the like never reach players.
export function eligible(item) {
  if (item.labels.some((label) => SKIP_LABELS.includes(label))) {
    return false;
  }
  const type = item.title.match(/^(\w+)(\([^)]*\))?!?:/)?.[1]?.toLowerCase();
  return !SKIP_TYPES.includes(type);
}
