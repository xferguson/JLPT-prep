// Aggregations for the Stats view. Pure functions over (course, state).
import { dayKey, stageOf, maturity } from './engine.js';

export const KINDS = ['char', 'word', 'cloze'];
export const KIND_NAMES = { char: 'Kanji', word: 'Words', cloze: 'Sentences' };
const DAY = 86400000;

// Midnight-anchored list of the last `n` day keys, oldest first (includes today).
export function lastDays(now, n) {
  const out = [];
  const d = new Date(now);
  d.setHours(12, 0, 0, 0); // noon avoids DST edge cases
  for (let i = n - 1; i >= 0; i--) out.push(dayKey(d.getTime() - i * DAY));
  return out;
}

// Number of days since the first recorded study day (at least 1).
export function daysOfHistory(state, now) {
  const keys = Object.keys(state.days).sort();
  if (!keys.length) return 1;
  const first = new Date(`${keys[0]}T12:00:00`).getTime();
  return Math.max(1, Math.round((now - first) / DAY) + 1);
}

// Current snapshot: per kind known / learning / unlocked / locked, and how many
// cards sit at each review stage.
export function snapshot(course, state) {
  const queued = new Set(state.queue);
  const out = {};
  for (const k of KINDS) out[k] = { total: 0, known: 0, learning: 0, queued: 0, locked: 0, stages: {} };
  for (const item of course.items.values()) {
    const b = out[item.kind];
    b.total++;
    const card = state.cards[item.id];
    if (card) {
      if (card.passedFinal) b.known++;
      else b.learning++;
      const st = stageOf(course, card);
      b.stages[st] = (b.stages[st] || 0) + 1;
    } else if (queued.has(item.id)) b.queued++;
    else b.locked++;
  }
  return out;
}

// Cumulative "known" (passed final stage) per kind for each of the last n days.
// Counted back from today's total, so the last point always equals the current
// count even if older days predate detailed stats.
export function knownOverTime(course, state, now, n) {
  const snap = snapshot(course, state);
  const keys = lastDays(now, n);
  const series = {};
  for (const kind of KINDS) {
    let within = 0;
    for (const k of keys) within += state.days[k]?.mastered?.[kind] || 0;
    let running = Math.max(0, snap[kind].known - within); // count at the start of the range
    series[kind] = keys.map((k) => {
      running += state.days[k]?.mastered?.[kind] || 0;
      return running;
    });
  }
  return { keys, series };
}

// Reviews per day over the last n days, split into passed / failed.
export function reviewHistory(state, now, n) {
  return lastDays(now, n).map((k) => {
    const d = state.days[k] || {};
    const reviews = d.reviews || 0;
    const failed = d.again || 0;
    return { key: k, passed: reviews - failed, failed, learned: d.learned || 0 };
  });
}

function sumPairs(state, keys, field) {
  const out = {};
  for (const k of keys) {
    const obj = state.days[k]?.[field];
    if (!obj) continue;
    for (const [name, [p, f]] of Object.entries(obj)) {
      out[name] ||= [0, 0];
      out[name][0] += p;
      out[name][1] += f;
    }
  }
  return out;
}

// Success rates over the last n days: by "kind:stage", by maturity, ratings.
export function successRates(state, now, n) {
  const keys = lastDays(now, n);
  const by = sumPairs(state, keys, 'by');
  const mat = sumPairs(state, keys, 'mat');
  const ratings = [0, 0, 0, 0];
  let reviews = 0;
  let failed = 0;
  for (const k of keys) {
    const d = state.days[k];
    if (!d) continue;
    reviews += d.reviews || 0;
    failed += d.again || 0;
    (d.ratings || []).forEach((v, i) => { ratings[i] += v; });
  }
  const rate = ([p, f] = [0, 0]) => ({ passed: p, failed: f, total: p + f, rate: p + f ? p / (p + f) : null });
  const byStage = {};
  for (const [key, pair] of Object.entries(by)) byStage[key] = rate(pair);
  return {
    reviews,
    failed,
    rate: reviews ? (reviews - failed) / reviews : null,
    byStage,
    byMaturity: Object.fromEntries(['learning', 'young', 'mature'].map((m) => [m, rate(mat[m])])),
    ratings,
  };
}

// Cards due per day for the next n days (day 0 includes anything overdue), by kind.
export function forecast(course, state, now, n) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const days = Array.from({ length: n }, (_, i) => {
    const t = start.getTime() + i * DAY + DAY / 2;
    return { key: dayKey(t), char: 0, word: 0, cloze: 0, total: 0 };
  });
  for (const card of Object.values(state.cards)) {
    if (card.difficult) continue; // waiting for the Difficult drill, not scheduled
    const i = Math.max(0, Math.floor((card.due - start.getTime()) / DAY));
    if (i >= n) continue;
    const kind = course.items.get(card.id)?.kind;
    if (!kind) continue;
    days[i][kind]++;
    days[i].total++;
  }
  return days;
}

// Soonest-due cards.
export function upcoming(course, state, limit = 8) {
  return Object.values(state.cards)
    .filter((c) => !c.difficult)
    .sort((a, b) => a.due - b.due)
    .slice(0, limit)
    .map((card) => ({ card, item: course.items.get(card.id), stage: stageOf(course, card), maturity: maturity(card) }));
}

// Items that give the most trouble: most lapses, then lowest ease.
export function hardest(course, state, limit = 10) {
  return Object.values(state.cards)
    .filter((c) => c.lapses > 0)
    .sort((a, b) => b.lapses - a.lapses || a.ease - b.ease)
    .slice(0, limit)
    .map((card) => ({ card, item: course.items.get(card.id) }));
}
