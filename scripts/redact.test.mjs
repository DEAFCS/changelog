// Ported from 5stackgg/changelog scripts/redact.test.mjs (18fbb58) with
// 5Stack's permission, with DEAFCS domains and checks added at the end.
import assert from "node:assert/strict";
import { test } from "node:test";
import { blocklist, finalize, gate, sanitize, violations } from "./redact.mjs";

test("sanitize strips links, references, code and contact details", () => {
  const body = [
    "Fixes 5stackgg/api#853 and web#1012, see #42.",
    "Reported on https://panel.example.net/matches/1 by ops@example.net from 10.0.0.12.",
    "<!-- internal note -->",
    "```sql\nselect * from v_my_friends;\n```",
    "Docs: [install guide](https://deafcs.net/faq) on deafcs.net.",
  ].join("\n");

  const clean = sanitize(body);

  assert.doesNotMatch(clean, /853|1012|#42/);
  assert.doesNotMatch(clean, /example\.net|ops@|10\.0\.0\.12/);
  assert.doesNotMatch(clean, /internal note|v_my_friends/);
  assert.match(clean, /install guide/);
  assert.match(clean, /deafcs\.net/);
});

test("sanitize replaces code names and drops tables", () => {
  const body = [
    "The bell reads `notifications_aggregate` and GAME_STREAMER_AMD_MEMORY_* once per poll.",
    "| query | before | after |",
    "| --- | --- | --- |",
    "| bell | 9 ms | 1 ms |",
    "Players see new notifications sooner.",
  ].join("\n");

  assert.equal(
    sanitize(body),
    "The bell reads [code] and [code] once per poll.\n\nPlayers see new notifications sooner.",
  );
});

test("sanitize redacts blocklisted terms in any case", () => {
  const clean = sanitize("Outage on Acme League panel", blocklist("acme league\nother"));
  assert.equal(clean, "Outage on [redacted] panel");
});

test("violations flags each kind of leak", () => {
  const cases = {
    url: "- **Matches:** see https://deafcs.net/matches",
    email: "- **Matches:** contact ops@example.net",
    ip: "- **Game servers:** nodes on 192.168.1.20 reconnect",
    reference: "- **Seasons:** fixed after #853",
    handle: "- **Docs:** thanks to @someone",
    identifier: "- **Drafts:** is_draft_game_player_organizer is faster",
    secret: "- **Self-hosting:** token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    domain: "- **Self-hosting:** panels like play.example.net update",
  };

  for (const [rule, line] of Object.entries(cases)) {
    assert.ok(violations(line).includes(rule), `${rule}: ${line}`);
  }
});

test("violations passes plain user-facing entries", () => {
  const lines = [
    "Tournament matches now count toward seasons, and self-hosted panels can use AMD GPUs.",
    "- **Leaderboards:** Event leaderboards have an ELO Gained tab that ranks players by how much the event moved their rating.",
    "- **Self-hosting:** Panels route traffic through Traefik and the Gateway API instead of ingress-nginx.",
    "- **Demos:** Admins choose which role can upload demos; every signed-in player can by default.",
    "- **Game servers:** On Ubuntu 26.04 nodes, ending a match stops its CS2 server again.",
    "- **Matches:** Visit deafcs.net to see the new scoreboard.",
  ];

  for (const line of lines) {
    assert.deepEqual(violations(line), [], line);
  }
});

test("gate drops offending lines and sections left empty", () => {
  const summary = [
    "A day of fixes.",
    "",
    "## New",
    "- **Friends:** v_my_friends reads once per poll.",
    "",
    "## Fixed",
    "- **Seasons:** Tournament matches count toward the season.",
    "- **Matches:** Fixed after api#853.",
  ].join("\n");

  const { markdown, dropped } = gate(summary);

  assert.equal(
    markdown,
    ["A day of fixes.", "", "## Fixed", "- **Seasons:** Tournament matches count toward the season."].join("\n"),
  );
  assert.deepEqual(dropped, { identifier: 1, reference: 1 });
});

test("gate drops blocklisted terms", () => {
  const { markdown, dropped } = gate("## Fixed\n- **Matches:** Acme panel reconnects.", ["acme"]);
  assert.equal(markdown, "");
  assert.deepEqual(dropped, { blocklist: 1 });
});

test("finalize gates the text the format check produced, not the text before it", () => {
  const { markdown, malformed, dropped } = finalize(
    [
      "Token ghp_**abc123** in a summary.",
      "Name is_**draft** in a summary.",
      "A clean summary line.",
      "",
      "## Fixed",
      "- **Seasons:** Tournament matches count.",
    ].join("\n"),
  );

  assert.equal(
    markdown,
    ["A clean summary line.", "", "## Fixed", "- **Seasons:** Tournament matches count."].join("\n"),
  );
  assert.equal(malformed, 0);
  // DEAFCS: "Token" is also an infrastructure word here.
  assert.deepEqual(dropped, { identifier: 2, secret: 1, infrastructure: 1 });
});

// DEAFCS checks.
test("sanitize strips commit hashes", () => {
  assert.equal(
    sanitize("Fixed in 2facca57 and b207eb0bf1293bf4dd9ca129d49871f3d6f4bf1c."),
    "Fixed in [commit] and [commit].",
  );
  assert.equal(sanitize("Season 2026 starts in 10 days."), "Season 2026 starts in 10 days.");
});

test("violations flags DEAFCS infrastructure, commit hashes and em dashes", () => {
  const cases = {
    commit: "- **Matches:** Fixed in 2facca57.",
    infrastructure: "- **Matches:** Hasura now returns the scoreboard faster.",
    dash: "- **Matches:** The scoreboard is faster — and clearer.",
  };

  for (const [rule, line] of Object.entries(cases)) {
    assert.ok(violations(line).includes(rule), `${rule}: ${line}`);
  }
  assert.ok(violations("- **Matches:** Live after the new deployment.").includes("infrastructure"));
});
