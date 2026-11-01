import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const scripts = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));

// Comments are dropped: only what runs counts.
const workflow = fs
  .readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8")
  .replace(/\r\n/g, "\n")
  .split("\n")
  .filter((line) => !line.trim().startsWith("#"))
  .join("\n");

test("publication starts only from the production check, a recorded release, a hand correction or by hand", () => {
  const on = workflow.match(/^on:\n((?: {2}.*\n)+)/m)[1];
  assert.equal(
    on,
    [
      "  push:",
      "    branches: [main]",
      '    paths: ["releases/pending/**", "entries/**"]',
      "  schedule:",
      '    - cron: "3-59/10 * * * *"',
      "  workflow_dispatch:",
      "    inputs:",
      "      dry_run:",
      "        description: Show what would be published without committing anything.",
      "        type: boolean",
      "        default: true",
      "",
    ].join("\n"),
  );
  assert.doesNotMatch(workflow, /pull_request|workflow_run|registry_package|release:/);
  assert.match(workflow, /if: github.ref == 'refs\/heads\/main'/);
});

test("the workflow can only write this repository, one run at a time, on top of the newest main", () => {
  assert.match(workflow, /^permissions:\n {2}contents: write\n\n/m);
  assert.match(workflow, /group: changelog\n\s+cancel-in-progress: false/);
  assert.match(workflow, /git reset --hard origin\/main/);
  assert.match(workflow, /git push origin HEAD:main/);
  assert.doesNotMatch(workflow, /--force|push -f/);
  for (const line of workflow.split("\n").filter((entry) => entry.includes("${{"))) {
    assert.match(
      line.trim(),
      /^([A-Z_]+: \$\{\{ (secrets|vars)\.[A-Z_]+ \}\}|DRY_RUN: \$\{\{ inputs\.dry_run == true \|\| vars\.CHANGELOG_ENABLED != 'true' \}\})$/,
      line.trim(),
    );
  }
});

test("two releases recorded at the same moment both reach main", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "record-"));
  const git = (cwd, ...args) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  const remote = path.join(root, "remote.git");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  const seed = path.join(root, "seed");
  git(root, "clone", "-q", remote, seed);
  fs.writeFileSync(path.join(seed, "README.md"), "x\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "push", "-q", "origin", "HEAD:main");

  const clones = ["anders", "theft"].map((name) => {
    const dir = path.join(root, name);
    git(root, "clone", "-q", remote, dir);
    git(dir, "config", "user.name", name);
    git(dir, "config", "user.email", `${name}@example.invalid`);
    return dir;
  });

  // Both clones are on the same main; the second push is rejected and retried.
  const run = (dir, commit) =>
    execFileSync(
      process.execPath,
      [
        path.join(scripts, "record-release.mjs"),
        "--verified",
        "--web-to",
        commit.repeat(40),
        "--verified-at",
        "2026-10-31T10:00:00Z",
      ],
      { cwd: dir, encoding: "utf8" },
    );
  assert.match(run(clones[0], "c"), /Recorded release/);
  assert.match(run(clones[1], "d"), /Recorded release/);

  const check = path.join(root, "check");
  git(root, "clone", "-q", remote, check);
  assert.equal(fs.readdirSync(path.join(check, "releases/pending")).length, 2);
});

test("review issues are made in the same run and commit as the publication", () => {
  // review.mjs runs after publish.mjs on the same checkout, before the commit,
  // so the queue and the issues it records land with the release.
  const publish = workflow.indexOf("node scripts/publish.mjs || status=$?");
  const review = workflow.indexOf("node scripts/review.mjs || status=$?");
  assert.ok(publish > 0 && review > publish && review < workflow.indexOf("git add -A"));
  assert.match(workflow, /\n\s+REVIEW_TOKEN: \$\{\{ secrets\.REVIEW_TOKEN \}\}\n/);
  // No separate step that could skip, or throw away a temporary review file.
  assert.doesNotMatch(workflow, /REVIEW_FILE|gh issue create|Open a private review issue/);
});

test("a failing review never stops the publication from being committed", () => {
  // The step runs with bash -e: every script records its status instead of
  // stopping the step, and the commit and push come after all of them.
  for (const script of ["production", "publish", "review"]) {
    assert.match(workflow, new RegExp(`\\n\\s+node scripts/${script}\\.mjs \\|\\| status=\\$\\?\\n`));
  }
  const review = workflow.indexOf("node scripts/review.mjs");
  assert.ok(review < workflow.indexOf('git commit -m "Publish verified releases"'));
  assert.ok(review < workflow.indexOf("git push origin HEAD:main"));
});

test("a dispatched run can't publish while CHANGELOG_ENABLED isn't true", () => {
  // The VPS dispatcher sends dry_run=false; DRY_RUN is still true unless the
  // variable is "true", and a dry run exits before committing.
  const formula = workflow.match(/DRY_RUN: \$\{\{ (.+) \}\}/)[1];
  const dryRun = (input, enabled) => input === true || enabled !== "true";
  assert.equal(formula, "inputs.dry_run == true || vars.CHANGELOG_ENABLED != 'true'");
  assert.equal(dryRun(false, undefined), true);
  assert.equal(dryRun(false, "false"), true);
  assert.equal(dryRun(false, "true"), false);
  assert.equal(dryRun(true, "true"), true);
});

test("no AI service, API key or package install is used", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.dependencies, undefined);
  assert.doesNotMatch(workflow, /ANTHROPIC|OPENAI|npm ci|npm install/i);
  const sources = fs
    .readdirSync(scripts)
    .filter((file) => file.endsWith(".mjs") && !file.endsWith(".test.mjs"))
    .map((file) => fs.readFileSync(path.join(scripts, file), "utf8"))
    .join("\n");
  assert.doesNotMatch(sources, /anthropic|openai|api\.anthropic|claude-/i);
});

test("automatic runs stay off until enabled, and a run by hand is a dry run by default", () => {
  assert.match(
    workflow,
    /if: github.ref == 'refs\/heads\/main' && \(vars\.CHANGELOG_ENABLED == 'true' \|\| github\.event_name == 'workflow_dispatch'\)/,
  );
  assert.match(workflow, /dry_run:\n\s+description: .+\n\s+type: boolean\n\s+default: true/);
  // The dry run leaves before anything is committed or pushed.
  const dry = workflow.indexOf('if [ "$DRY_RUN" = "true" ]; then');
  assert.ok(dry > 0 && dry < workflow.indexOf("git commit") && dry < workflow.indexOf("git push"));
  // While publishing is off, every run is a dry run, even with the box unticked.
  assert.match(
    workflow,
    /env:\n\s+DRY_RUN: \$\{\{ inputs\.dry_run == true \|\| vars\.CHANGELOG_ENABLED != 'true' \}\}/,
  );
});
