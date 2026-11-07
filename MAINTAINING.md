# Maintaining the DEAFCS changelog

DRAFT for the proposed public repository `DEAFCS/changelog`. This folder is not a Git repository yet, and nothing here is published.

This one public repository holds the daily patch notes, the JSON feed the DEAFCS Changelog page reads, and the GitHub Actions workflow that keeps both in step with production. It uses no AI and no paid service. Adapted from `5stackgg/changelog` (18fbb58) with 5Stack's permission.

## Deploy → verified → changelog → deafcs.net

1. **A release is deployed**, by Anders or Theft. Its images are built with `--build-arg DEAFCS_COMMIT=<full commit>`, so WEB answers `GET https://deafcs.net/api/version` and API answers `GET /system/version` with `{ "commit": "..." }`.
2. **Every 10 minutes the Changelog workflow checks both** (`scripts/production.mjs`). A new commit counts as a **verified release** once the site has served it for 10 minutes. A release that fails or is rolled back inside that window is never recorded. A push, a branch, a merged pull request or a built image on its own never counts. The release is written to `releases/pending/<release ID>.json`; the ID comes from the live commits.
3. **The same run publishes it** (`scripts/publish.mjs`). For every pending release, oldest first, it:
   - checks the record (verified, full commits, ID). Otherwise the record moves to `releases/flagged/` with the reason.
   - skips a release ID it has already processed.
   - reads the commits from the previous production commit (`state/releases.json`) to the new one, in deafcs-web and/or api-deafcs. A rollback or a commit from another branch is flagged.
   - writes notes (below), drops any already on that day (including ones removed by hand), and appends the rest to `entries/<year>/<date>.md` under New, Improved or Fixed. The date is when the release was verified, in Copenhagen time.
   - records the release as processed and moves the production commits forward.
4. **One commit** holds the entry, the state, `feed/` and `README.md`. If main changed meanwhile, the run starts again from the new main, so nothing is overwritten. A release counts as processed only once that commit is on main.
5. deafcs.net shows it within about 15 minutes. A day that gains notes gets a higher revision, so the Changelog page and the Info → Changelog dot show it as unread again.

A release can also be recorded by hand right after it passes verification (`scripts/record-release.mjs --verified --web-to <commit> --api-to <commit>`). The check later sees the same commits, so it is published once.

## Where the words come from (no AI)

1. **Changelog lines** in a commit or pull request are used as written:
   ```
   Changelog-New: Teams: Team pages show the team's roster and region.
   Changelog-Improved: FAQ: Search also finds words inside answers.
   Changelog-Fixed: Tournaments: Region servers are picked correctly.
   Changelog: skip
   ```
   Claude sessions add them when they commit. Theft can, but doesn't have to.
2. **A commit title without them** is used only if it is clearly for players:
   - it is `feat(…)`, `fix(…)`, `perf(…)` or `ux(…)`;
   - its scope is on the player-facing list in `scripts/notes.mjs` (match, matchmaking, tournaments, leaderboard, polls, faq, teams, and so on);
   - it doesn't mention staff, admin, accounts, sign-in, security, moderation, reports, bans, demos, tests or internals.

   The title becomes the note as it is, with only a capital letter and a full stop added.
3. **Everything else that isn't a test, chore or docs change is held.** That includes other scopes, free-form titles and anything the leak gate catches (links, hashes, code names, infrastructure words, names, em dashes). Held notes are never published. With a `REVIEW_TOKEN`, they are listed in a "Changelog review" issue in the private `DEAFCS/Private-Issues`. The public repository only stores how many were held.

## Commit messages for WEB and API releases

Every commit that changes something players can see gets one line per change, after the commit body:

```
Changelog-New: Search: Press Ctrl+K to find pages, players, help and settings.
Changelog-Improved: Matches: The scoreboard loads faster.
Changelog-Fixed: Tournaments: Check-in no longer closes early.
```

- Format: `Changelog-<New|Improved|Fixed>: <Area>: <text>`. The area is a short player-facing name (Teams, Matches, Matchmaking, Search, Profiles, ...), not a code scope.
- Text: one short sentence for players, in DEAFCS style: what changed for them, no internals, no staff-only details, no links, hashes, names or em dashes.
- A commit with nothing for players (tests, refactors, staff tools, infrastructure) gets `Changelog: skip`.
- Merges and squashes: the lines can also go in the pull request description.
- Without these lines, a `feat`/`fix`/`perf`/`ux` title with a player-facing scope still becomes a note. Everything else is held (below).

## Held notes

A held note is never published on its own, and never lost:

- **Queue.** When a release with held notes is processed, `state/review.json` records it in the same commit: its ID, its commit ranges and its held count. It never stores the held text, because this repository is public. Flagged releases are queued the same way.
- **Issues.** In the same run, `scripts/review.mjs` recalculates the held notes from those ranges and opens one "Changelog review: release <ID> (<date>)" issue per release in the private `DEAFCS/Private-Issues`. It needs `REVIEW_TOKEN` (fine-grained, only that repository, Issues: Read and write). The issue number is stored in the queue.
- **No duplicates.** An existing issue with the same title is reused, so a retried or failed run never opens a second one.
- **Missing or expired token.** The entries stay queued. The run fails once (GitHub emails it), then only warns until the token works again or another release is queued. With a working token, the next run opens every missing issue, however old the release is.
- **Recovery by hand**, on your own computer only (it prints held text): `GH_READ_TOKEN=<read token> node scripts/review.mjs --show <release ID>`.

To publish a held change, add a bullet to that day's entry with GitHub's editor (below), then close the issue. The workflow keeps the bullet and never adds it twice.

## Correcting an entry

Use GitHub's editor: an administrator can click **Edit** next to a day on deafcs.net/changelog, or open `entries/<year>/<date>.md` on GitHub and click the pencil. Edit, then **Commit changes** to main. Anders and Theft can both do this.

- **Reword an item:** change its text. The old wording is remembered as removed.
- **Remove an item:** delete its line. A later release won't add it, or something nearly identical, back that day.
- **Add an item or a summary line:** write it in. A new item counts as an update, so it shows as unread.
- Keep the shape: `# Title`, optional summary lines, then `## New`, `## Improved`, `## Fixed` with `- **Area:** text` bullets.

The commit starts the workflow, which notices the change and rebuilds the feed. Never edit `feed/`, `README.md` or `state/` by hand.

## Flagged releases, failures and retries

- `releases/flagged/<file>`: a release that couldn't be trusted, with the reason. Fix the record (add the full commit as `"to"`, or a missing `"from"`), move it back to `releases/pending/` and commit. Or delete it to skip that release.
- If GitHub fails, that release and every later one stay pending and the run fails. The next run, 10 minutes later, tries again. Production is never touched.
- If production reports no commit (an image built without `DEAFCS_COMMIT`), nothing can be recorded and the run fails, so GitHub emails the failure. A version endpoint that doesn't answer (a short outage) is just tried again; after 30 minutes the run fails too.
- One email per problem: the run fails when a problem starts or changes, then only warns until it clears (`alerted` in `state/production.json`). A dry run only warns. Nothing is lost while a problem lasts: the last published commits stay in `state/releases.json`, so the first release after the fix covers everything since.

## What the production check can and can't prove

- **It proves:** deafcs.net served this commit in every check for at least 10 minutes, less at most 30 seconds: checks run 10 minutes apart, so the last one can land a moment before the window ends, and counting it saves a whole extra 10 minutes. Kubernetes only sends traffic to pods that pass their readiness checks, so the release was up, healthy and not rolled back in that time.
- **It doesn't prove** that the release's own checks (routes, bundle markers, logs) passed. For Anders's releases, Claude records the release by hand after that verification. For Theft's releases, the 10 stable minutes are the verification.
- **Two releases within 10 minutes:** the first never counts on its own, but nothing is lost. The second one's range starts at the last published commit, so it includes the first release's commits. If the second release is a rollback, the first one's changes are no longer live and are rightly not published.
- **A release between two checks** (live less than 10 minutes, then replaced) is covered the same way by the next release that stays.
- **GitHub sometimes runs scheduled workflows late.** That only delays a release, because the check compares production with what it last saw, not with events.
- **A commit GitHub doesn't know** (built from something never pushed) is flagged, and later releases still publish.

## Settings (all free)

- Repository variable `CHANGELOG_ENABLED` = `true` turns the automatic runs on. Without it, only runs started by hand work, and those are dry runs by default (they show what would change and commit nothing). See SETUP.md.

- Repository variables: `WEB_VERSION_URL` (`https://deafcs.net/api/version`) and `API_VERSION_URL` (the public URL of the API's `/system/version`).
- Secret `GH_READ_TOKEN`: fine-grained token, resource owner DEAFCS, only `deafcs-web` and `api-deafcs`, **Contents: read** (Metadata: read is added automatically), with an expiration. It can't write anything. Adding Pull requests: read is optional: it lets pull request descriptions be used too.
- The workflow's own token can write only this repository (`contents: write`). WEB, API and production hold no changelog credential.
- Optional secret `REVIEW_TOKEN`: fine-grained token, only `DEAFCS/Private-Issues`, Issues read and write.
- Optional secret `CHANGELOG_BLOCKLIST`: names that must never appear, one per line.
- GitHub pauses scheduled workflows in a public repository after 60 days without commits. Releases keep it active; after a long quiet spell, re-enable it on the Actions tab.

This repository is public, and so are its workflow logs. They show release IDs and counts only.

## Game servers, streamer and demo parser (off until `CHANGELOG_COMPONENTS` names them)

Repository variable `CHANGELOG_COMPONENTS` turns each component on separately, comma-separated: `gameserver`, `streamer`, `demoparser`. Unset or empty means none, and every run does exactly what it did before. 5stack-panel is never a source: its commits are infrastructure pins.

- **What counts:** only what production reports, through the API's `/system/version`:
  - `gameServer.server` and `gameServer.practice`: the images new match and practice servers start from. An image counts only when its digest is the image of a DEAFCS/game-server release (`sw-v0.0.N` = `ghcr.io/deafcs/game-server-sw:v0.0.N`, `css-v0.0.N` = `game-server-css`); the release tag names the commit.
  - `streamer`: the image live streams and highlight renders start from (`ghcr.io/deafcs/game-streamer`).
  - `demoParser`: the image the running demo-parser pods use (`ghcr.io/deafcs/demo-parser`).
  For the streamer and the demo parser the commit is the image's `org.opencontainers.image.revision` label, read from ghcr.io by digest, and only once that commit exists on GitHub. Only images pinned by digest count. A pushed commit or a built image is never published. The same 10 stable minutes apply.
- **Releases:** components that settle in the same check are one release with WEB and API. A component joins the release ID only when the release has it, so every WEB/API release keeps its ID.
- **Match and practice on different releases:** the newer one counts. Its range covers the older one, so nothing is published twice when the other catches up.
- **Notes:** the same rules as WEB and API: Changelog lines first, then titles with a scope from that component's list, everything else held for private review. `Changelog: skip` works the same.
  - Game server: in-match scopes (`match`, `leaver`, `surrender`, `forfeit`, `timeout`, `warmup`, `restore`, `disconnect`, `tournament`, `practice`, `pracc`, `utility-sw`).
  - Streamer: `stream`, `streams`, `live`, `clips`, `highlights`, `watch`.
  - Demo parser: none. Its titles are technical, so only Changelog lines publish.
  - Upstream 5Stack titles (`bug: ...`, `feature: ...`) never publish by themselves.
  - A component title note that says the same as a WEB note in the release is dropped. For one feature across repositories, give the Changelog line to the repository players see and `Changelog: skip` to the others.
- **Commits pushed without Changelog lines** (upstream cherry-picks): add their lines to `notes/overrides.json` under the component, keyed by the full commit, or `"skip"`. An override is used only while a release's own commit range is read, so it never publishes early. `npm test` checks every line against the same filter as the notes.
- **An image that can't be traced to a commit** (built by hand, no label, commit not pushed): the run fails once, then only warns; nothing is recorded for that component until it can be. A registry or GitHub hiccup is retried quietly and reported once after 30 minutes. Neither touches WEB or API tracking or the monitoring date.
- `state/game-server-images.json` and `state/component-images.json` remember which digest is which commit, so the registry is asked once per new image. Never edit them by hand.
- `state/releases.json` `lastDeployed.<component>` is where the next range starts. Set it once before turning a component on; without it a release is flagged, not guessed.
- **Recording by hand:** `node scripts/record-release.mjs --verified --streamer-from <commit> --streamer-to <commit> --verified-at <time> --no-push` (also `--gameserver-…`, `--demoparser-…`) works while detection is off. The run checks that `GH_READ_TOKEN` can read that repository first.
- **Needs:**
  - `GH_READ_TOKEN` with Contents: read on `game-server`, `game-streamer` and `demo-parser` too.
  - Each package (`game-server-sw`, `game-server-css`, `game-streamer`, `demo-parser`) must give `DEAFCS/changelog` Read access (Package settings → Manage Actions access), so the workflow's own token can read digests and labels (`packages: read`). No new secret.
  - An API whose `/system/version` reports the fields above.
