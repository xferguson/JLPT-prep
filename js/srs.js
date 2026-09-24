// Anki-style spaced repetition (SM-2 family, like Anki's v2 scheduler), extended
// with "stages": each item is reviewed against a sequence of forms
// (romaji -> kana -> kanji). A Good/Easy answer on a non-final stage moves the
// card to the next form; a passing answer (Hard/Good/Easy) on the final stage
// the first time marks the item as `passedFinal`, which drives unlocking.

export const AGAIN = 1;
export const HARD = 2;
export const GOOD = 3;
export const EASY = 4;

export const MINUTE = 60 * 1000;
export const DAY = 24 * 60 * MINUTE;

export const DEFAULT_SRS = {
  learningSteps: [10, 1440], // minutes; after a learning session
  relearningSteps: [10], // minutes; after a lapse
  graduatingInterval: 1, // days
  easyInterval: 4, // days
  startingEase: 2.5,
  minEase: 1.3,
  easyBonus: 1.3,
  hardMultiplier: 1.2,
  lapseMultiplier: 0.5, // new interval after a lapse, as a fraction of the old one
  maxInterval: 365 * 5, // days
};

export function newCard(id) {
  return {
    id, state: 'new', stage: 0, step: 0, due: 0, ivl: 0,
    ease: DEFAULT_SRS.startingEase, reps: 0, lapses: 0, passedFinal: false,
  };
}

// Called when an item finishes its learning session: it enters the learning steps.
export function introduce(card, now, cfg = DEFAULT_SRS) {
  return {
    ...card, state: 'learning', step: 0, stage: 0, learnedAt: now,
    ease: cfg.startingEase, due: now + cfg.learningSteps[0] * MINUTE,
  };
}

function clampIvl(days, cfg) {
  return Math.min(cfg.maxInterval, Math.max(1, Math.round(days)));
}

// Pure scheduling of the SRS fields (no stage logic).
function nextSchedule(card, rating, now, cfg) {
  const c = { ...card };
  if (c.state === 'learning' || c.state === 'relearning' || c.state === 'new') {
    const steps = c.state === 'relearning' ? cfg.relearningSteps : cfg.learningSteps;
    const graduate = (ivl) => {
      c.state = 'review';
      c.step = 0;
      c.ivl = ivl;
      c.due = now + ivl * DAY;
    };
    if (rating === AGAIN) {
      c.step = 0;
      c.due = now + steps[0] * MINUTE;
    } else if (rating === HARD) {
      // repeat the current step, a little longer (capped at one extra day)
      const cur = steps[Math.min(c.step, steps.length - 1)];
      c.due = now + Math.min(cur * 1.5, cur + 1440) * MINUTE;
    } else if (rating === GOOD) {
      if (c.step + 1 >= steps.length) {
        graduate(c.state === 'relearning' ? Math.max(1, c.ivl) : cfg.graduatingInterval);
      } else {
        c.step += 1;
        c.due = now + steps[c.step] * MINUTE;
      }
    } else {
      graduate(c.state === 'relearning' ? Math.max(1, c.ivl) + 1 : cfg.easyInterval);
    }
    if (c.state === 'new') c.state = 'learning';
    return c;
  }
  // review
  if (rating === AGAIN) {
    c.lapses += 1;
    c.ease = Math.max(cfg.minEase, c.ease - 0.2);
    c.ivl = clampIvl(c.ivl * cfg.lapseMultiplier, cfg);
    c.state = 'relearning';
    c.step = 0;
    c.due = now + cfg.relearningSteps[0] * MINUTE;
    return c;
  }
  let ivl;
  if (rating === HARD) {
    ivl = Math.max(c.ivl + 1, c.ivl * cfg.hardMultiplier);
    c.ease = Math.max(cfg.minEase, c.ease - 0.15);
  } else if (rating === GOOD) {
    ivl = Math.max(c.ivl + 1, c.ivl * c.ease);
  } else {
    ivl = Math.max(c.ivl + 2, c.ivl * c.ease * cfg.easyBonus);
    c.ease += 0.15;
  }
  c.ivl = clampIvl(ivl, cfg);
  c.due = now + c.ivl * DAY;
  return c;
}

/**
 * Answer a card. `stageCount` is the number of forms the item is tested on.
 * Returns { card, stageAdvanced, passedFinalFirst }.
 */
export function answer(card, rating, now, stageCount = 1, cfg = DEFAULT_SRS) {
  const c = nextSchedule(card, rating, now, cfg);
  c.reps = (card.reps || 0) + 1;
  c.lastReview = now;
  let stageAdvanced = false;
  let passedFinalFirst = false;
  const finalStage = stageCount - 1;
  if (card.stage < finalStage && rating >= GOOD) {
    c.stage = card.stage + 1;
    c.newStage = true; // next review shows a form the learner hasn't been tested on
    stageAdvanced = true;
  } else {
    c.newStage = false;
    if (card.stage >= finalStage && rating >= HARD && !card.passedFinal) {
      c.passedFinal = true;
      passedFinalFirst = true;
    }
  }
  return { card: c, stageAdvanced, passedFinalFirst };
}

// Due time each rating would give, for button labels.
export function preview(card, now, cfg = DEFAULT_SRS) {
  const out = {};
  for (const r of [AGAIN, HARD, GOOD, EASY]) out[r] = nextSchedule(card, r, now, cfg).due - now;
  return out;
}

export function formatInterval(ms) {
  const m = Math.round(ms / MINUTE);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(ms / DAY);
  if (d < 30) return `${d}d`;
  const mo = d / 30;
  if (mo < 12) return `${mo.toFixed(mo < 10 ? 1 : 0)}mo`;
  return `${(d / 365).toFixed(1)}y`;
}
