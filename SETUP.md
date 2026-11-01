# Setting up DEAFCS/changelog (checklist)

Every step needs Anders's approval. All of it is free: a public repository, GitHub-hosted runners (free for public repositories), a fine-grained token, repository variables and secrets. No AI, Copilot or paid GitHub feature is used.

## 0. Before anything

- [ ] WEB `a72fc9b8` and API `4152f848` (version endpoints) are on `main`. They are not live until a release with a GO.
- [ ] Confirm the starting point in `state/releases.json` equals production on setup day: the WEB and API commits in OPERATIONS.md "Current production state". Today: WEB `1ba77c39`, API `2597ad60`. If another release happens first, use its commits.

## 1. Create the public repository

No new credential is needed for this step. The GitHub login on Anders's PC (`Triconzor`, an owner of DEAFCS) has the `repo` and `workflow` scopes, which cover creating the repository, its settings and rules, and pushing the workflow file.

The first commit holds no patch notes: `entries/` is empty, `feed/index.json` has no months (`latest` and `monitoredOn` are null), `state/days.json` is `{}`, and `releases/` has no records. The October 29–30 draft lives outside this folder and is not published.

From this folder, in order (repository settings first, then the push):

```bash
# 1. The tests pass on exactly what will be pushed.
node --test scripts/*.test.mjs

# 2. A local Git history with one commit.
git init -b main
git add -A
git -c user.name=Triconzor -c user.email=306877576+Triconzor@users.noreply.github.com \
  commit -m "Set up the DEAFCS changelog (no entries yet)"

# 3. The empty public repository, linked as origin. Not pushed yet.
gh repo create DEAFCS/changelog --public \
  --description "DEAFCS patch notes and the feed behind deafcs.net/changelog" \
  --disable-wiki --disable-issues --source . --remote origin

# 4. GITHUB_TOKEN reads by default (the workflow asks for write itself)
#    and can never approve pull requests.
gh api -X PUT repos/DEAFCS/changelog/actions/permissions/workflow \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false

# 5. main can't be force-pushed or deleted, by anyone.
gh api -X POST repos/DEAFCS/changelog/rulesets --input - <<'JSON'
{
  "name": "Protect main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [{ "type": "deletion" }, { "type": "non_fast_forward" }],
  "bypass_actors": []
}
JSON

# 6. The first push.
git push -u origin main
```

After the push, GitHub starts the Changelog workflow once (the push touches `releases/pending/` and `entries/`). Its job is skipped, because `CHANGELOG_ENABLED` isn't set. Nothing runs or commits until step 4.

Check afterwards:
- [ ] `https://github.com/DEAFCS/changelog` is public and shows the README with no entries.
- [ ] **Actions:** one Changelog run, with its job **skipped**.
- [ ] **Settings → Rules:** "Protect main" active. **Settings → Actions → General:** workflow permissions "Read repository contents".
- [ ] Pushes stay open on purpose: Anders, Theft (organisation owners) and the workflow commit to `main`. The organisation's base permission is read, so nobody else can.

## 2. Repository variables (Settings → Secrets and variables → Actions → Variables)

| Variable | Value |
| --- | --- |
| `WEB_VERSION_URL` | `https://deafcs.net/api/version` |
| `API_VERSION_URL` | `https://api.deafcs.net/system/version` (`/system` is publicly reachable: `/system/healthz` answers 200) |
| `CHANGELOG_ENABLED` | leave unset until step 6 |

## 3. The read-only credential

**Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token** (by Anders):

- Name `DEAFCS changelog read`, Resource owner **DEAFCS**, expiration up to one year (set a reminder to renew).
- Repository access: **Only select repositories** → `deafcs-web`, `api-deafcs`.
- Repository permissions: **Contents: Read-only**. Metadata: Read-only is added automatically. Nothing else.
- If the organisation requires approval for fine-grained tokens, approve it under DEAFCS → Settings → Personal access tokens → Pending requests.
- Save it in `DEAFCS/changelog` as the Actions secret **`GH_READ_TOKEN`**. Never in a file, chat or log.

Optional: `REVIEW_TOKEN` (fine-grained, only `DEAFCS/Private-Issues`, Issues: Read and write) for the private review issue, and `CHANGELOG_BLOCKLIST`.

## 4. Test safely before automatic publication

1. [ ] **Actions → Changelog → Run workflow** (dry run is ticked by default). It runs the tests, checks production and shows what it *would* change, then commits nothing. Before the release with the version endpoints, it reports "no answer from the version endpoint" for both sides, which is expected.
2. [ ] After the WEB and API release with the version endpoints: open `https://deafcs.net/api/version` and `https://api.deafcs.net/system/version`. Both must show the released commits.
3. [ ] Run the dry run again twice, at least 10 minutes apart (the first starts the clock, but a dry run doesn't save it; see the note below). Read the shown entry and check the held count.
4. [ ] When it looks right: set **`CHANGELOG_ENABLED` = `true`**. From then on it runs every 10 minutes (minutes 3, 13, ... 53) and on every correction.
5. [ ] Watch the first real run and the first entry on deafcs.net/changelog.

Note: a dry run never commits, so it doesn't remember when it first saw a commit. To preview a release before enabling, record it by hand in a local clone and run `npm run publish-releases` there; nothing is pushed.

To stop everything at any time: set `CHANGELOG_ENABLED` to anything else, or disable the workflow on the Actions tab. Production is never affected.

## 4b. The first entry (hand-written, then automatic)

The release that ships the version endpoints also ships Team History, the Changelog page and the per-region matchmaking switches. Its notes are written by hand, so the automatic run must not describe the same release again:

1. [ ] After that release is verified, put the reviewed entry (draft: `changelog-first-entry-draft.md`) at `entries/<year>/<release date>.md`, with the title's date set to the release date.
2. [ ] In the same commit, set `state/releases.json` `lastDeployed` to that release's WEB and API commits. Automatic notes then start with the next release.
3. [ ] Then enable `CHANGELOG_ENABLED`.

## 4c. Staying on, and failing visibly

- **60-day rule:** GitHub pauses scheduled workflows in a public repository after 60 days without activity. The production check updates `state/production.json` once a day (`checkedOn`), so the workflow commits at least daily and the schedule is never paused while it runs. If it is ever paused anyway, re-enable it on the Actions tab.
- **Version endpoint unavailable:** a blip is retried quietly. When WEB or API has given no usable answer for 30 minutes or more (down, an HTML page instead of JSON, a wrong address), the run fails, and every run fails until it's fixed. GitHub emails the person who last changed the workflow's schedule.
- **Image without a commit:** the run fails at once, as above.
- **Monitoring stopped altogether** (workflow disabled or paused, or the token expired): GitHub sends no email when a scheduled workflow stops running. The feed's `index.json` carries `monitoredOn`, the last day of a *successful* check (both version endpoints answered with a commit, and the run's commit reached `main`). A run that only started, a dry run or a failed push never moves it. When it is more than two days old, administrators see a notice on deafcs.net/changelog. Players never see it. (WEB code ready locally, not committed yet.)
- **Token expiry:** the fine-grained token expires on the date chosen. Expiry makes every run with a pending release fail, so it is visible, but renewing before the date avoids it.

## 5. Corrections (GitHub's editor)

- An administrator clicks **Edit** next to a day on deafcs.net/changelog, or opens `entries/<year>/<date>.md` on GitHub and clicks the pencil.
- Reword, remove or add bullets, then **Commit changes** directly to `main`.
- The workflow keeps the edit: reworded and removed items are remembered and never come back, and added items count as new (unread).
- Don't edit `feed/`, `state/` or `README.md`.

## 6. Building images with the right commit

See RELEASE-STEP.md. In short: build from `git archive` of the commit with `--build-arg DEAFCS_COMMIT=<full commit>` (proposed shared helper `build-release-image.sh`). A build without a correct commit reports `null` and is never published.

## 7. OPERATIONS.md changes (to add after approval)

- **WEB and API release procedures, build step:** build from `git archive` of the commit with `--build-arg DEAFCS_COMMIT=<full commit>` (or the helper).
- **Verification step:** `curl -s https://deafcs.net/api/version` and `curl -s https://api.deafcs.net/system/version` equal the released commits.
- **Last step after verification (Claude releases):** `node scripts/record-release.mjs --verified --web-to ... --api-to ...` from the `DEAFCS/changelog` clone.
- **A short "Changelog" section:** what the repository does, the variables, the on/off switch, how to correct an entry, how to handle a flagged release, and that a failed changelog run never needs a production action.
- **Note for Theft's builds:** the same build setting.
