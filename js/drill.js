// Difficult drill: a relearn session for words / kanji you keep missing.
//
// For each item:
//   reteach     - the full card again: every form, kanji breakdown, a sentence, your note
//   contrast    - (if you've mixed it up with other words) the group side by side
//   tellapart   - rounds of "which one is it?" across that group, until you get
//                 every word right and a run of group size + 1 in a row (max 12)
//   mc-recognize, mc-recall, type-recall, listen - the tests
//
// Items are drilled in small groups whose steps are interleaved, so there's a
// little space between an item's views. A missed test comes back after 1, then
// 3, then 6 other steps. An item is "clean" when it passed every test with no
// misses; the app graduates clean items back to normal reviews.
//
// `groupOnly` runs just contrast + tell-apart (the "Drill this group" button).

export const DRILL_TESTS = ['mc-recognize', 'mc-recall', 'type-recall', 'listen'];
const GAPS = [1, 3, 6];
const MAX_TELL_ROUNDS = 12;

export class DrillSession {
  constructor(items, { partners = new Map(), listen = true, chunk = 3, groupOnly = false } = {}) {
    this.items = items;
    this.results = new Map(); // id -> { clean, misses }
    this.tell = new Map(); // id -> { group, correct: Set, streak, rounds, lastTarget }
    this.steps = [];
    this.current = null;
    this.doneSteps = 0;
    const plan = (item) => {
      const group = [item, ...(partners.get(item.id) || [])];
      const hasGroup = group.length > 1;
      const views = groupOnly ? [] : ['reteach'];
      if (hasGroup) {
        views.push('contrast', 'tellapart');
        this.tell.set(item.id, { group, correct: new Set(), streak: 0, rounds: 0, lastTarget: null });
      }
      if (!groupOnly) views.push(...DRILL_TESTS.filter((v) => listen || v !== 'listen'));
      this.results.set(item.id, { clean: true, misses: 0 });
      return views.map((view) => ({ item, view }));
    };
    for (let i = 0; i < items.length; i += chunk) {
      const lists = items.slice(i, i + chunk).map(plan);
      for (let r = 0; lists.some((l) => l.length > r); r++) {
        for (const l of lists) if (l[r]) this.steps.push(l[r]);
      }
    }
    this.totalSteps = this.steps.length;
  }

  get done() {
    return this.steps.length === 0 && !this.current;
  }

  get progress() {
    return this.totalSteps ? Math.min(1, this.doneSteps / this.totalSteps) : 1;
  }

  // Next step: { item, view, group?, target? } or null when finished.
  next() {
    const step = this.steps.shift() || null;
    if (step?.view === 'tellapart') {
      const t = this.tell.get(step.item.id);
      step.group = t.group;
      step.target = this.pickTarget(t);
    }
    this.current = step;
    return step;
  }

  // The word to ask about: one not yet answered correctly, never the same twice in a row.
  pickTarget(t) {
    const order = t.group.filter((g) => g.id !== t.lastTarget);
    const fresh = order.find((g) => !t.correct.has(g.id));
    const target = fresh || order[(t.rounds * 7) % order.length] || t.group[0];
    t.lastTarget = target.id;
    return target;
  }

  // Record the current step. Returns { item, clean } when that item has no steps left.
  result(ok) {
    const step = this.current;
    if (!step) return null;
    this.current = null;
    this.doneSteps++;
    const res = this.results.get(step.item.id);
    if (step.view === 'tellapart') {
      const t = this.tell.get(step.item.id);
      t.rounds++;
      if (ok) {
        t.correct.add(step.target.id);
        t.streak++;
      } else t.streak = 0;
      const learnedApart = t.correct.size === t.group.length && t.streak >= t.group.length + 1;
      if (!learnedApart && t.rounds < MAX_TELL_ROUNDS) {
        this.steps.unshift({ item: step.item, view: 'tellapart' });
        this.totalSteps++;
      }
    } else if (!ok && DRILL_TESTS.includes(step.view)) {
      res.clean = false;
      res.misses++;
      const gap = GAPS[Math.min(res.misses, GAPS.length) - 1];
      this.steps.splice(Math.min(gap, this.steps.length), 0, { item: step.item, view: step.view });
      this.totalSteps++;
    }
    if (this.steps.some((s) => s.item.id === step.item.id)) return null;
    return { item: step.item, clean: res.clean };
  }
}
