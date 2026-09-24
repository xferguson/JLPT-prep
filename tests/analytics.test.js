import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCourse, initialState, completeLearning, review, dayKey } from '../js/engine.js';
import { AGAIN, GOOD, DAY } from '../js/srs.js';
import {
  snapshot, knownOverTime, reviewHistory, successRates, forecast, hardest, upcoming, lastDays,
} from '../js/analytics.js';

const load = (f) => JSON.parse(readFileSync(new URL(`../data/n5/${f}`, import.meta.url)));
const course = buildCourse({
  characters: load('characters.json'), words: load('words.json'), sentences: load('sentences.json'), meta: load('meta.json'),
});

// Day 0 (noon): learn 3 kanji. Day 1: review them (one fails). Day 2+: keep going.
function scenario() {
  const t0 = new Date('2026-03-02T12:00:00').getTime();
  const state = initialState(course, t0);
  const ids = course.characters.slice(0, 3).map((c) => c.id);
  completeLearning(course, state, ids, t0);
  const t1 = t0 + DAY;
  review(course, state, ids[0], GOOD, t1);
  review(course, state, ids[1], GOOD, t1);
  review(course, state, ids[2], AGAIN, t1);
  // push ids[0] through to its kanji stage pass
  let t = t1;
  for (let i = 0; i < 5 && !state.cards[ids[0]].passedFinal; i++) {
    t = Math.max(t, state.cards[ids[0]].due);
    review(course, state, ids[0], GOOD, t);
  }
  return { state, ids, t0, t1, tEnd: t };
}

test('snapshot counts known / learning / unlocked / locked', () => {
  const { state } = scenario();
  const s = snapshot(course, state);
  assert.equal(s.char.known, 1);
  assert.equal(s.char.learning, 2);
  assert.equal(s.char.known + s.char.learning + s.char.queued + s.char.locked, course.characters.length);
  assert.equal(s.char.stages.kanji, 1);
});

test('review history and success rates', () => {
  const { state, t1, tEnd } = scenario();
  const hist = reviewHistory(state, t1, 2);
  assert.deepEqual(hist[1], { key: dayKey(t1), passed: 2, failed: 1, learned: 0 });
  assert.equal(hist[0].learned, 3);
  const rates = successRates(state, tEnd, 30);
  assert.equal(rates.reviews, state.cards[course.characters[0].id].reps + 2);
  assert.equal(rates.failed, 1);
  assert.deepEqual(rates.byStage['char:romaji'], { passed: 2, failed: 1, total: 3, rate: 2 / 3 });
  assert.equal(rates.byMaturity.learning.failed, 1);
  assert.equal(rates.ratings[0], 1);
});

test('known over time ends at the current count', () => {
  const { state, tEnd } = scenario();
  const k = knownOverTime(course, state, tEnd, 10);
  assert.equal(k.keys.length, 10);
  assert.equal(k.series.char.at(-1), 1);
  assert.equal(k.series.char[0], 0);
  assert.deepEqual(k.series.word, Array(10).fill(0));
});

test('forecast buckets due cards by day, overdue into today', () => {
  const { state, tEnd } = scenario();
  const fc = forecast(course, state, tEnd + 60 * DAY, 14);
  assert.equal(fc[0].total, 3); // everything is overdue by then
  const fc2 = forecast(course, state, tEnd, 14);
  const total = fc2.reduce((n, d) => n + d.total, 0);
  assert.ok(total >= 2 && total <= 3);
  assert.equal(upcoming(course, state, 2).length, 2);
});

test('hardest lists lapsed cards and lastDays is contiguous', () => {
  const { state, ids, tEnd } = scenario();
  // make ids[0] lapse from review
  review(course, state, ids[0], AGAIN, state.cards[ids[0]].due);
  assert.equal(hardest(course, state)[0].item.id, ids[0]);
  const days = lastDays(tEnd, 40);
  assert.equal(new Set(days).size, 40);
});
