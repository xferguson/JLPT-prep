// Course engine: the to-be-learned queue, unlocking, and reviews.
// Pure functions over (course, state) so it can be unit-tested in Node.
//
// Flow
//  * Every character (kana + N5 kanji) starts in the queue, most frequent first.
//  * Learning an item (a Memrise-style session) moves it into the SRS.
//  * Reviews test one form per review, progressing through the item's stages
//    (kana: kana; kanji & words: romaji -> kana -> kanji).
//  * When a character passes its first review on its final stage (kanji for
//    kanji, kana for kana) it is "known". Every word whose characters are all
//    known is inserted at the FRONT of the queue (most frequent first).
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

export function buildCourse({ characters, words, sentences, grammar = [], meta = {} }) {
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
    meta, items, characters, words, sentences, grammar,
    charByValue, sentenceById, clozesByWord, grammarById,
  };
}

export function dayKey(now) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function initialState(course, now = Date.now()) {
  return {
    version: 1,
    level: course.meta.level || 'N5',
    createdAt: now,
    cards: {},
    queue: [...course.characters].sort((a, b) => a.rank - b.rank).map((c) => c.id),
    unlocked: {}, // id -> timestamp when a word / cloze entered the queue
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
  return state.days[k];
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
  today(state, now).learned += ids.length;
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
  const res = srsAnswer(prev, rating, now, item.stages.length, srsConfig(state));
  state.cards[id] = res.card;
  const t = today(state, now);
  t.reviews++;
  if (rating === 1) t.again++;
  let unlocked = [];
  if (res.passedFinalFirst) {
    if (item.kind === 'char') unlocked = unlockWords(course, state, now);
    else if (item.kind === 'word') unlocked = unlockSentences(course, state, id, now);
  }
  return { ...res, unlocked };
}

// Brings a restored/imported state in line with the course (new data, settings).
export function reconcile(course, state, now = Date.now()) {
  state.settings = { ...DEFAULT_SETTINGS, ...state.settings };
  state.cards = Object.fromEntries(Object.entries(state.cards).filter(([id]) => course.items.has(id)));
  state.queue = state.queue.filter((id) => course.items.has(id) && !state.cards[id]);
  const queued = new Set(state.queue);
  for (const c of course.characters) {
    if (!state.cards[c.id] && !queued.has(c.id)) state.queue.push(c.id);
  }
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
