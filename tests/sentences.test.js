import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCourse, initialState, completeLearning, nextNewItems, nextSentenceFor, unlockNextSentence,
  newCandidates, dueWordIds, reconcile,
} from '../js/engine.js';
import { DAY } from '../js/srs.js';

// N learned words (w:0..), each with sentences; M unlearned words (n:0..) in the queue.
// sentence k of word i: length grows with k; `vocab(i, k)` lists other words in it.
function deck({ learned = 60, unlearned = 10, perWord = 2, vocab = () => [] } = {}) {
  const words = [];
  const sentences = [];
  for (let i = 0; i < learned; i++) {
    const refs = [];
    for (let k = 0; k < perWord; k++) {
      const id = `s:${i}:${k}`;
      sentences.push({ id, ja: `x${'。'.repeat(k + 1)}`, en: '', t: [['x'], ['。'.repeat(k + 1)]], g: [], w: [`w:${i}`, ...vocab(i, k)] });
      refs.push({ s: id, a: [0, 1], r: 'x' });
    }
    words.push({ id: `w:${i}`, kind: 'word', written: `x${i}`, kana: 'x', meaning: `m${i}`, req: [], rank: i + 1, stages: ['romaji', 'kana'], sentences: refs });
  }
  for (let j = 0; j < unlearned; j++) {
    words.push({ id: `n:${j}`, kind: 'word', written: `n${j}`, kana: 'n', meaning: `n${j}`, req: [], rank: 1000 + j, stages: ['romaji', 'kana'], sentences: [] });
  }
  const c = buildCourse({ characters: [], words, sentences, meta: { level: 'N5' } });
  const s = initialState(c, 0);
  s.settings.newPerDay = 100;
  const ids = words.filter((w) => w.id.startsWith('w:')).map((w) => w.id);
  completeLearning(c, s, ids, 0);
  // all learned words in review and passed; due times staggered: w:0 most overdue
  ids.forEach((id, i) => { s.cards[id] = { ...s.cards[id], state: 'review', ivl: 5, passedFinal: true, stage: 1, due: 10 * DAY + i }; });
  for (const id of ids) unlockNextSentence(c, s, id, 0);
  s.days = {};
  return { c, s };
}
const NOW = 20 * DAY;
const dueOnly = (s, n) => Object.values(s.cards).forEach((card, i) => { if (card.id.startsWith('w:') && Number(card.id.slice(2)) >= n) card.due = 30 * DAY + i; });

test('51 due: a 5-card batch is 3 sentences + 2 words, alternating, in due order', () => {
  const { c, s } = deck();
  dueOnly(s, 51);
  assert.equal(dueWordIds(s, NOW).length, 51);
  const batch = nextNewItems(c, s, NOW);
  assert.deepEqual(batch.map((i) => i.kind), ['cloze', 'word', 'cloze', 'word', 'cloze']);
  assert.deepEqual(batch.filter((i) => i.kind === 'cloze').map((z) => z.wordId), ['w:0', 'w:1', 'w:2']);
  assert.deepEqual(batch.filter((i) => i.kind === 'word').map((w) => w.id), ['n:0', 'n:1']);
});

test('50 due or fewer: nothing changes (words first)', () => {
  const { c, s } = deck();
  dueOnly(s, 50);
  const batch = nextNewItems(c, s, NOW);
  assert.deepEqual(batch.map((i) => i.id), ['n:0', 'n:1', 'n:2', 'n:3', 'n:4']);
});

test('a due word with no sentence left is skipped for the next due word', () => {
  const { c, s } = deck();
  dueOnly(s, 60);
  // w:0 learned both its sentences; w:1's first is still being learned (gate closed)
  completeLearning(c, s, ['z:0:0', 'z:0:1', 'z:1:0'], 0);
  s.cards['z:0:0'].passedFinal = true;
  s.cards['z:0:1'].passedFinal = true;
  const batch = nextNewItems(c, s, NOW);
  assert.deepEqual(batch.filter((i) => i.kind === 'cloze').map((z) => z.wordId), ['w:2', 'w:3', 'w:4']);
});

test('too few sentences: the rest of the batch comes from the normal queue', () => {
  const { c, s } = deck({ learned: 60, perWord: 1 });
  dueOnly(s, 60);
  // only w:0 and w:1 still have a sentence left
  const learnedAll = Array.from({ length: 58 }, (_, i) => `z:${i + 2}:0`);
  completeLearning(c, s, learnedAll, 0);
  for (const id of learnedAll) s.cards[id].passedFinal = true;
  const batch = nextNewItems(c, s, NOW);
  assert.deepEqual(batch.map((i) => i.kind), ['cloze', 'word', 'cloze', 'word', 'word']);
});

test('the sentence with the highest share of due words wins; ties go to the shorter', () => {
  // sentence 0 (short): one other word, not due; sentence 1 (long): two other words, both due
  const { c, s } = deck({ perWord: 2, vocab: (i, k) => (k === 0 ? ['w:59'] : ['w:1', 'w:2']) });
  dueOnly(s, 55); // w:0..w:54 due, w:59 not
  const due = new Set(dueWordIds(s, NOW));
  assert.equal(nextSentenceFor(c, s, 'w:0', due).id, 'z:0:1');
  assert.equal(nextSentenceFor(c, s, 'w:0', new Set()).id, 'z:0:0', 'nothing due: shorter one');
  // the queued slot (picked at unlock, when nothing was due) is swapped at pick time
  assert.ok(s.queue.includes('z:0:0'));
  const batch = nextNewItems(c, s, NOW);
  assert.equal(batch[0].id, 'z:0:1');
  assert.ok(s.queue.includes('z:0:1') && !s.queue.includes('z:0:0'), 'swapped in place');
  // and reconcile keeps the swapped slot
  reconcile(c, s, NOW);
  assert.ok(s.queue.includes('z:0:1') && !s.queue.includes('z:0:0'));
});

test('learning a sentence does not change its word\'s due date', () => {
  const { c, s } = deck();
  const before = s.cards['w:0'].due;
  completeLearning(c, s, ['z:0:0'], NOW);
  assert.equal(s.cards['w:0'].due, before);
});

test('newCandidates excludes items already being taught', () => {
  const { c, s } = deck();
  dueOnly(s, 60);
  const { sentences, normal, mix } = newCandidates(c, s, NOW, { count: 2, exclude: new Set(['z:0:0', 'n:0']) });
  assert.ok(mix);
  assert.deepEqual(sentences.map((z) => z.wordId), ['w:1', 'w:2']);
  assert.equal(normal[0].id, 'n:1');
});
