// Components: what production runs besides WEB and API. Each one is off until
// the repository variable CHANGELOG_COMPONENTS names it:
//
//   CHANGELOG_COMPONENTS = "gameserver,streamer,demoparser"   (any of them)
//
// The API's GET /system/version reports the images production uses:
//   gameServer.server / gameServer.practice  match and practice servers
//                                            (scripts/gameserver.mjs: release tags)
//   streamer                                 live streams and highlight renders
//   demoParser                               the running demo-parser pods
// as "ghcr.io/deafcs/<image>@sha256:<digest>". This file turns the streamer
// and demo-parser images into the commit they were built from: the image's
// org.opencontainers.image.revision label, read from ghcr.io by digest, and
// only when that commit exists on GitHub. A tag without a digest, another
// image, a missing label or a commit GitHub doesn't know is a problem for that
// component only: nothing is recorded for it, and WEB/API tracking and the
// monitoring date carry on as before. A pushed commit or a built image is
// never a release; only what production reports is, after the same 10 stable
// minutes.
//
// state/component-images.json remembers each digest's commit once it is
// known, so the registry is asked once per new image.
import fs from "node:fs";
import path from "node:path";
import { COMPONENT_SIDES } from "./release.mjs";
import { ORG, SIDES as REPOS } from "./sources.mjs";

export const COMPONENT_IMAGES = "state/component-images.json";

// Which field of the version answer reports each component.
export const REPORTED = { gameserver: "gameServer", streamer: "streamer", demoparser: "demoParser" };

// Image repositories each labelled component may report.
export const LABELLED = {
  streamer: ["ghcr.io/deafcs/game-streamer"],
  demoparser: ["ghcr.io/deafcs/demo-parser"],
};

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;

export function enabledComponents(env = process.env) {
  const named = String(env.CHANGELOG_COMPONENTS ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase());
  return COMPONENT_SIDES.filter((side) => named.includes(side));
}

// "ghcr.io/deafcs/game-streamer@sha256:..." (a tag before the @ is allowed).
// Only a digest pins an image; a tag alone can move, so it isn't accepted.
export function parsePinned(ref, repositories) {
  const text = String(ref ?? "").trim().toLowerCase();
  const at = text.indexOf("@");
  if (at < 0) {
    return null;
  }
  const digest = text.slice(at + 1);
  let name = text.slice(0, at);
  const colon = name.lastIndexOf(":");
  if (colon > name.lastIndexOf("/")) {
    name = name.slice(0, colon);
  }
  if (!DIGEST.test(digest) || !repositories.includes(name)) {
    return null;
  }
  return { repository: name, digest };
}

const ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(",");

// Reads an image's labels from ghcr.io by digest, with the workflow's own
// token (packages: read; each package must give DEAFCS/changelog read access).
// Never logs the token. Returns null when the registry doesn't have the image.
export function labelClient(token = process.env.REGISTRY_TOKEN, fetcher = fetch) {
  const bearer = new Map();
  const get = async (name, url, accept) => {
    if (!bearer.has(name)) {
      const response = await fetcher(`https://ghcr.io/token?scope=repository:${name}:pull&service=ghcr.io`, {
        headers: { authorization: `Basic ${Buffer.from(`x:${token ?? ""}`).toString("base64")}` },
      });
      if (!response.ok) {
        throw new Error(`registry token request failed with status ${response.status}`);
      }
      bearer.set(name, (await response.json()).token);
    }
    const response = await fetcher(url, {
      headers: { authorization: `Bearer ${bearer.get(name)}`, ...(accept ? { accept } : {}) },
    });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`registry request failed with status ${response.status}`);
    }
    return response.json();
  };
  return async function labelsOf(repository, digest) {
    const name = repository.replace(/^ghcr\.io\//, "");
    let manifest = await get(name, `https://ghcr.io/v2/${name}/manifests/${digest}`, ACCEPT);
    if (manifest?.manifests) {
      // A multi-platform index: production runs linux/amd64.
      const entry = manifest.manifests.find(
        (item) => item.platform?.os === "linux" && item.platform?.architecture === "amd64",
      );
      manifest = entry ? await get(name, `https://ghcr.io/v2/${name}/manifests/${entry.digest}`, ACCEPT) : null;
    }
    const config = manifest?.config?.digest;
    if (!config) {
      return null;
    }
    const blob = await get(name, `https://ghcr.io/v2/${name}/blobs/${config}`);
    return blob?.config?.Labels ?? {};
  };
}

export function readComponentImages(dir) {
  const file = path.join(dir, COMPONENT_IMAGES);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

function writeComponentImages(dir, images) {
  const sorted = Object.fromEntries(Object.entries(images).sort(([a], [b]) => a.localeCompare(b)));
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  fs.writeFileSync(path.join(dir, COMPONENT_IMAGES), `${JSON.stringify(sorted, null, 2)}\n`);
}

// What the production check sees for a labelled component, in the shape of
// the other sides: { answered, commit } plus a problem. Without the field (an
// API from before this) the component is not reported at all: neither a
// release nor a problem.
export async function resolveLabelled(dir, side, reported, { github, labels }) {
  if (reported === undefined || reported === null || reported === "") {
    return null;
  }
  const image = parsePinned(reported, LABELLED[side] ?? []);
  if (!image) {
    return { answered: true, commit: null, problem: `${side}: the image isn't a ${side} image pinned by digest` };
  }
  const key = `${image.repository}@${image.digest}`;
  const images = readComponentImages(dir);
  if (images[key]) {
    return { answered: true, commit: images[key].commit };
  }
  let commit;
  try {
    const found = await labels(image.repository, image.digest);
    if (!found) {
      return { answered: true, commit: null, problem: `${side}: the image isn't in the registry` };
    }
    commit = String(found["org.opencontainers.image.revision"] ?? "").trim().toLowerCase();
    if (!SHA.test(commit)) {
      return { answered: true, commit: null, problem: `${side}: the image has no full revision label` };
    }
    try {
      await github(`/repos/${ORG}/${REPOS[side].repo}/commits/${commit}`);
    } catch (error) {
      if (/status (404|422)/.test(error.message)) {
        return { answered: true, commit: null, problem: `${side}: the image's commit is not on GitHub` };
      }
      throw error;
    }
  } catch {
    // GitHub or the registry didn't answer: like an endpoint that is down,
    // retried quietly, and a problem only after 30 minutes.
    return { answered: false };
  }
  images[key] = { commit };
  writeComponentImages(dir, images);
  return { answered: true, commit };
}
