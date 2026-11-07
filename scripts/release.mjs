// A release record says that a production deployment was verified: which WEB
// and/or API commit went live, and when. It is the only thing that starts
// publication. It is written by the production check (production.mjs) once
// the site has served a new commit for 10 minutes, or by hand with
// record-release.mjs.
import { createHash } from "node:crypto";

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

// Immutable: the commits that went live. The same release recorded twice
// (by the check and by hand) gets the same ID and is processed once.
// Game servers, the streamer and the demo parser (the components) join the
// ID only when the release has them, so every WEB/API release keeps the ID it
// always had.
export const COMPONENT_SIDES = ["gameserver", "streamer", "demoparser"];
export const SIDES = ["web", "api", ...COMPONENT_SIDES];

export function releaseId(record) {
  const extra = COMPONENT_SIDES.filter((side) => record[side])
    .map((side) => `;${side}=${record[side].to}`)
    .join("");
  return createHash("sha256")
    .update(`web=${record.web?.to ?? "-"};api=${record.api?.to ?? "-"}${extra}`)
    .digest("hex")
    .slice(0, 16);
}

export function makeRecord({ verifiedAt, ...sides }) {
  const record = { version: 2, verified: true, verifiedAt };
  for (const side of SIDES) {
    if (sides[side]) {
      record[side] = sides[side];
    }
  }
  record.id = releaseId(record);
  return record;
}

// Anything missing or odd means the release is flagged for review instead
// of guessed at.
export function validateRecord(record) {
  if (!record || typeof record !== "object") {
    return "not a release record";
  }
  if (record.verified !== true) {
    return "not marked as verified";
  }
  if (
    typeof record.verifiedAt !== "string" ||
    Number.isNaN(Date.parse(record.verifiedAt)) ||
    !/Z$|[+-]\d\d:\d\d$/.test(record.verifiedAt)
  ) {
    return "verifiedAt is not a timestamp with a time zone";
  }
  const sides = SIDES.filter((side) => record[side]);
  if (sides.length === 0) {
    return "no WEB, API or component release in it";
  }
  for (const side of sides) {
    const { to, image, from } = record[side];
    if (!SHA.test(to ?? "")) {
      return `${side}: the production commit is not a full commit hash`;
    }
    if (image !== undefined && !DIGEST.test(image)) {
      return `${side}: the image digest is not a sha256 digest`;
    }
    if (from !== undefined && !SHA.test(from)) {
      return `${side}: the previous commit is not a full commit hash`;
    }
  }
  if (record.id !== releaseId(record)) {
    return "its ID doesn't match its commits";
  }
  return null;
}
