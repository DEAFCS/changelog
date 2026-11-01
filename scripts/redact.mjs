// Ported from 5stackgg/changelog scripts/redact.mjs (18fbb58) with 5Stack's
// permission. DEAFCS: deafcs.net is the allowed domain, commit hashes are
// stripped, and the gate also drops lines naming DEAFCS infrastructure or
// using an em dash.
import { conform } from "./feed.mjs";

const ALLOWED_DOMAINS = ["deafcs.net"];

const COMMIT = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/i;

const RULES = {
  url: /\bhttps?:\/\/\S+|\bwww\.\S+/i,
  email: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/,
  ip: /\b\d{1,3}(\.\d{1,3}){3}\b|\b[0-9a-f]{1,4}(:[0-9a-f]{0,4}){4,7}\b/i,
  reference: /#\d+\b/,
  handle: /(^|[\s(])@[\w-]+/,
  identifier: /\b[a-z0-9]+_[a-z0-9_]+\b/i,
  secret: /\b(sk-|ghp_|gho_|github_pat_|xox[abp]-|AKIA)\w+|\b[A-Za-z0-9_-]{32,}\b/,
  commit: COMMIT,
  infrastructure:
    /\b(hasura|postgres(ql)?|timescale(db)?|redis|kubernetes|k3s|kubectl|pods?|ghcr|docker|vps|ssh|minio|typesense|graphql|migrations?|rollouts?|rollbacks?|digests?|deploy(ed|ment)?s?|secrets?|tokens?|api keys?)\b/i,
  dash: /—/,
};

const DOMAIN = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi;

export function blocklist(raw = "") {
  return raw
    .split(/[\n,]/)
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
}

export function sanitize(text, blocked = []) {
  let clean = (text ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^\s*\|.*$/gm, "")
    .replace(/`[^`\n]+`/g, "[code]")
    .replace(/\b[A-Za-z0-9]+_[A-Za-z0-9_*]+/g, "[code]")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\bhttps?:\/\/\S+/gi, "[link]")
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "[email]")
    .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, "[ip]")
    .replace(new RegExp(COMMIT.source, "gi"), "[commit]")
    .replace(/\b[\w.-]+\/[\w.-]+#\d+\b|\b[\w-]+#\d+\b|#\d+\b/g, "")
    .replace(DOMAIN, (domain) =>
      ALLOWED_DOMAINS.includes(domain.toLowerCase()) ? domain : "[domain]",
    );

  for (const term of blocked) {
    clean = clean.replace(new RegExp(escape(term), "gi"), "[redacted]");
  }

  return clean.replace(/\n{3,}/g, "\n\n").trim();
}

export function violations(line, blocked = []) {
  const found = Object.entries(RULES)
    .filter(([, rule]) => rule.test(line))
    .map(([name]) => name);

  const domains = (line.match(DOMAIN) ?? []).filter(
    (domain) => !ALLOWED_DOMAINS.includes(domain.toLowerCase()),
  );
  if (domains.length > 0) {
    found.push("domain");
  }

  const lower = line.toLowerCase();
  if (blocked.some((term) => lower.includes(term))) {
    found.push("blocklist");
  }

  return found;
}

export function gate(markdown, blocked = []) {
  const dropped = {};
  const kept = [];
  // DEAFCS: each deleted line with its reasons, shown only in the private
  // draft pull request.
  const removed = [];

  for (const line of markdown.split("\n")) {
    const found = violations(line, blocked);
    if (found.length === 0) {
      kept.push(line);
      continue;
    }
    for (const name of found) {
      dropped[name] = (dropped[name] ?? 0) + 1;
    }
    removed.push({ line, rules: found });
  }

  return {
    markdown: dropEmptySections(kept).join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    dropped,
    removed,
  };
}

// The format check rewrites lines, so the gate runs after it, on the exact
// text that gets published.
export function finalize(markdown, blocked = []) {
  const conformed = conform(markdown);
  const gated = gate(conformed.markdown, blocked);
  return {
    markdown: gated.markdown,
    malformed: conformed.dropped,
    dropped: gated.dropped,
    removed: [
      ...conformed.removed.map((line) => ({ line, rules: ["format"] })),
      ...gated.removed,
    ],
  };
}

function dropEmptySections(lines) {
  return lines.filter((line, index) => {
    if (!line.startsWith("## ")) {
      return true;
    }
    const next = lines.slice(index + 1).find((after) => after.trim() !== "");
    return next !== undefined && !next.startsWith("## ");
  });
}

function escape(term) {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
