import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCourse, initialState, completeLearning, review, reconcile, nextNewItems,
} from '../js/engine.js';
import { GOOD, AGAIN, DAY } from '../js/srs.js';
import { LearningSession } from '../js/session.js';
import { PlaySession } from '../js/play.js';

// Words x and y, each with several sentences of increasing length.
function course() {
  const word = (id, rank, n) => ({
    id, kind: 'word', written: id, kana: 'x', meaning: id, req: [], rank, stages: ['romaji', 'kana'],
    sentences: Array.from({ length: n }, (_, k) => ({ s: `s:${id}${k}`, a: [0, 1], r: 'x' })),
  });
  const words = [word('w:y', 1, 2), word('w:x', 2, 3)];
  const sentences = words.flatMap((w) => w.sentences.map((ref, k) => ({
    id: ref.s, ja: `x${'。'.repeat(k + 1)}`, en: '', t: [['x'], ['。'.repeat(k + 1)]], g: [],
  })));
  const characters = [{ id: 'c:日', kind: 'char', type: 'kanji', char: '日', meanings: ['day'], romaji: 'x', kana: 'x', rank: 1, stages: ['romaji', 'kana', 'kanji'] }];
  return buildCourse({ characters, words, sentences, meta: { level: 'N5' } });
}

// Pass a card through all its forms with Good answers; returns the time used.
function pass(c, state, id, t) {
  for (let i = 0; i < 10 && !state.cards[id].passedFinal; i++) {
    t = Math.max(t, state.cards[id].due);
    review(c, state, id, GOOD, t);
  }
  return t;
}

test('sentences unlock one at a time per word, behind words, first come first served', () => {
  const c = course();
  const s = initialState(c, 0);
  assert.ok(!s.queue.some((id) => id.startsWith('z:')), 'no sentences until a word is learned');
  completeLearning(c, s, ['w:x', 'w:y'], 0);
  let t = pass(c, s, 'w:x', 0);
  assert.deepEqual(s.queue.filter((id) => id.startsWith('z:')), ['z:x:0']); // xA
  t = pass(c, s, 'w:y', t);
  assert.deepEqual(s.queue.filter((id) => id.startsWith('z:')), ['z:x:0', 'z:y:0']); // xA, yA
  completeLearning(c, s, ['z:x:0'], t);
  assert.deepEqual(s.queue.filter((id) => id.startsWith('z:')), ['z:y:0']); // xB waits for xA to pass
  t = pass(c, s, 'z:x:0', t);
  assert.deepEqual(s.queue.filter((id) => id.startsWith('z:')), ['z:y:0', 'z:x:1']); // yA, xB
  // sentences stay behind kanji / words
  assert.equal(s.queue[0], 'c:日');
});

test('reconcile trims an old queue to one sentence per word and moves sentences to the back', () => {
  const c = course();
  const s = initialState(c, 0);
  completeLearning(c, s, ['w:x'], 0);
  pass(c, s, 'w:x', 0);
  s.queue = ['z:x:0', 'z:x:1', 'z:x:2', ...s.queue.filter((id) => !id.startsWith('z:'))]; // old behaviour
  reconcile(c, s, 0);
  assert.deepEqual(s.queue.filter((id) => id.startsWith('z:')), ['z:x:0']);
  assert.equal(s.queue.at(-1), 'z:x:0');
  assert.equal(s.unlocked['z:x:1'], undefined);
});

test('typing a word in a sentence counts as a review of the word', () => {
  const c = course();
  const s = initialState(c, 0);
  completeLearning(c, s, ['w:x'], 0);
  let t = pass(c, s, 'w:x', 0);
  // get the word into a long-ish review interval
  for (let i = 0; i < 3; i++) { t = s.cards['w:x'].due; review(c, s, 'w:x', GOOD, t); }
  const word = s.cards['w:x'];
  assert.equal(word.state, 'review');
  completeLearning(c, s, ['z:x:0'], t);
  const ivl = word.ivl;
  // sentence review two-thirds of the way to the word's due date, typed correctly
  const when = word.lastReview + Math.round(ivl * 2 / 3) * DAY;
  s.cards['z:x:0'].due = when;
  const res = review(c, s, 'z:x:0', GOOD, when, { typed: true });
  assert.ok(res.credited, 'word credited');
  assert.ok(s.cards['w:x'].due > word.due, 'word review pushed out');
  assert.equal(s.cards['w:x'].lastReview, when);
  // multiple choice, failed, or a word reviewed moments ago: no credit
  const before = s.cards['w:x'].due;
  const z1 = s.cards['z:x:0'];
  assert.equal(review(c, s, 'z:x:0', GOOD, z1.due).credited, null);
  assert.equal(review(c, s, 'z:x:0', AGAIN, s.cards['z:x:0'].due, { typed: true }).credited, null);
  assert.equal(s.cards['w:x'].due, before);
});

test('a credit never brings a word review sooner', () => {
  const c = course();
  const s = initialState(c, 0);
  completeLearning(c, s, ['w:x', 'z:x:0'], 0);
  let t = pass(c, s, 'w:x', 0);
  for (let i = 0; i < 4; i++) { t = s.cards['w:x'].due; review(c, s, 'w:x', GOOD, t); }
  const due = s.cards['w:x'].due;
  // one day after the word's review: the credit would give a shorter interval -> ignored
  const res = review(c, s, 'z:x:0', GOOD, t + DAY, { typed: true });
  assert.equal(res.credited, null);
  assert.equal(s.cards['w:x'].due, due);
});

test('learning session reports each item as soon as it finishes', () => {
  const c = course();
  const items = [c.items.get('w:x'), c.items.get('w:y')];
  const session = new LearningSession(items);
  const finished = [];
  for (let guard = 0; guard < 50; guard++) {
    const cur = session.next();
    if (!cur) break;
    const done = session.result(true);
    if (done) finished.push({ id: done.id, atStep: guard });
  }
  assert.deepEqual(finished.map((f) => f.id), ['w:x', 'w:y']);
  assert.ok(finished[0].atStep < 7, 'first item finishes before the session ends');
  assert.deepEqual(session.finished.map((i) => i.id), ['w:x', 'w:y']);
});

test('play: reviews first, new items spread through them, target respected', () => {
  const c = course();
  const s = initialState(c, 0);
  const p = new PlaySession(6);
  const newItem = () => nextNewItems(c, s, 0, { ignoreLimit: true, limit: 5 }).find((i) => !p.learn.items.includes(i)) || null;
  // 4 reviews due, 2 new allowed today -> one new item after every 2 reviews
  let due = 4;
  const steps = [];
  for (let guard = 0; guard < 60; guard++) {
    const step = p.next({ due, newItem: newItem(), newLeft: 2 - p.learned });
    steps.push(step.type);
    if (step.type === 'done') break;
    if (step.type === 'introduce') p.introduce(step.item);
    else if (step.type === 'review') { p.reviewed(GOOD); due--; }
    else {
      p.learn.next();
      const item = p.learnResult(true);
      if (item) completeLearning(c, s, [item.id], 0);
    }
  }
  assert.equal(p.played, 6);
  assert.equal(p.reviews, 4);
  assert.equal(p.learned, 2);
  assert.equal(p.reason, 'target');
  assert.deepEqual(steps.slice(0, 4), ['review', 'review', 'introduce', 'learn']);
  // learning views are interleaved with reviews while reviews remain
  const firstLearn = steps.indexOf('learn');
  assert.equal(steps[firstLearn + 1], 'review');
});

test('play: stops when nothing is due and no new items are left', () => {
  const p = new PlaySession(20);
  assert.deepEqual(p.next({ due: 0, newItem: null, newLeft: 0 }), { type: 'done', reason: 'empty' });
});
