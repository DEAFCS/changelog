// Game-server releases: which DEAFCS/game-server commit production's match and
// practice servers start from. Off unless the repository variable
// CHANGELOG_COMPONENTS names "gameserver".
//
// The API's GET /system/version reports the images new servers start from:
//   { "commit": "...", "gameServer": { "server": "<image>", "practice": "<image>" } }
// (SERVER_IMAGE and PRACTICE_SERVER_IMAGE, or what the API falls back to).
// An image is only a release when its digest is the image of a DEAFCS/game-server
// release (sw-v0.0.N is ghcr.io/deafcs/game-server-sw:v0.0.N, css-v0.0.N
// game-server-css): the release tag names the commit. A pushed commit or a built
// image is never a release; only what production reports is, and the production
// check still waits 10 minutes before it counts.
//
// state/game-server-images.json remembers every digest once it was matched to a
// release, so a digest is looked up in the registry once. Its first entries were
// checked by hand against the registry (2026-11-03).
//
// Match and practice servers can run different releases. The newer one is what
// counts: its range covers the older one, so when the other catches up there is
// nothing left to publish and nothing is published twice.
import fs from "node:fs";
import path from "node:path";
import { ORG } from "./sources.mjs";

export const IMAGES = "state/game-server-images.json";

// Image repository -> release tag prefix in DEAFCS/game-server.
export const RUNTIMES = {
  "ghcr.io/deafcs/game-server-sw": "sw",
  "ghcr.io/deafcs/game-server-css": "css",
};

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;

// On when CHANGELOG_COMPONENTS names "gameserver" (scripts/components.mjs).
export function gameServerEnabled(env = process.env) {
  return String(env.CHANGELOG_COMPONENTS ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .includes("gameserver");
}

// "ghcr.io/deafcs/game-server-sw@sha256:..." or "...:v0.0.73" or ":latest".
export function parseImage(ref) {
  const text = String(ref ?? "").trim().toLowerCase();
  const at = text.indexOf("@");
  const name = at >= 0 ? text.slice(0, at) : text;
  const digest = at >= 0 ? text.slice(at + 1) : null;
  const colon = name.lastIndexOf(":");
  const slash = name.lastIndexOf("/");
  const repository = colon > slash ? name.slice(0, colon) : name;
  const tag = colon > slash ? name.slice(colon + 1) : null;
  if (!RUNTIMES[repository] || (digest !== null && !DIGEST.test(digest)) || (!digest && !tag)) {
    return null;
  }
  return { repository, prefix: RUNTIMES[repository], digest, tag };
}

// Reads digests from ghcr.io with the workflow's own token (packages: read; the
// package must allow DEAFCS/changelog to read it). Never logs the token.
export function registryClient(token = process.env.REGISTRY_TOKEN, fetcher = fetch) {
  const ACCEPT = [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.docker.distribution.manifest.v2+json",
  ].join(",");
  const bearer = new Map();
  return async function digestOf(repository, reference) {
    const name = repository.replace(/^ghcr\.io\//, "");
    if (!bearer.has(name)) {
      const response = await fetcher(`https://ghcr.io/token?scope=repository:${name}:pull&service=ghcr.io`, {
        headers: { authorization: `Basic ${Buffer.from(`x:${token ?? ""}`).toString("base64")}` },
      });
      if (!response.ok) {
        throw new Error(`registry token request failed with status ${response.status}`);
      }
      bearer.set(name, (await response.json()).token);
    }
    const response = await fetcher(`https://ghcr.io/v2/${name}/manifests/${reference}`, {
      method: "HEAD",
      headers: { authorization: `Bearer ${bearer.get(name)}`, accept: ACCEPT },
    });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`registry request failed with status ${response.status}`);
    }
    return response.headers.get("docker-content-digest");
  };
}

export function readImages(dir) {
  const file = path.join(dir, IMAGES);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

function writeImages(dir, images) {
  const sorted = Object.fromEntries(Object.entries(images).sort(([a], [b]) => a.localeCompare(b)));
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  fs.writeFileSync(path.join(dir, IMAGES), `${JSON.stringify(sorted, null, 2)}\n`);
}

// The release a digest is the image of: the newest releases of that runtime
// first, so a new release is found in one or two lookups.
async function findRelease(image, digest, { github, registry }) {
  const releases = await github(`/repos/${ORG}/game-server/releases?per_page=30`);
  const ours = releases
    .filter((release) => !release.draft && release.tag_name.startsWith(`${image.prefix}-v`))
    .sort((a, b) => String(b.published_at ?? "").localeCompare(String(a.published_at ?? "")));
  for (const release of ours) {
    const version = release.tag_name.slice(image.prefix.length + 1);
    if ((await registry(image.repository, version)) !== digest) {
      continue;
    }
    const ref = await github(`/repos/${ORG}/game-server/git/ref/tags/${release.tag_name}`);
    let commit = ref.object.sha;
    if (ref.object.type === "tag") {
      commit = (await github(`/repos/${ORG}/game-server/git/tags/${commit}`)).object.sha;
    }
    return SHA.test(commit) ? { release: release.tag_name, commit, publishedAt: release.published_at ?? null } : null;
  }
  return null;
}

// What the production check sees for the game servers, in the shape of the
// other sides: { answered, commit } plus a problem when an image is not a
// release. Without a "gameServer" field (an API from before this) the side is
// not reported at all, which is neither a release nor a problem.
export async function resolveGameServer(dir, reported, { github, registry }) {
  if (!reported || typeof reported !== "object") {
    return null;
  }
  const images = readImages(dir);
  let changed = false;
  const found = [];
  for (const kind of ["server", "practice"]) {
    const ref = reported[kind];
    if (ref === null || ref === undefined || ref === "") {
      continue;
    }
    const image = parseImage(ref);
    if (!image) {
      return { answered: true, commit: null, problem: `gameserver: the ${kind} image isn't a game-server release image` };
    }
    let digest = image.digest;
    try {
      digest ??= await registry(image.repository, image.tag);
      if (!digest) {
        return { answered: true, commit: null, problem: `gameserver: the ${kind} image tag isn't in the registry` };
      }
      const key = `${image.repository}@${digest}`;
      if (!images[key]) {
        const release = await findRelease(image, digest, { github, registry });
        if (!release) {
          return { answered: true, commit: null, problem: `gameserver: the ${kind} image isn't a game-server release` };
        }
        images[key] = release;
        changed = true;
      }
      found.push(images[key]);
    } catch {
      // GitHub or the registry didn't answer: like an endpoint that is down,
      // retried quietly, and a problem only after 30 minutes.
      return { answered: false };
    }
  }
  if (changed) {
    writeImages(dir, images);
  }
  if (found.length === 0) {
    return null;
  }
  const newest = found.sort((a, b) => String(b.publishedAt ?? "").localeCompare(String(a.publishedAt ?? "")))[0];
  return { answered: true, commit: newest.commit };
}
