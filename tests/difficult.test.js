import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCourse, initialState, completeLearning, review, reconcile, dueCards, nextDueTime, stats,
  difficultCards, markDifficult, graduateDifficult, recordConfusion, confusedWith, partnersOf,
} from '../js/engine.js';
import { GOOD, AGAIN, DAY } from '../js/srs.js';
import { DrillSession, DRILL_TESTS } from '../js/drill.js';
import { forecast } from '../js/analytics.js';

function course() {
  const word = (id, rank, kana, sim = [], sentences = 0) => ({
    id, kind: 'word', written: kana, kana, meaning: id, req: [], rank, stages: ['romaji', 'kana'], sim,
    sentences: Array.from({ length: sentences }, (_, k) => ({ s: `s:${id}${k}`, a: [0, 1], r: kana })),
  });
  const words = [
    word('w:hana', 1, 'はな', ['w:hana2', 'w:hashi'], 1),
    word('w:hana2', 2, 'はな', ['w:hana']),
    word('w:hashi', 3, 'はし', ['w:hana']),
    word('w:other', 4, 'ねこ'),
  ];
  const sentences = [{ id: 's:w:hana0', ja: 'はなです。', en: '', t: [['はな'], ['です'], ['。']], g: [] }];
  const characters = [{ id: 'c:日', kind: 'char', type: 'kanji', char: '日', meanings: ['day'], romaji: 'nichi', kana: 'にち', rank: 1, stages: ['romaji', 'kana', 'kanji'], sim: [] }];
  return buildCourse({ characters, words, sentences, meta: { level: 'N5' } });
}

// Learned and in review state, due at `due`.
function setup(ids, now = 0) {
  const c = course();
  const s = initialState(c, now);
  completeLearning(c, s, ids, now);
  for (const id of ids) s.cards[id] = { ...s.cards[id], state: 'review', ivl: 5, due: now + DAY, stage: c.items.get(id).stages.length - 1, passedFinal: true };
  return { c, s };
}

test('two Agains in a row flag a word; a pass in between resets the streak', () => {
  const { c, s } = setup(['w:hana']);
  let t = DAY;
  review(c, s, 'w:hana', AGAIN, t);
  t = s.cards['w:hana'].due;
  review(c, s, 'w:hana', GOOD, t); // streak broken
  t = s.cards['w:hana'].due;
  assert.equal(review(c, s, 'w:hana', AGAIN, t).flagged, null);
  t = s.cards['w:hana'].due;
  const res = review(c, s, 'w:hana', AGAIN, t);
  assert.equal(res.flagged, 'w:hana');
  assert.ok(s.cards['w:hana'].difficult);
  assert.deepEqual(difficultCards(s).map((x) => x.id), ['w:hana']);
});

test('flagged cards leave normal reviews, due counts, forecasts and next-due', () => {
  const { c, s } = setup(['w:hana', 'w:other']);
  markDifficult(c, s, 'w:hana', true, 0);
  const later = 10 * DAY;
  assert.deepEqual(dueCards(s, later).map((x) => x.id), ['w:other']);
  assert.equal(stats(c, s, later).due, 1);
  assert.equal(stats(c, s, later).difficult, 1);
  assert.equal(nextDueTime(s), s.cards['w:other'].due);
  assert.equal(forecast(c, s, 0, 3).reduce((n, d) => n + d.total, 0), 1);
});

test('missing a sentence twice in a row flags its word', () => {
  const { c, s } = setup(['w:hana', 'z:hana:0']);
  let t = DAY;
  review(c, s, 'z:hana:0', AGAIN, t);
  t = s.cards['z:hana:0'].due;
  const res = review(c, s, 'z:hana:0', AGAIN, t);
  assert.equal(res.flagged, 'w:hana');
  assert.ok(!s.cards['z:hana:0'].difficult, 'sentences themselves are not flagged');
});

test('graduation: due in 1 day on probation; a probation miss re-flags at once', () => {
  const { c, s } = setup(['w:hana']);
  markDifficult(c, s, 'w:hana', true, 0);
  assert.ok(graduateDifficult(s, 'w:hana', 5 * DAY));
  const card = s.cards['w:hana'];
  assert.equal(card.difficult, null);
  assert.equal(card.due, 6 * DAY);
  assert.equal(card.ivl, 1);
  assert.ok(card.probation);
  const res = review(c, s, 'w:hana', AGAIN, 6 * DAY);
  assert.equal(res.flagged, 'w:hana');
  // a pass instead clears probation
  const b = setup(['w:hana']);
  markDifficult(b.c, b.s, 'w:hana', true, 0);
  graduateDifficult(b.s, 'w:hana', 0);
  review(b.c, b.s, 'w:hana', GOOD, DAY);
  assert.equal(b.s.cards['w:hana'].probation, false);
});

test('manual unmark returns the card to reviews', () => {
  const { c, s } = setup(['c:日']);
  assert.ok(markDifficult(c, s, 'c:日', true, 0));
  assert.ok(markDifficult(c, s, 'c:日', false, 0));
  assert.equal(s.cards['c:日'].difficult, null);
  assert.equal(markDifficult(c, s, 'w:hashi', true, 0), false, 'not learned yet');
});

test('mix-ups: recorded pairs first, then learned look-alikes', () => {
  const { c, s } = setup(['w:hana', 'w:hana2', 'w:hashi']);
  recordConfusion(c, s, 'w:hana', 'w:hashi');
  recordConfusion(c, s, 'w:hashi', 'w:hana');
  recordConfusion(c, s, 'z:hana:0', 'w:hana2'); // sentence maps to its word
  assert.equal(recordConfusion(c, s, 'w:hana', 'w:hana'), null);
  assert.deepEqual(confusedWith(s, 'w:hana'), [{ id: 'w:hashi', n: 2 }, { id: 'w:hana2', n: 1 }]);
  assert.deepEqual(partnersOf(c, s, 'w:hashi'), ['w:hana']);
  // predicted partners only when learned, unless asked otherwise
  const fresh = setup(['w:hana']);
  assert.deepEqual(partnersOf(fresh.c, fresh.s, 'w:hana'), []);
  assert.deepEqual(partnersOf(fresh.c, fresh.s, 'w:hana', { learnedOnly: false }), ['w:hana2', 'w:hashi']);
});

test('reconcile flags cards failing now after 2+ lapses, once', () => {
  const { c, s } = setup(['w:hana', 'w:other']);
  s.cards['w:hana'] = { ...s.cards['w:hana'], state: 'relearning', lapses: 3 };
  s.cards['w:other'] = { ...s.cards['w:other'], state: 'relearning', lapses: 1 };
  delete s.difficultSeeded;
  reconcile(c, s, 0);
  assert.ok(s.cards['w:hana'].difficult);
  assert.ok(!s.cards['w:other'].difficult);
  markDifficult(c, s, 'w:hana', false, 0);
  reconcile(c, s, 0);
  assert.ok(!s.cards['w:hana'].difficult, 'seeding runs only once');
});

test('drill: re-teach first, a missed test returns after 1, 3, then 6 other steps', () => {
  const c = course();
  const items = ['w:hana', 'w:hashi', 'w:other'].map((id) => c.items.get(id));
  const d = new DrillSession(items, { listen: true });
  const seq = [];
  let misses = 0;
  let missAt = [];
  const results = {};
  for (let i = 0; i < 100; i++) {
    const step = d.next();
    if (!step) break;
    seq.push(`${step.item.id}:${step.view}`);
    const miss = step.item.id === 'w:hana' && step.view === 'type-recall' && misses < 3;
    if (miss) { misses++; missAt.push(seq.length - 1); }
    const fin = d.result(!miss);
    if (fin) results[fin.item.id] = fin.clean;
  }
  assert.deepEqual(seq.slice(0, 3), ['w:hana:reteach', 'w:hashi:reteach', 'w:other:reteach']);
  const again = seq.map((v, i) => [v, i]).filter(([v]) => v === 'w:hana:type-recall').map(([, i]) => i);
  assert.equal(again.length, 4);
  // gaps between a miss and its retry: 1, 3, 6 other steps (or the end of the queue)
  assert.equal(again[1] - again[0] - 1, 1);
  assert.equal(again[2] - again[1] - 1, 3);
  assert.ok(again[3] - again[2] - 1 <= 6);
  assert.deepEqual(results, { 'w:hana': false, 'w:hashi': true, 'w:other': true });
  // every item got every test
  for (const id of ['w:hashi', 'w:other']) for (const v of DRILL_TESTS) assert.ok(seq.includes(`${id}:${v}`));
});

test('drill: listening is skipped without a Japanese voice', () => {
  const c = course();
  const d = new DrillSession([c.items.get('w:other')], { listen: false });
  const views = [];
  for (let step = d.next(); step; step = d.next()) { views.push(step.view); d.result(true); }
  assert.deepEqual(views, ['reteach', 'mc-recognize', 'mc-recall', 'type-recall']);
});

test('drill: tell-apart rounds run until every word is right and the streak is long enough', () => {
  const c = course();
  const hana = c.items.get('w:hana');
  const partners = new Map([['w:hana', [c.items.get('w:hashi')]]]);
  const d = new DrillSession([hana], { partners, groupOnly: true });
  const targets = [];
  let first = true;
  for (let step = d.next(); step; step = d.next()) {
    if (step.view !== 'tellapart') { d.result(true); continue; }
    targets.push(step.target.id);
    d.result(!first); // miss the first round
    first = false;
  }
  // miss, then group size (2) + 1 = 3 correct in a row, covering both words
  assert.equal(targets.length, 4);
  assert.ok(new Set(targets.slice(1)).size === 2);
  for (let i = 1; i < targets.length; i++) assert.notEqual(targets[i], targets[i - 1]);
  // never more than 12 rounds
  const d2 = new DrillSession([hana], { partners, groupOnly: true });
  let rounds = 0;
  for (let step = d2.next(); step; step = d2.next()) { if (step.view === 'tellapart') rounds++; d2.result(false); }
  assert.equal(rounds, 12);
});
