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
//  * Sentences (cloze cards) are unlocked one at a time per word: the word's
//    first sentence when the word passes its final stage, the next one when
//    the previous sentence passes its first review. They queue behind every
//    kanji and word, first unlocked first learned.
//  * Typing a word correctly in a sentence review also counts as a review of
//    that word (see creditWord).
//  * A word or kanji answered "Again" twice in a row in reviews becomes
//    Difficult: it leaves normal reviews for the Difficult drill until a clean
//    drill graduates it (due again in 1 day, on probation). Two misses in a
//    row on a sentence flag the word it tests.
//  * Mix-ups (a wrong pick or typed answer that is another word) are recorded
//    as pairs in state.confusions.

import { answer as srsAnswer, introduce, newCard, DEFAULT_SRS, HARD, DAY } from './srs.js';

export const DEFAULT_SETTINGS = {
  newPerDay: 20,
  batchSize: 5,
  playSize: 20, // default length of a Play run (reviews + new, mixed)
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
        vocab: (s.w || []).filter((id) => id !== w.id), // other N5 words in the sentence
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
  d.credited ||= 0; // word reviews earned by typing the word in a sentence
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
      if (card.difficult) s.difficult = (s.difficult || 0) + 1;
      else if (card.due <= now) s.due++;
    } else if (inQueue.has(item.id)) b.queued++;
  }
  const t = state.days[dayKey(now)] || { learned: 0, reviews: 0 };
  s.learnedToday = t.learned;
  s.reviewsToday = t.reviews;
  s.playedToday = t.learned + t.reviews; // every card answered or learned today
  s.difficult ||= 0;
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

// Above this many due reviews, half of new learning is sentences for due words.
export const SENTENCE_MIX_DUE = 50;

/**
 * Candidates for new learning, before mixing.
 *   sentences: when more than SENTENCE_MIX_DUE reviews are due, the next
 *              sentence of each due word (most overdue first), best for what's due
 *   normal:    the queue in order (kanji and words first), minus those sentences
 *   mix:       whether the 50% sentence rule is on
 * `exclude`: ids to leave out (items already being taught).
 */
export function newCandidates(course, state, now = Date.now(), { count = 5, exclude = new Set() } = {}) {
  const due = dueCards(state, now).length;
  const mix = due > SENTENCE_MIX_DUE;
  const dueIds = dueWordIds(state, now);
  const dueSet = new Set(dueIds);
  const sentences = [];
  if (mix) {
    for (const wid of dueIds) {
      if (sentences.length >= count) break;
      const z = refreshSentenceSlot(course, state, wid, dueSet, now);
      if (z && !exclude.has(z.id)) sentences.push(z);
    }
  }
  const taken = new Set(sentences.map((z) => z.id));
  const normal = [];
  for (const id of [...state.queue]) {
    if (normal.length >= count) break;
    const item = course.items.get(id);
    if (!item || state.cards[id] || taken.has(id) || exclude.has(id)) continue;
    // a sentence taken from the queue is re-picked for what's due right now too
    const pick = item.kind === 'cloze' ? refreshSentenceSlot(course, state, item.wordId, dueSet, now) : item;
    if (pick && !taken.has(pick.id) && !exclude.has(pick.id)) {
      normal.push(pick);
      taken.add(pick.id);
    }
  }
  return { sentences, normal, mix };
}

// Next items to learn. `ignoreLimit` lets the learner go past the daily cap;
// `limit` overrides the batch size. With more than SENTENCE_MIX_DUE reviews due,
// half the batch (rounded up) is sentences for due words, alternating with the
// normal queue; missing sentences are filled from the queue.
export function nextNewItems(course, state, now = Date.now(), { ignoreLimit = false, limit } = {}) {
  const size = limit ?? state.settings.batchSize;
  const left = ignoreLimit ? size
    : Math.min(size, Math.max(0, state.settings.newPerDay - today(state, now).learned));
  if (left <= 0) return [];
  const { sentences, normal, mix } = newCandidates(course, state, now, { count: left });
  if (!mix) return normal.slice(0, left);
  const s = sentences.slice(0, Math.ceil(left / 2));
  const n = normal.slice(0, left - s.length);
  const out = [];
  while (out.length < left && (s.length || n.length)) {
    if (s.length) out.push(s.shift());
    if (n.length && out.length < left) out.push(n.shift());
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

// Cards due for normal review (Difficult cards wait for the drill instead).
export function dueCards(state, now = Date.now()) {
  return Object.values(state.cards).filter((c) => !c.difficult && c.due <= now).sort((a, b) => a.due - b.due);
}

export function nextDueTime(state) {
  let min = Infinity;
  for (const c of Object.values(state.cards)) if (!c.difficult) min = Math.min(min, c.due);
  return min;
}

// ---------------------------------------------------------------- Difficult

const FLAGGABLE = new Set(['word', 'char']);

export function difficultCards(state) {
  return Object.values(state.cards).filter((c) => c.difficult).sort((a, b) => a.difficult.since - b.difficult.since);
}

function flag(state, id, now) {
  const card = state.cards[id];
  if (!card || card.difficult) return null;
  state.cards[id] = { ...card, difficult: { since: now }, failStreak: 0, probation: false };
  return id;
}

// Manual mark / unmark from the item page.
export function markDifficult(course, state, id, on, now = Date.now()) {
  const card = state.cards[id];
  if (!card || !FLAGGABLE.has(course.items.get(id)?.kind)) return false;
  if (on) return !!flag(state, id, now);
  state.cards[id] = { ...card, difficult: null, failStreak: 0, due: Math.min(card.due, now + DAY) };
  return true;
}

// A clean drill: back to normal reviews, due in 1 day, on probation (one more
// miss in a normal review flags it again at once).
export function graduateDifficult(state, id, now = Date.now()) {
  const card = state.cards[id];
  if (!card?.difficult) return false;
  state.cards[id] = {
    ...card, difficult: null, probation: true, failStreak: 0,
    state: 'review', step: 0, ivl: 1, due: now + DAY,
  };
  return true;
}

// Drill answers are tallied apart from reviews so they don't move the review success rate.
export function recordDrill(state, ok, now = Date.now()) {
  const t = today(state, now);
  t.drill ||= [0, 0];
  t.drill[ok ? 0 : 1]++;
}

// Update the fail streak after a review and flag if needed. Returns the flagged id.
function trackFailures(course, state, item, prev, rating, now) {
  const card = state.cards[item.id];
  if (rating !== 1) {
    state.cards[item.id] = { ...card, failStreak: 0, probation: false };
    return null;
  }
  const streak = (prev.failStreak || 0) + 1;
  state.cards[item.id] = { ...card, failStreak: streak };
  if (item.kind === 'cloze') {
    if (streak < 2) return null;
    state.cards[item.id].failStreak = 0;
    return flag(state, item.wordId, now);
  }
  if (!FLAGGABLE.has(item.kind)) return null;
  if (prev.probation || streak >= 2) return flag(state, item.id, now);
  return null;
}

// ---------------------------------------------------------------- mix-ups

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const baseId = (course, id) => {
  const item = course.items.get(id);
  return item?.kind === 'cloze' ? item.wordId : id;
};

// Record that `a` was answered with `b` (either order). Sentences map to their word.
export function recordConfusion(course, state, a, b, now = Date.now()) {
  const x = baseId(course, a);
  const y = baseId(course, b);
  if (!x || !y || x === y) return null;
  if (!FLAGGABLE.has(course.items.get(x)?.kind) || !FLAGGABLE.has(course.items.get(y)?.kind)) return null;
  state.confusions ||= {};
  const k = pairKey(x, y);
  const c = state.confusions[k] || { n: 0, last: 0 };
  state.confusions[k] = { n: c.n + 1, last: now };
  return k;
}

// Words you've actually confused with `id`, most often first: [{ id, n }].
export function confusedWith(state, id) {
  const out = [];
  for (const [k, { n }] of Object.entries(state.confusions || {})) {
    const [a, b] = k.split('|');
    if (a === id) out.push({ id: b, n });
    else if (b === id) out.push({ id: a, n });
  }
  return out.sort((p, q) => q.n - p.n);
}

// Likely mix-up partners: recorded ones first, then predicted look/sound-alikes
// you have already learned (`learnedOnly`).
export function partnersOf(course, state, id, { limit = 4, learnedOnly = true } = {}) {
  const ids = confusedWith(state, id).map((p) => p.id);
  for (const s of course.items.get(id)?.sim || []) {
    if (!ids.includes(s) && (!learnedOnly || state.cards[s])) ids.push(s);
  }
  return ids.slice(0, limit);
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

// A word's sentences in the order they are learned (shortest first).
export function sentencesOf(course, wordId) {
  return [...(course.clozesByWord.get(wordId) || [])].sort((a, b) => a.len - b.len);
}

// Words due for normal review right now, most overdue first.
export function dueWordIds(state, now = Date.now()) {
  return dueCards(state, now).filter((c) => c.id.startsWith('w:')).map((c) => c.id);
}

// Share of a sentence's other N5 words that are due now (0 when it has none).
export function dueShare(cloze, dueSet) {
  if (!cloze.vocab?.length || !dueSet?.size) return 0;
  return cloze.vocab.filter((id) => dueSet.has(id)).length / cloze.vocab.length;
}

// The one sentence of a word that may be queued now. Sentences are learned one
// at a time: none is available while a learned one hasn't passed its first
// review yet. Among the unlearned ones, pick the one with the highest share of
// due words (`dueSet`); ties go to the shorter sentence.
export function nextSentenceFor(course, state, wordId, dueSet = null) {
  const all = sentencesOf(course, wordId);
  if (all.some((z) => state.cards[z.id] && !state.cards[z.id].passedFinal)) return null;
  let best = null;
  let bestShare = -1;
  for (const z of all) {
    if (state.cards[z.id]) continue;
    const share = dueShare(z, dueSet);
    if (share > bestShare) {
      best = z;
      bestShare = share;
    }
  }
  return best;
}

// Queue a word's next sentence, behind all kanji and words (first come, first learned).
export function unlockNextSentence(course, state, wordId, now = Date.now()) {
  if (!state.cards[wordId]?.passedFinal) return [];
  const z = nextSentenceFor(course, state, wordId, new Set(dueWordIds(state, now)));
  if (!z || queuedSentenceOf(course, state, wordId)) return [];
  state.queue.push(z.id);
  state.unlocked[z.id] = now;
  return [z.id];
}

function queuedSentenceOf(course, state, wordId) {
  return state.queue.find((id) => id.startsWith('z:') && course.items.get(id)?.wordId === wordId) || null;
}

// When a word's sentence is about to be learned, re-pick the best one for what
// is due right now, swapping the word's queue slot in place. Returns the item.
export function refreshSentenceSlot(course, state, wordId, dueSet, now = Date.now()) {
  if (!state.cards[wordId]?.passedFinal) return null;
  const best = nextSentenceFor(course, state, wordId, dueSet);
  if (!best) return null;
  const slot = queuedSentenceOf(course, state, wordId);
  if (slot === best.id) return best;
  if (slot) {
    state.queue[state.queue.indexOf(slot)] = best.id;
    delete state.unlocked[slot];
  } else state.queue.push(best.id);
  state.unlocked[best.id] = now;
  return best;
}

function enqueueFront(state, ids, now) {
  if (!ids.length) return [];
  const set = new Set(ids);
  state.queue = [...ids, ...state.queue.filter((id) => !set.has(id))];
  for (const id of ids) state.unlocked[id] = now;
  return ids;
}

/**
 * Typing a word correctly in a sentence is a review of that word, so it can
 * push the word's next review out. The credit is scheduled from the time that
 * has actually passed since the word's last review (like Anki's early review)
 * and only applies when it moves the word's due date later — it never makes a
 * word come back sooner. Returns { wordId, due } or null.
 */
export function creditWord(course, state, wordId, rating, now = Date.now()) {
  const card = state.cards[wordId];
  if (!card || card.state !== 'review' || rating < HARD) return null;
  const item = course.items.get(wordId);
  const last = card.lastReview ?? card.due - card.ivl * DAY;
  const elapsedDays = Math.max(1, Math.round((now - last) / DAY));
  const effective = { ...card, ivl: Math.min(card.ivl, elapsedDays) };
  const res = srsAnswer(effective, rating, now, item.stages.length, srsConfig(state));
  if (res.card.due <= card.due) return null;
  state.cards[wordId] = { ...res.card, stage: card.stage, passedFinal: card.passedFinal, newStage: false };
  today(state, now).credited++;
  return { wordId, due: res.card.due };
}

/**
 * Record a review. Returns { card, stageAdvanced, passedFinalFirst, unlocked: [ids], credited }.
 * `typed`: a cloze answer was typed (not picked), so a pass also credits the word.
 */
export function review(course, state, id, rating, now = Date.now(), { typed = false } = {}) {
  const item = course.items.get(id);
  const prev = state.cards[id];
  const stage = stageOf(course, prev);
  const res = srsAnswer(prev, rating, now, item.stages.length, srsConfig(state));
  state.cards[id] = res.card;
  const flagged = trackFailures(course, state, item, prev, rating, now);
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
    else if (item.kind === 'word') unlocked = unlockNextSentence(course, state, id, now);
    else if (item.kind === 'cloze') unlocked = unlockNextSentence(course, state, item.wordId, now);
  }
  const credited = item.kind === 'cloze' && typed ? creditWord(course, state, item.wordId, rating, now) : null;
  return { ...res, card: state.cards[id], unlocked, credited, flagged };
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
  state.confusions ||= {};
  state.notes ||= {};
  state.cards = Object.fromEntries(Object.entries(state.cards).filter(([id]) => course.items.has(id)));
  state.queue = state.queue.filter((id) => course.items.has(id) && !state.cards[id]);
  const queued = new Set(state.queue);
  for (const id of startingItems(course)) {
    if (id.startsWith('w:')) state.unlocked[id] ||= now;
    if (!state.cards[id] && !queued.has(id)) state.queue.push(id);
  }
  state.version = 4;
  // one-time: words / kanji failing right now after 2+ lapses go straight to the drill
  if (!state.difficultSeeded) {
    for (const card of Object.values(state.cards)) {
      if (card.state === 'relearning' && card.lapses >= 2 && FLAGGABLE.has(course.items.get(card.id)?.kind)) flag(state, card.id, now);
    }
    state.difficultSeeded = true;
  }
  unlockWords(course, state, now);
  // one queued sentence per word at most (older versions queued them all); the
  // first valid one queued is kept, since it may have been picked for due words
  const open = (wordId) => state.cards[wordId]?.passedFinal
    && !sentencesOf(course, wordId).some((z) => state.cards[z.id] && !state.cards[z.id].passedFinal);
  const slotted = new Set();
  state.queue = state.queue.filter((id) => {
    if (!id.startsWith('z:')) return true;
    const z = course.items.get(id);
    const keep = z && !state.cards[id] && open(z.wordId) && !slotted.has(z.wordId);
    if (keep) slotted.add(z.wordId);
    else delete state.unlocked[id];
    return keep;
  });
  for (const w of course.words) unlockNextSentence(course, state, w.id, now);
  // sentences always queue behind kanji and words
  state.queue = [...state.queue.filter((id) => !id.startsWith('z:')), ...state.queue.filter((id) => id.startsWith('z:'))];
  return state;
}

// Status of any item for browsing.
export function itemStatus(state, id) {
  const card = state.cards[id];
  if (card?.difficult) return 'difficult';
  if (card) return card.passedFinal ? 'known' : 'learning';
  if (state.queue.includes(id)) return 'queued';
  return 'locked';
}
