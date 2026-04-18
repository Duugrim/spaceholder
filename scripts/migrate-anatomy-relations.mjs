/**
 * One-shot: migrate anatomy JSON from legacy links to relations + exposure.
 * Usage: node scripts/migrate-anatomy-relations.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const HUMANOID_EXPOSURE = {
  head: { front: 60, back: 25, top: 15 },
  neck: { front: 40, back: 40 },
  chest: { front: 100 },
  back: { back: 100 },
  abdomen: { front: 90 },
  groin: { front: 70 },
  leftShoulder: { front: 50, left: 50 },
  rightShoulder: { front: 50, right: 50 },
  leftArm: { left: 70, front: 30 },
  rightArm: { right: 70, front: 30 },
  leftHand: { left: 80, front: 20 },
  rightHand: { right: 80, front: 20 },
  leftThigh: { left: 60, front: 40 },
  rightThigh: { right: 60, front: 40 },
  leftShin: { left: 70, front: 30 },
  rightShin: { right: 70, front: 30 },
  leftFoot: { left: 50, bottom: 50 },
  rightFoot: { right: 50, bottom: 50 }
};

const HUMANOID_PARENT = {
  head: "neck",
  neck: "chest",
  abdomen: "chest",
  groin: "abdomen",
  leftShoulder: "chest",
  rightShoulder: "chest",
  leftArm: "leftShoulder",
  rightArm: "rightShoulder",
  leftHand: "leftArm",
  rightHand: "rightArm",
  leftThigh: "groin",
  rightThigh: "groin",
  leftShin: "leftThigh",
  rightShin: "rightThigh",
  leftFoot: "leftShin",
  rightFoot: "rightShin"
};

function dedupeRels(rels) {
  const seen = new Set();
  const out = [];
  for (const r of rels) {
    const k =
      r.kind === "behind" ? `${r.kind}|${r.target}|${r.chance === undefined ? "" : r.chance}` : `${r.kind}|${r.target}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

function migrateHumanoid(p) {
  const bp = p.bodyParts;
  for (const [k, v] of Object.entries(bp)) {
    delete v.linkedPartIds;
    delete v.healthPercentage;
    const oldLinks = Array.isArray(v.links) ? [...v.links] : [];
    let adj = [...oldLinks];
    if (k === "chest") adj = adj.filter((x) => x !== "back");
    if (k === "back") adj = adj.filter((x) => x !== "chest");
    const relations = adj.map((target) => ({ kind: "adjacent", target }));
    if (k === "chest") relations.push({ kind: "behind", target: "back", chance: 80, direction: "front" });
    const par = HUMANOID_PARENT[k];
    if (par) relations.push({ kind: "parent", target: par });
    v.relations = dedupeRels(relations);
    v.exposure = { ...(HUMANOID_EXPOSURE[k] || {}) };
    delete v.links;
  }
  p.links = buildRootLinksFromAdjacent(bp);
}

function buildRootLinksFromAdjacent(bp) {
  const seen = new Set();
  const edges = [];
  for (const [fromKey, v] of Object.entries(bp)) {
    for (const r of v.relations || []) {
      if (r.kind !== "adjacent") continue;
      const to = r.target;
      const a = fromKey < to ? fromKey : to;
      const b = fromKey < to ? to : fromKey;
      const key = `${a}--${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: a, to: b });
    }
  }
  return edges.length ? edges : null;
}

/** Quadruped / arachnid: links -> adjacent only + parent by simple chain rules */
function migrateGeneric(p, options) {
  const { exposure = {}, parentByPart = {} } = options || {};
  const bp = p.bodyParts;
  for (const [k, v] of Object.entries(bp)) {
    delete v.linkedPartIds;
    delete v.healthPercentage;
    const oldLinks = Array.isArray(v.links) ? [...v.links] : [];
    const relations = oldLinks.map((target) => ({ kind: "adjacent", target }));
    const par = parentByPart[k];
    if (par) relations.push({ kind: "parent", target: par });
    v.relations = dedupeRels(relations);
    v.exposure = { ...(exposure[k] || {}) };
    delete v.links;
  }
  p.links = buildRootLinksFromAdjacent(bp);
}

function quadrupedParents(bp) {
  const m = {};
  if (bp.neck && bp.torso) m.neck = "torso";
  if (bp.head && bp.neck) m.head = "neck";
  for (const side of ["Left", "Right"]) {
    if (bp[`front${side}Shoulder`] && bp.torso) m[`front${side}Shoulder`] = "torso";
    if (bp[`back${side}Hip`] && bp.torso) m[`back${side}Hip`] = "torso";
    if (bp[`front${side}Leg`] && bp[`front${side}Shoulder`]) m[`front${side}Leg`] = `front${side}Shoulder`;
    if (bp[`back${side}Leg`] && bp[`back${side}Hip`]) m[`back${side}Leg`] = `back${side}Hip`;
    if (bp[`front${side}Paw`] && bp[`front${side}Leg`]) m[`front${side}Paw`] = `front${side}Leg`;
    if (bp[`back${side}Paw`] && bp[`back${side}Leg`]) m[`back${side}Paw`] = `back${side}Leg`;
  }
  if (bp.tail && bp.torso) m.tail = "torso";
  return m;
}

function run() {
  const pairs = [
    ["data/anatomy/humanoid.json", "humanoid"],
    ["data/anatomy/quadruped.json", "quadruped"],
    ["data/anatomy/arachnid.json", "arachnid"],
    ["module/data/anatomy/humanoid.json", "humanoid"],
    ["module/data/anatomy/quadruped.json", "quadruped"],
    ["module/data/anatomy/arachnid.json", "arachnid"]
  ];
  for (const [rel, kind] of pairs) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) continue;
    const p = JSON.parse(fs.readFileSync(file, "utf8"));
    if (kind === "humanoid") migrateHumanoid(p);
    else if (kind === "quadruped") {
      const parentByPart = quadrupedParents(p.bodyParts || {});
      migrateGeneric(p, {
        parentByPart,
        exposure: {
          torso: { front: 40, right: 100, back: 90, left: 100 },
          head: { front: 100, right: 100, back: 100, left: 100 }
        }
      });
    } else if (kind === "arachnid") {
      const bp = p.bodyParts || {};
      const parentByPart = {};
      for (const k of Object.keys(bp)) {
        if (k === "cephalothorax") continue;
        if (k === "abdomenSegment") parentByPart[k] = "cephalothorax";
        else if (/^leftLeg|^rightLeg/.test(k)) parentByPart[k] = "cephalothorax";
      }
      migrateGeneric(p, {
        parentByPart,
        exposure: {
          cephalothorax: { front: 100, right: 90, back: 80, left: 90 },
          abdomenSegment: { front: 50, right: 90, back: 100, left: 90 }
        }
      });
    }
    fs.writeFileSync(file, JSON.stringify(p, null, 2) + "\n", "utf8");
    console.log("Wrote", rel);
  }
}

run();
