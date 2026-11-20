import assert from "node:assert/strict";
import { test } from "node:test";
import { dedupe, similar } from "./entry.mjs";

const russian = {
  type: "improved",
  area: "General",
  text: "Russian and Ukrainian now cover matchmaking, matches, tournaments, verification, Career, rules and settings, with fewer English words left.",
};
// The 2026-11-19 WEB 4e77490e1 note the filter dropped as a repeat of `russian`.
const spanish = {
  type: "improved",
  area: "General",
  text: "Portuguese (Brazil) and Spanish now cover matchmaking, matches, tournaments, verification, Career, rules and settings, with fewer English words left.",
};

test("translation notes for different languages are kept", () => {
  assert.equal(similar(russian, spanish), false);
  assert.deepEqual(
    dedupe([spanish], [russian]).map((item) => item.text),
    [spanish.text],
  );
});

test("a reworded repeat of the same note is still dropped", () => {
  const reworded = {
    type: "improved",
    area: "General",
    text: "Russian and Ukrainian now cover matchmaking, matches, tournaments, verification, Career, rules and settings.",
  };
  assert.equal(similar(russian, reworded), true);
  assert.deepEqual(dedupe([reworded], [russian]), []);
});

test("an exact repeat is dropped, against the day and within one batch", () => {
  assert.deepEqual(dedupe([{ ...russian }], [russian]), []);
  assert.deepEqual(
    dedupe([russian, { ...russian }], []).map((item) => item.text),
    [russian.text],
  );
});

test("a repeat that only adds a shared language is still dropped", () => {
  const plain = {
    type: "improved",
    area: "General",
    text: "Russian now covers matchmaking, matches, tournaments, verification, Career, rules and settings.",
  };
  const withEnglish = { ...plain, text: `${plain.text.slice(0, -1)}, with fewer English words left.` };
  assert.equal(similar(plain, withEnglish), true);
});
