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
  assert.match(workflow, /Open a private review issue\n\s+if: always\(\) && env\.DRY_RUN != 'true'/);
  // While publishing is off, every run is a dry run, even with the box unticked.
  assert.match(
    workflow,
    /env:\n\s+DRY_RUN: \$\{\{ inputs\.dry_run == true \|\| vars\.CHANGELOG_ENABLED != 'true' \}\}/,
  );
});
