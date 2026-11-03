// Optional: records a verified DEAFCS production release by hand, to publish
// it before the Changelog workflow's own production check (production.mjs)
// finds it. Writes the release record into releases/pending, commits it and
// pushes it to DEAFCS/changelog, which starts the workflow. Run it from a
// clone of DEAFCS/changelog, only after the release has passed verification.
//
//   node scripts/record-release.mjs --verified \
//     --web-to <full commit> --api-to <full commit> [--gameserver-to <full commit>] \
//     [--web-image sha256:<digest>] [--api-image sha256:<digest>] \
//     [--verified-at 2026-10-31T13:24:27Z] [--web-from <commit>] [--api-from <commit>] [--no-push]
//
// It never touches production. If it fails, the release is still live and
// healthy: fix the problem and run it again with the same values.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeRecord, validateRecord } from "./release.mjs";

export function parseArgs(argv) {
  const value = (name) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const side = (name) => {
    const to = value(`${name}-to`);
    const image = value(`${name}-image`);
    if (!to && !image) {
      return null;
    }
    const from = value(`${name}-from`);
    return { to, image, ...(from ? { from } : {}) };
  };
  return {
    verified: argv.includes("--verified"),
    push: !argv.includes("--no-push"),
    verifiedAt: value("verified-at") ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    web: side("web"),
    api: side("api"),
    ...(side("gameserver") ? { gameserver: side("gameserver") } : {}),
  };
}

export function writeRecord(dir, args) {
  if (!args.verified) {
    throw new Error("Pass --verified, and only once the release has passed its production verification.");
  }
  const record = makeRecord(args);
  const problem = validateRecord(record);
  if (problem) {
    throw new Error(`Not recorded: ${problem}.`);
  }
  const file = path.join(dir, "releases", "pending", `${record.id}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return { record, file };
}

function git(dir, ...args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

// Each record is its own file, so two releases recorded at once never
// conflict: a rejected push just rebases and tries again.
function pushRecord(dir, record, file) {
  git(dir, "add", path.relative(dir, file));
  git(dir, "commit", "-m", `Record release ${record.id}`);
  for (let attempt = 1; ; attempt++) {
    try {
      git(dir, "push", "origin", "HEAD:main");
      return;
    } catch (error) {
      if (attempt >= 5) {
        throw error;
      }
      git(dir, "pull", "--rebase", "origin", "main");
    }
  }
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const { record, file } = writeRecord(".", args);
  if (args.push) {
    pushRecord(".", record, file);
  }
  console.log(`Recorded release ${record.id} (${[record.web && "WEB", record.api && "API", record.gameserver && "game servers"].filter(Boolean).join(" + ")}).`);
}
