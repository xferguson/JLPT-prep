// Play mode: "play the next N cards". Due reviews and new items are mixed in
// one run so the habit is simply "N cards a day", whatever they turn out to be.
//
// Each step is one of:
//   review    - answer the most overdue card
//   learn     - the next learning view of a new item that is in progress
//   introduce - start teaching a new item (then its views follow as `learn`)
//   done      - target reached, or nothing due and no new items left today
//
// A review or a finished new item counts as one card played. New items are
// spread evenly through the due pile (one new item every due/newLeft reviews),
// and their learning views are interleaved with reviews, Memrise-style.
import { LearningSession } from './session.js';

export class PlaySession {
  constructor(target) {
    this.target = target;
    this.learn = new LearningSession();
    this.reviews = 0;
    this.again = 0;
    this.learned = 0;
    this.credited = 0;
    this.reviewsSinceNew = 0;
    this.lastWasReview = false;
    this.reason = null;
  }

  get played() {
    return this.reviews + this.learned;
  }

  /**
   * Decide the next step.
   * due:     number of cards due now
   * newItem: the next new item available (or null)
   * newLeft: new items left under today's limit (for spacing them out)
   */
  next({ due, newItem, newLeft }) {
    const inProgress = this.learn.entries.filter((e) => e.pending.length);
    const live = inProgress.length;
    const room = this.target - this.played - live; // cards we may still start
    // New items: one at a time while reviews are waiting; with nothing due, a
    // second one once the first has had a couple of views (Memrise-style).
    const spacing = newLeft > 0 ? Math.max(1, due / newLeft) : Infinity;
    const canAdd = newItem && room > 0
      && (live === 0 || (due === 0 && live < 2 && inProgress[0].progress >= 2));
    if (canAdd && (due === 0 || this.reviewsSinceNew >= spacing)) return { type: 'introduce', item: newItem };
    if (live && (due === 0 || room <= 0 || this.lastWasReview)) return { type: 'learn' };
    if (due > 0 && room > 0) return { type: 'review' };
    if (live) return { type: 'learn' };
    this.reason = this.played >= this.target ? 'target' : 'empty';
    return { type: 'done', reason: this.reason };
  }

  introduce(item) {
    this.learn.add(item);
    this.reviewsSinceNew = 0;
  }

  // Record a review answer (rating 1 = Again).
  reviewed(rating, credited = false) {
    this.reviews++;
    if (rating === 1) this.again++;
    if (credited) this.credited++;
    this.reviewsSinceNew++;
    this.lastWasReview = true;
  }

  // Record a learning view; returns the item if it is now learned.
  learnResult(ok) {
    this.lastWasReview = false;
    const done = this.learn.result(ok);
    if (done) this.learned++;
    return done;
  }

  get progress() {
    return Math.min(1, this.played / this.target);
  }
}
