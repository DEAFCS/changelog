# Release procedure: the changelog

Proposed addition to the WEB and API release procedures in OPERATIONS.md (not added yet).

## Every production image reports its commit

WEB answers `GET /api/version` and API answers `GET /system/version` with `{ "commit": "<full commit>" }`. The value is fixed into the image at build time through `--build-arg DEAFCS_COMMIT=<full commit>`. Missing, short, or anything that isn't a full commit means `{ "commit": null }`: nothing is recorded, and the Changelog workflow fails loudly (GitHub emails it) until a correctly built release is live. Production is never affected.

The commit must describe exactly what is in the image. That is only guaranteed when the image is built from the commit itself, not from a working folder.

### Recommended: one shared build helper (proposal, not added yet)

DEAFCS release builds already do this: build from an exact `git archive` of the commit, so local changes, untracked files and git-ignored files (for example `.idea` or `.fleet`, which WEB's `.dockerignore` doesn't exclude) can never enter the image. A small helper would make it the same one command for Anders's and Theft's builds:

```bash
#!/usr/bin/env bash
# build-release-image.sh <web|api> [commit]: builds ghcr.io/deafcs/<web|api>:<commit>
# from exactly that commit, labelled and with DEAFCS_COMMIT for the changelog.
set -euo pipefail
name="$1"
commit="$(git rev-parse "${2:-HEAD}^{commit}")"
context="$(mktemp -d)"
trap 'rm -rf "$context"' EXIT
git archive "$commit" | tar -x -C "$context"
docker build --platform linux/amd64 --provenance=false \
  --build-arg DEAFCS_COMMIT="$commit" \
  --label org.opencontainers.image.revision="$commit" \
  -t "ghcr.io/deafcs/$name:$commit" "$context"
```

The commit also has to be pushed to GitHub before the release, so the changelog can read it. An unpushed commit is flagged for review, not published.

### If someone builds from a working folder instead

Pass the commit only when nothing in the folder differs from it, untracked files included:

```bash
--build-arg DEAFCS_COMMIT=$( [ -z "$(git status --porcelain)" ] && git rev-parse HEAD )
```

With local changes or untracked files the value is empty, so the release fails safely as above. This still can't see git-ignored files in the folder, which is why the helper above is the safe default.

## After a release

- **Anders's releases:** after the release has fully passed its verification, Claude records it as the last step. That is the fully verified record, published within minutes:
  ```bash
  node scripts/record-release.mjs --verified --web-to <full WEB commit> --api-to <full API commit>
  ```
  This runs from a clone of `DEAFCS/changelog` with the GitHub login already on this PC. No new key is needed.
- **Theft's releases:** nothing to do. The Changelog workflow sees the new commit within 10 minutes. Once it has been live in every check for 10 minutes, the workflow records and publishes it.
- Both ways give the same release ID for the same commits, so a release is published once.

## Polling versus a verified release record

- **A verified record** (`record-release.mjs` after the release checks) means the release's own checks passed: routes, bundle markers, logs.
- **The production check** only proves that deafcs.net served this commit in every check for at least 10 minutes. Kubernetes only routes traffic to pods that pass their readiness checks, so the release was up, healthy and not rolled back. It doesn't know about route or log checks.
- **Two releases within 10 minutes:** the first doesn't count on its own, but the second release's range starts at the last published commit, so the first one's changes are included. A rollback correctly publishes nothing.
- **Histories that don't line up** (a rollback, a commit from another branch, a rewritten history, a commit GitHub doesn't know) are never skipped silently or reported as something else. The release is moved to `releases/flagged/` with the reason, listed in the review issue, and the production commit stays at the last published one. The next normal release is then compared with that commit and flagged again if it still doesn't line up.
