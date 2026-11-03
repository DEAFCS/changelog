// Turns a release's commits into patch-note items, without AI.
//
// 1. Changelog lines in a commit or pull request are used as written:
//      Changelog-New: Community Polls: Verified players can vote in polls.
//      Changelog-Improved: FAQ: Search also finds words inside answers.
//      Changelog-Fixed: Matches: The scoreboard loads again.
//      Changelog: skip            (nothing for players)
// 2. A commit without them is used only if its title is clearly about
//    something players see: "feat", "fix", "perf" or "ux" with a scope from
//    the player-facing list below, and no word that points at staff tools,
//    accounts, security, moderation or infrastructure. The title itself
//    becomes the note; nothing is added to it.
// 3. Every other player-facing commit is held, and so is any note the leak
//    gate catches. Held notes are never published: they go to the private
//    review list.
// Tests, chores, docs, refactors and bots never need a note at all.
import { violations } from "./redact.mjs";
import { eligible } from "./sources.mjs";
import { renderItem } from "./entry.mjs";

const TRAILER = /^changelog-(new|improved|fixed):\s*(?:([^:\n]{1,40}):\s+)?(.+)$/i;
const SKIP = /^changelog:\s*(skip|none)\s*$/im;

export function parseTrailers(message) {
  if (SKIP.test(message)) {
    return { skip: true, items: [] };
  }
  const items = [];
  for (const line of message.split("\n")) {
    const match = line.trim().match(TRAILER);
    if (match) {
      items.push({ type: match[1].toLowerCase(), area: (match[2] ?? "").trim(), text: match[3].trim() });
    }
  }
  return { skip: false, items };
}

const TYPES = { feat: "new", fix: "fixed", perf: "improved", ux: "improved" };

// Scopes whose changes players see, and the area they appear under.
export const PLAYER_SCOPES = {
  match: "Matches",
  matches: "Matches",
  matchmaking: "Matchmaking",
  play: "Matchmaking",
  lobby: "Lobbies",
  draft: "Draft",
  tournament: "Tournaments",
  tournaments: "Tournaments",
  league: "Leagues",
  leagues: "Leagues",
  scrims: "Scrims",
  leaderboard: "Leaderboards",
  seasons: "Seasons",
  highlights: "Highlights",
  clips: "Highlights",
  watch: "Watch",
  practice: "Practice",
  utility: "Utility",
  polls: "Community Polls",
  news: "News",
  events: "Events",
  awards: "Awards",
  faq: "FAQ",
  contact: "Contact",
  profile: "Profiles",
  players: "Profiles",
  team: "Teams",
  teams: "Teams",
  chat: "Chat",
  notifications: "Notifications",
  changelog: "Changelog",
};

// Game-server scopes: what happens in a match or on a practice server. Only
// game-server commits use them, so WEB and API titles read as before.
export const GAME_SERVER_SCOPES = {
  match: "Matches",
  matches: "Matches",
  leaver: "Matches",
  surrender: "Matches",
  forfeit: "Matches",
  timeout: "Matches",
  warmup: "Matches",
  restore: "Matches",
  disconnect: "Matches",
  tournament: "Tournaments",
  practice: "Practice",
  pracc: "Practice",
  "utility-sw": "Utility",
};

const TITLE = /^(feat|fix|perf|ux)\(([a-z0-9-]+)\)!?:\s+(.+)$/i;

// Words that make a title not clearly safe for players to read.
const HOLD_WORDS =
  /\b(admin\w*|staff|moderat\w*|auth\w*|log ?(in|out)|sign[- ]?(in|out)|sessions?|security|secure|exploit\w*|vulnerab\w*|cheat\w*|bans?|banned|sanction\w*|reports?|reporting|abuse|private|internal|demo|wip|temp\w*|test\w*|debug\w*|revert\w*|rollbacks?|hotfix|workaround|server[- ]side|sockets?|cache\w*|queue workers?|metadata|schema|endpoint\w*|webhooks?|cron|jobs?|env\w*|config\w*|deploy\w*)\b/i;

// The note a commit title gives, or why it doesn't give one.
export function titleNote(title, side = "web") {
  const match = title.trim().match(TITLE);
  if (!match) {
    return { held: "title is not feat/fix/perf/ux(scope): ..." };
  }
  const [, kind, scope, subject] = match;
  const area = (side === "gameserver" ? GAME_SERVER_SCOPES : PLAYER_SCOPES)[scope.toLowerCase()];
  if (!area) {
    return { held: `scope "${scope}" is not on the player-facing list` };
  }
  const text = subject.trim().replace(/[.\s]+$/, "");
  if (text.length < 12 || text.length > 160) {
    return { held: "title is too short or too long to read as a note" };
  }
  if (HOLD_WORDS.test(text)) {
    return { held: "title mentions staff, accounts, security, moderation or internals" };
  }
  return {
    item: { type: TYPES[kind.toLowerCase()], area, text: `${text[0].toUpperCase()}${text.slice(1)}.` },
  };
}

// Words that say nothing about which feature a note is about.
const GENERIC = new Set([
  "about", "after", "again", "also", "and", "are", "can", "every", "for", "from", "has", "have",
  "into", "its", "more", "new", "now", "only", "page", "pages", "player", "players", "show",
  "shows", "that", "the", "their", "them", "then", "this", "when", "with", "your",
]);

function featureWords(text) {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2 && !GENERIC.has(word)),
  );
}

// Same area, same kind of change, and at least two feature words in common.
export function sameFeature(a, b) {
  if (a.area !== b.area || a.type !== b.type) {
    return false;
  }
  const right = featureWords(b.text);
  return [...featureWords(a.text)].filter((word) => right.has(word)).length >= 2;
}

const LABELS = { web: "WEB", api: "API", gameserver: "GAME SERVER" };

export async function notesFor(changes, { blocked = [] } = {}) {
  const candidates = [];
  const titled = [];
  const review = [];
  for (const change of changes) {
    const { skip, items } = parseTrailers(`${change.title}\n${change.body}`);
    if (skip) {
      continue;
    }
    if (items.length > 0) {
      candidates.push(...items);
      continue;
    }
    if (!eligible(change)) {
      continue;
    }
    const { item, held } = titleNote(change.title, change.side);
    if (item) {
      titled.push({ ...item, side: change.side });
    } else {
      review.push({ reason: held, note: `${LABELS[change.side] ?? change.side.toUpperCase()} ${change.kind}: ${change.title.trim()}` });
    }
  }

  // One feature often has a WEB and an API (or game-server) commit with
  // different titles. Players see the WEB side, so an API or game-server
  // title note is dropped when a WEB title note in the same release clearly
  // describes the same feature. Changelog lines are never dropped here: their
  // author chose them.
  for (const item of titled) {
    const twin = item.side !== "web" && titled.find((other) => other.side === "web" && sameFeature(other, item));
    if (twin) {
      review.push({ reason: "same feature as a WEB note", note: renderItem(item) });
    } else {
      candidates.push({ type: item.type, area: item.area, text: item.text });
    }
  }

  const items = [];
  for (const item of candidates) {
    const found = violations(renderItem(item), blocked);
    if (found.length > 0) {
      review.push({ reason: `filter: ${found.join(", ")}`, note: renderItem(item) });
    } else {
      items.push(item);
    }
  }
  return { items, review };
}
