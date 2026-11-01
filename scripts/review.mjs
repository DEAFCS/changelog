// Turns the Publish run's review file into the body of an issue in a private
// repository (DEAFCS/Private-Issues by default): what was held back and why,
// per release, so Anders or Theft can add a note by hand if it should be
// public. Nothing here is ever printed to the public log.
import fs from "node:fs";

export function reviewBody({ held = [], flagged = [] }, runUrl = "") {
  const lines = ["Changelog notes held back or releases flagged by the Publish workflow. Nothing below was published.", ""];
  for (const { release, date, items } of held) {
    lines.push(`### Release ${release} (${date})`, "");
    for (const { reason, note } of items) {
      lines.push(`- **${reason}**: ${note.replaceAll("\n", " ")}`);
    }
    lines.push("");
  }
  if (flagged.length > 0) {
    lines.push("### Flagged releases", "");
    for (const { file, reason } of flagged) {
      lines.push(`- \`${file}\`: ${reason}`);
    }
    lines.push("");
  }
  lines.push(
    "To publish something held here, add it to the day's entry in DEAFCS/changelog by hand. A flagged release is fixed or skipped as described in MAINTAINING.md.",
  );
  if (runUrl) {
    lines.push("", `Run: ${runUrl}`);
  }
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
  const [file, out] = process.argv.slice(2);
  const review = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(out, reviewBody(review, process.env.RUN_URL ?? ""));
}
