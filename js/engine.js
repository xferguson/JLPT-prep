// Course engine: the to-be-learned queue, unlocking, and reviews.
// Pure functions over (course, state) so it can be unit-tested in Node.
//
// Flow
//  * The queue starts with the N5 kanji and every word that needs no N5 kanji
//    (kana words, or words whose kanji are beyond N5), interleaved so both run
//    from most to least frequent. Kana have no cards of their own: they are
//    learned through words (romaji -> kana stages).
//  * Learning an item (a Memrise-style session) moves it into the SRS.
//  * Reviews test one form per review, progressing through the item's stages
//    (kana: kana; kanji & words: romaji -> kana -> kanji).
//  * When a kanji passes its first review on its kanji stage it is "known".
//    Every word whose kanji are all known is inserted at the FRONT of the
//    queue (most frequent first).
//  * When a word passes its first review on its final stage, its 3-5 practice
//    sentences are inserted at the front of the queue as cloze cards.

import { answer as srsAnswer, introduce, newCard, DEFAULT_SRS } from './srs.js';

export const DEFAULT_SETTINGS = {
  newPerDay: 20,
  batchSize: 5,
  clozeMode: 'mixed', // 'mc' | 'type' | 'mixed'
  furigana: true,
  autoplayAudio: false,
  learningSteps: DEFAULT_SRS.learningSteps,
  relearningSteps: DEFAULT_SRS.relearningSteps,
};

export const STAGE_LABELS = { romaji: 'Romaji', kana: 'Kana', kanji: 'Kanji', cloze: 'Cloze' };

export function buildCourse({ characters, words, sentences, grammar = [], kana = [], meta = {} }) {
  const items = new Map();
  const charByValue = new Map();
  for (const c of characters) {
    items.set(c.id, c);
    charByValue.set(c.char, c);
  }
  const sentenceById = new Map(sentences.map((s) => [s.id, s]));
  const clozesByWord = new Map();
  for (const w of words) {
    items.set(w.id, w);
    const clozes = (w.sentences || []).map((ref, k) => {
      const s = sentenceById.get(ref.s);
      const [a, b] = ref.a;
      return {
        id: `z:${w.id.slice(2)}:${k}`, kind: 'cloze', wordId: w.id, sentenceId: ref.s,
        span: ref.a, answer: s.ja.slice(a, b), reading: ref.r, stages: ['cloze'],
        rank: w.rank, len: s.ja.length,
      };
    });
    clozes.forEach((z) => items.set(z.id, z));
    clozesByWord.set(w.id, clozes);
  }
  const grammarById = new Map(grammar.map((g) => [g.id, g]));
  return {
    meta, items, characters, words, sentences, grammar, kana,
    charByValue, sentenceById, clozesByWord, grammarById,
  };
}

export function dayKey(now) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Kanji plus the words that need no kanji, merged so each list keeps its own
// frequency order and they are spread evenly through each other.
export function startingItems(course) {
  const kanji = [...course.characters].sort((a, b) => a.rank - b.rank);
  const free = course.words.filter((w) => w.req.length === 0).sort((a, b) => a.rank - b.rank);
  const pos = (i, n) => (i + 0.5) / n;
  return [
    ...kanji.map((c, i) => [pos(i, kanji.length), 0, c.id]),
    ...free.map((w, i) => [pos(i, free.length), 1, w.id]),
  ].sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
}

export function initialState(course, now = Date.now()) {
  const queue = startingItems(course);
  const unlocked = {}; // id -> timestamp when a word / cloze entered the queue
  for (const id of queue) if (id.startsWith('w:')) unlocked[id] = now;
  return {
    version: 2,
    level: course.meta.level || 'N5',
    createdAt: now,
    cards: {},
    queue,
    unlocked,
    days: {},
    settings: { ...DEFAULT_SETTINGS },
  };
}

function srsConfig(state) {
  return {
    ...DEFAULT_SRS,
    learningSteps: state.settings.learningSteps || DEFAULT_SRS.learningSteps,
    relearningSteps: state.settings.relearningSteps || DEFAULT_SRS.relearningSteps,
  };
}

function today(state, now) {
  const k = dayKey(now);
  if (!state.days[k]) state.days[k] = { learned: 0, reviews: 0, again: 0 };
  const d = state.days[k];
  // detailed counters used by the Stats view
  d.learnedBy ||= {};
  d.mastered ||= {};
  d.by ||= {}; // "kind:stage" -> [passed, failed]
  d.mat ||= {}; // learning | young | mature -> [passed, failed]
  d.ratings ||= [0, 0, 0, 0];
  return d;
}

export function stats(course, state, now = Date.now()) {
  const s = { char: {}, word: {}, cloze: {}, due: 0, learnedToday: 0, reviewsToday: 0 };
  for (const kind of ['char', 'word', 'cloze']) s[kind] = { total: 0, queued: 0, learning: 0, known: 0 };
  const inQueue = new Set(state.queue);
  for (const item of course.items.values()) {
    const b = s[item.kind];
    b.total++;
    const card = state.cards[item.id];
    if (card) {
      if (card.passedFinal) b.known++;
      else b.learning++;
      if (card.due <= now) s.due++;
    } else if (inQueue.has(item.id)) b.queued++;
  }
  const t = state.days[dayKey(now)] || { learned: 0, reviews: 0 };
  s.learnedToday = t.learned;
  s.reviewsToday = t.reviews;
  s.newLeftToday = Math.max(0, state.settings.newPerDay - t.learned);
  s.streak = streak(state, now);
  return s;
}

export function streak(state, now = Date.now()) {
  let n = 0;
  let t = now;
  // today counts if already studied; otherwise start from yesterday
  const active = (k) => state.days[k] && (state.days[k].reviews > 0 || state.days[k].learned > 0);
  if (!active(dayKey(t))) t -= 86400000;
  while (active(dayKey(t))) {
    n++;
    t -= 86400000;
  }
  return n;
}

// Next items to learn. `ignoreLimit` lets the learner go past the daily cap.
export function nextNewItems(course, state, now = Date.now(), { ignoreLimit = false } = {}) {
  const left = ignoreLimit ? state.settings.batchSize
    : Math.min(state.settings.batchSize, Math.max(0, state.settings.newPerDay - today(state, now).learned));
  const out = [];
  for (const id of state.queue) {
    if (out.length >= left) break;
    const item = course.items.get(id);
    if (item && !state.cards[id]) out.push(item);
  }
  return out;
}

// Finish a learning session: the items enter the SRS learning steps.
export function completeLearning(course, state, ids, now = Date.now()) {
  const cfg = srsConfig(state);
  const done = new Set(ids);
  for (const id of ids) {
    if (state.cards[id]) continue;
    state.cards[id] = introduce(newCard(id), now, cfg);
  }
  state.queue = state.queue.filter((id) => !done.has(id));
  const t = today(state, now);
  t.learned += ids.length;
  for (const id of ids) {
    const kind = course.items.get(id)?.kind;
    if (kind) t.learnedBy[kind] = (t.learnedBy[kind] || 0) + 1;
  }
  return state;
}

export function dueCards(state, now = Date.now()) {
  return Object.values(state.cards).filter((c) => c.due <= now).sort((a, b) => a.due - b.due);
}

export function nextDueTime(state) {
  let min = Infinity;
  for (const c of Object.values(state.cards)) min = Math.min(min, c.due);
  return min;
}

export function stageOf(course, card) {
  const item = course.items.get(card.id);
  return item.stages[Math.min(card.stage, item.stages.length - 1)];
}

// Which single view a review shows for this card.
export function reviewView(course, state, card) {
  const item = course.items.get(card.id);
  const stage = stageOf(course, card);
  if (item.kind === 'cloze') {
    const mode = state.settings.clozeMode;
    return { stage, mode: mode === 'mixed' ? (card.reps % 2 === 0 ? 'mc' : 'type') : mode };
  }
  // A freshly reached form is shown as recognition first; then alternate.
  const direction = card.newStage || card.reps % 2 === 0 ? 'recognize' : 'recall';
  return { stage, direction };
}

export function knownChars(course, state) {
  const known = new Set();
  for (const c of course.characters) if (state.cards[c.id]?.passedFinal) known.add(c.char);
  return known;
}

// Queue every locked word whose characters are all known; most frequent first,
// in front of everything already queued.
export function unlockWords(course, state, now = Date.now()) {
  const known = knownChars(course, state);
  const fresh = course.words
    .filter((w) => !state.unlocked[w.id] && !state.cards[w.id] && w.req.every((ch) => known.has(ch)))
    .sort((a, b) => a.rank - b.rank);
  return enqueueFront(state, fresh.map((w) => w.id), now);
}

// Queue a learned word's practice sentences (shorter sentences first).
export function unlockSentences(course, state, wordId, now = Date.now()) {
  const clozes = (course.clozesByWord.get(wordId) || [])
    .filter((z) => !state.unlocked[z.id] && !state.cards[z.id])
    .sort((a, b) => a.len - b.len);
  return enqueueFront(state, clozes.map((z) => z.id), now);
}

function enqueueFront(state, ids, now) {
  if (!ids.length) return [];
  const set = new Set(ids);
  state.queue = [...ids, ...state.queue.filter((id) => !set.has(id))];
  for (const id of ids) state.unlocked[id] = now;
  return ids;
}

/**
 * Record a review. Returns { card, stageAdvanced, passedFinalFirst, unlocked: [ids] }.
 */
export function review(course, state, id, rating, now = Date.now()) {
  const item = course.items.get(id);
  const prev = state.cards[id];
  const stage = stageOf(course, prev);
  const res = srsAnswer(prev, rating, now, item.stages.length, srsConfig(state));
  state.cards[id] = res.card;
  const t = today(state, now);
  t.reviews++;
  const failed = rating === 1 ? 1 : 0;
  if (failed) t.again++;
  const tally = (obj, key) => {
    obj[key] ||= [0, 0];
    obj[key][failed]++;
  };
  tally(t.by, `${item.kind}:${stage}`);
  tally(t.mat, maturity(prev));
  t.ratings[rating - 1]++;
  if (res.passedFinalFirst) t.mastered[item.kind] = (t.mastered[item.kind] || 0) + 1;
  let unlocked = [];
  if (res.passedFinalFirst) {
    if (item.kind === 'char') unlocked = unlockWords(course, state, now);
    else if (item.kind === 'word') unlocked = unlockSentences(course, state, id, now);
  }
  return { ...res, unlocked };
}

// Anki's maturity buckets: still in learning steps, young (< 21d), mature.
export function maturity(card) {
  if (card.state !== 'review') return 'learning';
  return card.ivl >= 21 ? 'mature' : 'young';
}

// Brings a restored/imported state in line with the course (new data, settings).
export function reconcile(course, state, now = Date.now()) {
  state.settings = { ...DEFAULT_SETTINGS, ...state.settings };
  state.unlocked ||= {};
  state.days ||= {};
  state.cards = Object.fromEntries(Object.entries(state.cards).filter(([id]) => course.items.has(id)));
  state.queue = state.queue.filter((id) => course.items.has(id) && !state.cards[id]);
  const queued = new Set(state.queue);
  for (const id of startingItems(course)) {
    if (id.startsWith('w:')) state.unlocked[id] ||= now;
    if (!state.cards[id] && !queued.has(id)) state.queue.push(id);
  }
  state.version = 2;
  unlockWords(course, state, now);
  for (const w of course.words) if (state.cards[w.id]?.passedFinal) unlockSentences(course, state, w.id, now);
  return state;
}

// Status of any item for browsing.
export function itemStatus(state, id) {
  const card = state.cards[id];
  if (card) return card.passedFinal ? 'known' : 'learning';
  if (state.queue.includes(id)) return 'queued';
  return 'locked';
}
