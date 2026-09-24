// Memrise-style learning session: each new item is presented, then tested in
// several different views, interleaved with the other items in the batch.
// Items are introduced one at a time; a new item is only introduced once the
// items already on screen have had a couple of tests. A failed view is
// repeated later in the session.

export const LEARN_VIEWS = {
  char: ['present', 'mc-recognize', 'mc-recall', 'flip'],
  word: ['present', 'mc-recognize', 'mc-recall', 'flip'],
  cloze: ['present', 'mc-cloze', 'type-cloze'],
};

export class LearningSession {
  constructor(items) {
    this.items = items;
    this.entries = items.map((item) => ({
      item, pending: [...LEARN_VIEWS[item.kind]], progress: 0, mistakes: 0, introduced: false,
    }));
    this.nextNew = 0;
    this.last = null;
    this.current = null;
    this.totalViews = this.entries.reduce((n, e) => n + e.pending.length, 0);
    this.doneViews = 0;
  }

  get done() {
    return this.entries.every((e) => e.pending.length === 0);
  }

  // Returns { item, view } or null when finished.
  next() {
    if (this.done) return (this.current = null);
    const live = this.entries.filter((e) => e.introduced && e.pending.length);
    const others = live.filter((e) => e !== this.last);
    const canIntroduce = this.nextNew < this.entries.length;
    let entry;
    if (canIntroduce && (others.length === 0 || others.every((e) => e.progress >= 2))) {
      entry = this.entries[this.nextNew++];
      entry.introduced = true;
    } else if (others.length) {
      entry = others.reduce((a, b) => (b.progress < a.progress ? b : a));
    } else {
      entry = live[0];
    }
    this.last = entry;
    this.current = { item: entry.item, view: entry.pending[0], entry };
    return this.current;
  }

  // Mark the current view as passed (true) or failed (false).
  result(ok) {
    const cur = this.current;
    if (!cur) return;
    const e = cur.entry;
    const view = e.pending.shift();
    if (ok || view === 'present') {
      e.progress++;
      this.doneViews++;
    } else {
      e.mistakes++;
      e.pending.push(view); // try this view again later
      this.totalViews++;
    }
    this.current = null;
  }

  get progress() {
    return this.totalViews ? this.doneViews / this.totalViews : 1;
  }
}
