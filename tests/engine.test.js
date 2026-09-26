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
  const kanji = (ch, rank, meaning) => ({ id: `c:${ch}`, kind: 'char', type: 'kanji', char: ch, romaji: 'x', kana: 'x', meanings: [meaning], rank, stages: ['romaji', 'kana', 'kanji'] });
  const characters = [kanji('日', 1, 'day'), kanji('本', 2, 'book'), kanji('人', 3, 'person')];
  const word = (id, written, kana, req, rank, sentences = []) => ({
    id, kind: 'word', written, kana, meaning: written, req, rank, sentences,
    stages: req.length ? ['romaji', 'kana', 'kanji'] : ['romaji', 'kana'],
  });
  const words = [
    word('w:1', 'はな', 'はな', [], 1, [{ s: 's:1', a: [0, 2], r: 'はな' }, { s: 's:2', a: [5, 7], r: 'はな' }]),
    word('w:2', 'の', 'の', [], 2),
    word('w:3', '日本', 'にほん', ['日', '本'], 3),
    word('w:4', '日', 'ひ', ['日'], 4),
    word('w:5', '人', 'ひと', ['人'], 5),
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

test('queue starts with kanji and kana-only words, interleaved by frequency', () => {
  const course = realCourse();
  const state = initialState(course, 0);
  assert.ok(course.characters.every((c) => c.type === 'kanji'), 'kana have no cards');
  const kanji = state.queue.filter((id) => id.startsWith('c:'));
  const words = state.queue.filter((id) => id.startsWith('w:'));
  assert.equal(kanji.length, course.characters.length);
  assert.equal(words.length, course.words.filter((w) => w.req.length === 0).length);
  // each list keeps its own frequency order
  for (const list of [kanji, words]) {
    const ranks = list.map((id) => course.items.get(id).rank);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  }
  // and they are spread through each other (a kanji within the first 10 items)
  assert.ok(state.queue.slice(0, 10).some((id) => id.startsWith('c:')));
  assert.ok(state.queue.slice(0, 10).some((id) => id.startsWith('w:')));
  // words that need N5 kanji are locked
  assert.ok(course.words.filter((w) => w.req.length).every((w) => !state.queue.includes(w.id)));
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

test('knowing a kanji unlocks its words at the front of the queue, by frequency', () => {
  const course = tinyCourse();
  const state = initialState(course, 0);
  assert.deepEqual(state.queue, ['c:日', 'w:1', 'c:本', 'w:2', 'c:人']);
  completeLearning(course, state, ['c:日', 'c:本'], 0);
  master(course, state, 'c:本', 10 * 60000);
  assert.equal(state.unlocked['w:3'], undefined); // 日本 still needs 日
  let t = 10 * 60000;
  let unlocked = [];
  for (let i = 0; i < 5 && !state.cards['c:日'].passedFinal; i++) {
    t = Math.max(t, state.cards['c:日'].due);
    unlocked = review(course, state, 'c:日', GOOD, t).unlocked;
  }
  assert.deepEqual(unlocked, ['w:3', 'w:4']); // 日本 then 日, by frequency
  assert.deepEqual(state.queue, ['w:3', 'w:4', 'w:1', 'w:2', 'c:人']);
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

test('learning a word queues its first sentence as a cloze card, behind words', () => {
  const course = tinyCourse();
  const state = initialState(course, 0);
  completeLearning(course, state, ['w:1'], 20 * MINUTE);
  const t = master(course, state, 'w:1', 30 * MINUTE);
  assert.ok(state.cards['w:1'].passedFinal);
  assert.equal(state.queue.at(-1), 'z:1:0'); // shortest sentence, at the back of the queue
  assert.ok(!state.queue.includes('z:1:1')); // the next one waits for this one
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
  assert.equal(state.days[Object.keys(state.days)[0]].learned, 5);
  assert.equal(nextNewItems(course, state, 0).length, 2);
  assert.equal(nextNewItems(course, state, 0, { ignoreLimit: true }).length, 5);
});

test('full real-data run: learning every kanji unlocks every word', () => {
  const course = realCourse();
  const state = initialState(course, 0);
  let now = 0;
  const allChars = course.characters.map((c) => c.id);
  completeLearning(course, state, allChars, now);
  for (const id of allChars) now = master(course, state, id, now);
  const words = state.queue.filter((id) => id.startsWith('w:'));
  assert.equal(words.length, course.words.length);
  const w = course.words.find((x) => x.sentences.length >= 3 && state.queue.includes(x.id));
  completeLearning(course, state, [w.id], now);
  master(course, state, w.id, now);
  assert.equal(state.queue.filter((id) => id.startsWith(`z:${w.id.slice(2)}:`)).length, 1);
  assert.ok(dueCards(state, Infinity).length > 0);
});

test('reconcile restores queue invariants', () => {
  const course = tinyCourse();
  const state = initialState(course, 0);
  state.queue = [];
  state.cards['bogus'] = newCard('bogus');
  state.cards['c:の'] = newCard('c:の'); // kana card from an older version
  reconcile(course, state, 0);
  assert.equal(state.cards.bogus, undefined);
  assert.equal(state.cards['c:の'], undefined);
  assert.equal(state.queue.length, 5);
});

test('learning session interleaves and repeats failed views', () => {
  const course = tinyCourse();
  const items = ['c:日', 'c:本', 'c:人'].map((id) => course.items.get(id));
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
  assert.equal(seen[0], '日:present');
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
