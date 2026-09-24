import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildCourse, initialState, nextNewItems, completeLearning, dueCards, review,
  reviewView, stageOf, reconcile,
} from '../js/engine.js';
import { AGAIN, HARD, GOOD, EASY, DAY, MINUTE, answer, introduce, newCard } from '../js/srs.js';
import { LearningSession } from '../js/session.js';
import { toRomaji, romajiToKana, normalizeAnswer, rubySegments } from '../js/kana.js';

const load = (f) => JSON.parse(readFileSync(new URL(`../data/n5/${f}`, import.meta.url)));
const realCourse = () => buildCourse({
  characters: load('characters.json'), words: load('words.json'),
  sentences: load('sentences.json'), grammar: load('grammar.json'), meta: load('meta.json'),
});

// A tiny hand-made course so the flow is easy to follow.
function tinyCourse() {
  const characters = [
    { id: 'c:の', kind: 'char', type: 'hiragana', char: 'の', romaji: 'no', rank: 1, stages: ['kana'] },
    { id: 'c:は', kind: 'char', type: 'hiragana', char: 'は', romaji: 'ha', rank: 2, stages: ['kana'] },
    { id: 'c:な', kind: 'char', type: 'hiragana', char: 'な', romaji: 'na', rank: 3, stages: ['kana'] },
    { id: 'c:日', kind: 'char', type: 'kanji', char: '日', romaji: 'nichi', kana: 'にち', meanings: ['day'], rank: 4, stages: ['romaji', 'kana', 'kanji'] },
  ];
  const words = [
    { id: 'w:1', kind: 'word', written: 'はな', kana: 'はな', meaning: 'flower', req: ['は', 'な'], rank: 2, stages: ['romaji', 'kana'], sentences: [{ s: 's:1', a: [0, 2], r: 'はな' }, { s: 's:2', a: [3, 5], r: 'はな' }] },
    { id: 'w:2', kind: 'word', written: 'の', kana: 'の', meaning: 'of', req: ['の'], rank: 1, stages: ['romaji', 'kana'], sentences: [] },
    { id: 'w:3', kind: 'word', written: '日', kana: 'ひ', meaning: 'sun', req: ['ひ', '日'], rank: 3, stages: ['romaji', 'kana', 'kanji'], sentences: [] },
    { id: 'w:4', kind: 'word', written: 'はは', kana: 'はは', meaning: 'mother', req: ['は'], rank: 4, stages: ['romaji', 'kana'], sentences: [] },
  ];
  const sentences = [
    { id: 's:1', ja: 'はなです。', en: "It's a flower.", t: [['はな'], ['です'], ['。']], g: [] },
    { id: 's:2', ja: 'きれいなはなですね。', en: 'Pretty flower.', t: [], g: [] },
  ];
  return buildCourse({ characters, words, sentences, meta: { level: 'N5' } });
}

// Pass a card through all its stages with Good answers.
function master(course, state, id, now) {
  let t = now;
  for (let i = 0; i < 10 && !state.cards[id].passedFinal; i++) {
    t = Math.max(t, state.cards[id].due);
    review(course, state, id, GOOD, t);
  }
  return t;
}

test('characters start in the queue in frequency order', () => {
  const course = realCourse();
  const state = initialState(course, 0);
  const ranks = state.queue.map((id) => course.items.get(id).rank);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  assert.equal(state.queue.length, course.characters.length);
  // no words or sentences until characters are known
  assert.ok(state.queue.every((id) => id.startsWith('c:')));
});

test('SRS: learning steps, graduation, stage progression', () => {
  const now = 1_000_000;
  let c = introduce(newCard('x'), now);
  assert.equal(c.state, 'learning');
  assert.equal(c.due, now + 10 * MINUTE);
  // stage 0 (romaji) good -> stage 1 (kana), next step 1 day
  let r = answer(c, GOOD, c.due, 3);
  assert.equal(r.card.stage, 1);
  assert.ok(r.stageAdvanced);
  assert.equal(r.card.due - c.due, DAY);
  // kana good -> graduate, stage 2 (kanji)
  r = answer(r.card, GOOD, r.card.due, 3);
  assert.equal(r.card.state, 'review');
  assert.equal(r.card.stage, 2);
  assert.equal(r.passedFinalFirst, false);
  // first successful kanji review -> passedFinal
  r = answer(r.card, GOOD, r.card.due, 3);
  assert.ok(r.passedFinalFirst);
  assert.equal(r.card.ivl, 3); // max(1+1, 1*2.5) rounded
  // a lapse goes to relearning, keeps the stage
  const lapsed = answer(r.card, AGAIN, r.card.due, 3).card;
  assert.equal(lapsed.state, 'relearning');
  assert.equal(lapsed.stage, 2);
  assert.equal(lapsed.lapses, 1);
  // Hard does not advance the stage but counts as a pass on the final stage
  const k = answer(introduce(newCard('k'), 0), HARD, 10 * MINUTE, 1);
  assert.ok(k.passedFinalFirst);
  const w = answer(introduce(newCard('w'), 0), HARD, 10 * MINUTE, 3);
  assert.equal(w.card.stage, 0);
  // Easy graduates immediately with the easy interval
  const e = answer(introduce(newCard('e'), 0), EASY, 10 * MINUTE, 3);
  assert.equal(e.card.state, 'review');
  assert.equal(e.card.ivl, 4);
});

test('knowing characters unlocks words at the front of the queue, by frequency', () => {
  const course = tinyCourse();
  let now = 0;
  const state = initialState(course, now);
  state.settings.batchSize = 3;
  const batch = nextNewItems(course, state, now).map((i) => i.id);
  assert.deepEqual(batch, ['c:の', 'c:は', 'c:な']);
  completeLearning(course, state, batch, now);
  assert.deepEqual(state.queue, ['c:日']);

  now = 10 * MINUTE;
  // は passes its (only, kana) stage: はは unlocks; はな still needs な
  let r = review(course, state, 'c:は', GOOD, now);
  assert.ok(r.passedFinalFirst);
  assert.deepEqual(r.unlocked, ['w:4']);
  r = review(course, state, 'c:の', GOOD, now);
  assert.deepEqual(r.unlocked, ['w:2']);
  r = review(course, state, 'c:な', GOOD, now);
  assert.deepEqual(r.unlocked, ['w:1']);
  // newest unlocks go first; the remaining character comes after the words
  assert.deepEqual(state.queue, ['w:1', 'w:2', 'w:4', 'c:日']);
  // 日 alone does not unlock 日 (ひ) because ひ is not known
  assert.equal(state.unlocked['w:3'], undefined);
});

test('a kanji only counts once it passes a review on its kanji stage', () => {
  const course = tinyCourse();
  const state = initialState(course, 0);
  completeLearning(course, state, ['c:日'], 0);
  let t = 10 * MINUTE;
  const r1 = review(course, state, 'c:日', GOOD, t);
  assert.equal(stageOf(course, r1.card), 'kana');
  assert.equal(r1.passedFinalFirst, false);
  t = state.cards['c:日'].due;
  const r2 = review(course, state, 'c:日', GOOD, t);
  assert.equal(stageOf(course, r2.card), 'kanji');
  assert.equal(r2.passedFinalFirst, false);
  t = state.cards['c:日'].due;
  const r3 = review(course, state, 'c:日', GOOD, t);
  assert.ok(r3.passedFinalFirst);
});

test('learning a word queues its sentences as cloze cards', () => {
  const course = tinyCourse();
  const state = initialState(course, 0);
  completeLearning(course, state, ['c:は', 'c:な'], 0);
  review(course, state, 'c:は', GOOD, 10 * MINUTE);
  review(course, state, 'c:な', GOOD, 10 * MINUTE);
  completeLearning(course, state, ['w:1'], 20 * MINUTE);
  const t = master(course, state, 'w:1', 30 * MINUTE);
  assert.ok(state.cards['w:1'].passedFinal);
  assert.deepEqual(state.queue.slice(0, 2), ['z:1:0', 'z:1:1']); // shorter sentence first
  const z = course.items.get('z:1:0');
  assert.equal(z.answer, 'はな');
  completeLearning(course, state, ['z:1:0'], t);
  assert.equal(reviewView(course, state, state.cards['z:1:0']).stage, 'cloze');
});

test('daily new-item limit', () => {
  const course = realCourse();
  const state = initialState(course, 0);
  state.settings.newPerDay = 7;
  state.settings.batchSize = 5;
  completeLearning(course, state, nextNewItems(course, state, 0).map((i) => i.id), 0);
  assert.equal(nextNewItems(course, state, 0).length, 2);
  assert.equal(nextNewItems(course, state, 0, { ignoreLimit: true }).length, 5);
});

test('full real-data run: learning every character unlocks words and sentences', () => {
  const course = realCourse();
  const state = initialState(course, 0);
  let now = 0;
  const allChars = course.characters.map((c) => c.id);
  completeLearning(course, state, allChars, now);
  for (const id of allChars) now = master(course, state, id, now);
  const words = state.queue.filter((id) => id.startsWith('w:'));
  assert.ok(words.length > 600, `unlocked ${words.length} words`);
  // words are in frequency order
  const ranks = words.map((id) => course.items.get(id).rank);
  assert.ok(ranks.length > 0);
  const w = course.words.find((x) => x.sentences.length >= 3 && state.queue.includes(x.id));
  completeLearning(course, state, [w.id], now);
  master(course, state, w.id, now);
  assert.equal(state.queue.filter((id) => id.startsWith(`z:${w.id.slice(2)}:`)).length, w.sentences.length);
  assert.ok(dueCards(state, Infinity).length > 0);
});

test('reconcile restores queue invariants', () => {
  const course = tinyCourse();
  const state = initialState(course, 0);
  state.queue = [];
  state.cards['bogus'] = newCard('bogus');
  reconcile(course, state, 0);
  assert.equal(state.cards.bogus, undefined);
  assert.equal(state.queue.length, 4);
});

test('learning session interleaves and repeats failed views', () => {
  const course = tinyCourse();
  const items = ['c:の', 'c:は', 'c:な'].map((id) => course.items.get(id));
  const s = new LearningSession(items);
  const seen = [];
  let failedOnce = false;
  for (let guard = 0; guard < 100; guard++) {
    const cur = s.next();
    if (!cur) break;
    seen.push(`${cur.item.char}:${cur.view}`);
    const fail = !failedOnce && cur.view === 'mc-recall';
    if (fail) failedOnce = true;
    s.result(!fail);
  }
  assert.ok(s.done);
  // each item presented first, never the same item twice in a row while others are live
  assert.equal(seen[0], 'の:present');
  assert.equal(seen.filter((v) => v.endsWith('mc-recall')).length, 4);
  assert.equal(seen.length, 13);
  for (let i = 1; i < seen.length - 2; i++) assert.notEqual(seen[i].split(':')[0], seen[i - 1].split(':')[0]);
});

test('kana helpers', () => {
  assert.equal(toRomaji('がっこう'), 'gakkou');
  assert.equal(toRomaji('きって'), 'kitte');
  assert.equal(toRomaji('コーヒー'), 'koohii');
  assert.equal(toRomaji('しゃしん'), 'shashin');
  assert.equal(toRomaji('こんや'), "kon'ya");
  assert.equal(toRomaji('まっちゃ'), 'matcha');
  assert.equal(romajiToKana('gakkou'), 'がっこう');
  assert.equal(romajiToKana('shinbun'), 'しんぶん');
  assert.equal(romajiToKana("kon'ya"), 'こんや');
  assert.equal(romajiToKana('matcha'), 'まっちゃ');
  assert.equal(romajiToKana('konnichiha'), 'こんにちは');
  assert.equal(normalizeAnswer(' タベ '), 'たべ');
  assert.deepEqual(rubySegments('食べ', 'たべ'), [['食', 'た'], ['べ', null]]);
  assert.deepEqual(rubySegments('お茶', 'おちゃ'), [['お', null], ['茶', 'ちゃ']]);
});
