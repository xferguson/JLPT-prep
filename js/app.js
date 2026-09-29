import {
  buildCourse, initialState, reconcile, stats, nextNewItems, completeLearning, dueCards,
  nextDueTime, review, reviewView, itemStatus, knownChars, DEFAULT_SETTINGS,
  difficultCards, markDifficult, graduateDifficult, recordDrill, recordConfusion, confusedWith, partnersOf,
  sentencesOf,
} from './engine.js';
import { DrillSession, DRILL_TESTS } from './drill.js';
import { preview, formatInterval, AGAIN, HARD, GOOD, EASY, DEFAULT_SRS } from './srs.js';
import { LearningSession } from './session.js';
import { PlaySession } from './play.js';
import {
  KINDS, KIND_NAMES, lastDays, snapshot, knownOverTime, reviewHistory, successRates, forecast, upcoming, hardest, daysOfHistory,
} from './analytics.js';
import { stackedBars, lineChart, hBars, bindCharts, hideTip, tableHtml, legendHtml } from './charts.js';
import { loadState, saveState, clearState, exportState, readImport, requestPersistence } from './store.js';
import { romajiToKana, normalizeAnswer, kataToHira } from './kana.js';
import {
  esc, kindLabel, formHtml, glossOf, stageLabel, isKanaChar, detailsHtml,
  sentenceHtml, choiceOptions, clozeOptions, statusBadge, speak, speechTextOf,
  diffHighlight, kanjiBreakdown,
} from './ui.js';

const LEVEL = 'N5';
const app = document.getElementById('app');
let course;
let state;
let keyHandler = null; // keyboard shortcuts for the current screen
let learn = null; // active LearningSession
let reviewRun = null; // { done, again, startedAt }
let play = null; // active PlaySession
let drill = null; // active DrillSession

// ------------------------------------------------------------------ boot

async function boot() {
  const base = `data/${LEVEL.toLowerCase()}/`;
  const files = ['characters', 'words', 'sentences', 'grammar', 'kana', 'meta'];
  const [characters, words, sentences, grammar, kana, meta] = await Promise.all(
    files.map((f) => fetch(`${base}${f}.json`).then((r) => {
      if (!r.ok) throw new Error(`${f}.json: ${r.status}`);
      return r.json();
    })),
  );
  course = buildCourse({ characters, words, sentences, grammar, kana, meta });
  state = loadState(LEVEL);
  state = state ? reconcile(course, state) : initialState(course);
  persist();
  requestPersistence();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  window.addEventListener('hashchange', () => route());
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select') && e.key !== 'Enter') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (keyHandler && keyHandler(e) !== false) { /* handled */ }
  });
  // Keep time-dependent screens current: cards become due while the app sits
  // open, and an installed PWA is resumed rather than reloaded.
  setInterval(() => refreshIfIdle(false), 30_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshIfIdle(true); });
  window.addEventListener('pageshow', (e) => { if (e.persisted) refreshIfIdle(true); });
  window.addEventListener('focus', () => refreshIfIdle(false));
  route();
}

function persist() {
  if (!saveState(state)) toast('Could not save progress — storage may be full.');
  updateBadge();
  scheduleDueWakeup();
}

function updateBadge() {
  const n = dueCards(state).length;
  const b = document.getElementById('due-badge');
  b.hidden = n === 0;
  b.textContent = n > 99 ? '99+' : n;
}

let toastTimer;
function toast(html, ms = 3500) {
  const t = document.getElementById('toast');
  t.innerHTML = html;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

let lastSignature = '';

// Screens that only display state (no card or form in progress) and can be
// redrawn at any time.
function idleScreen() {
  const tab = location.hash.replace(/^#\/?/, '').split('/')[0] || 'home';
  if (tab === 'home' || tab === 'stats') return tab;
  if (tab === 'review' && !app.querySelector('.card')) return tab;
  return null;
}

// What an idle screen shows that changes with time alone.
function screenSignature(tab) {
  const due = dueCards(state).length;
  const day = new Date().toDateString();
  return tab === 'stats' ? `${tab}|${due}|${day}` : `${tab}|${due}|${day}|${whenText(nextDueTime(state))}`;
}

// Wake up exactly when the next card comes due (the 30s ticker is a fallback).
let dueTimer;
function scheduleDueWakeup() {
  clearTimeout(dueTimer);
  const next = nextDueTime(state);
  if (!Number.isFinite(next)) return;
  const wait = next - Date.now();
  // wake when it comes due, or when "in N minutes" would drop under a minute
  const until = wait > 60_000 ? Math.min(wait - 60_000, 30_000) : wait;
  if (until > 0) dueTimer = setTimeout(() => refreshIfIdle(false), until + 250);
}

function refreshIfIdle(resumed) {
  updateBadge();
  scheduleDueWakeup();
  const tab = idleScreen();
  if (!tab) return;
  if (resumed) {
    // pick up progress saved by another tab/window while we were away
    const saved = loadState(LEVEL);
    if (saved) state = reconcile(course, saved);
  }
  const sig = screenSignature(tab);
  if (!resumed && sig === lastSignature) return;
  route({ keepScroll: true });
}

function route({ keepScroll = false } = {}) {
  keyHandler = null;
  hideTip();
  const hash = location.hash.replace(/^#\/?/, '');
  const [page, arg] = hash.split('/');
  const tab = page || 'home';
  document.querySelectorAll('.tabbar a').forEach((a) => {
    const active = a.dataset.tab === ({ item: 'browse', play: 'home', difficult: 'review', drill: 'review' }[tab] || tab);
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  if (tab !== 'learn') learn = null;
  if (tab !== 'review') reviewRun = null;
  if (tab !== 'play') play = null;
  if (tab !== 'drill') drill = null;
  if (!keepScroll) window.scrollTo(0, 0);
  if (['home', 'stats', 'review'].includes(tab)) setTimeout(() => { lastSignature = idleScreen() ? screenSignature(tab) : ''; });
  switch (tab) {
    case 'learn': return renderLearn();
    case 'review': return renderReview();
    case 'play': return renderPlay(arg);
    case 'difficult': return renderDifficult();
    case 'drill': return renderDrill(arg ? decodeURIComponent(arg) : null);
    case 'browse': return renderBrowse(arg || 'characters');
    case 'item': return renderItem(decodeURIComponent(arg || ''));
    case 'settings': return renderSettings();
    case 'stats': return renderStats(arg);
    default: return renderHome();
  }
}

function render(html) {
  app.innerHTML = html;
}

const on = (sel, ev, fn) => app.querySelectorAll(sel).forEach((el) => el.addEventListener(ev, fn));

// ------------------------------------------------------------------ home

function bar(parts, total) {
  return `<div class="bar" role="img" aria-label="${parts.map((p) => `${p.n} ${p.label}`).join(', ')} of ${total}">${parts
    .map((p) => `<span class="seg seg-${p.cls}" style="width:${total ? (p.n / total) * 100 : 0}%"></span>`).join('')}</div>`;
}

function whenText(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = ms - Date.now();
  if (d <= 0) return 'now';
  if (d < 60_000) return 'in under a minute';
  return `in ${formatInterval(d)}`;
}

function renderHome() {
  const s = stats(course, state);
  const kanji = course.characters;
  const known = (list) => list.filter((c) => state.cards[c.id]?.passedFinal).length;
  const nextItems = state.queue.slice(0, 12).map((id) => course.items.get(id));
  const nd = nextDueTime(state);
  const lockedWords = s.word.total - s.word.known - s.word.learning - s.word.queued;
  const legend = (arr) => `<div class="legend">${arr.map(([cls, label, n]) => `<span><i class="dot seg-${cls}"></i>${label} ${n}</span>`).join('')}</div>`;

  render(`
    <section class="stat-cards">
      <a class="stat ${s.due ? 'stat-hot' : ''}" href="#/review"><b>${s.due}</b><span>due now</span></a>
      <a class="stat" href="#/learn"><b>${s.newLeftToday}</b><span>new left today</span></a>
      <div class="stat"><b>${s.playedToday}</b><span>cards today</span></div>
    </section>
    <section class="panel play-panel">
      <div class="play-head"><h2>Play</h2><span class="muted small">reviews + new items, mixed${s.streak ? ` · ${s.streak}-day streak` : ''}</span></div>
      <div class="play-buttons">${[...new Set([10, state.settings.playSize, 50])].sort((a, b) => a - b)
    .map((n) => `<a class="btn ${n === state.settings.playSize ? 'btn-primary' : ''}" href="#/play/${n}">Play ${n}</a>`).join('')}</div>
    </section>
    ${s.difficult ? `<a class="difficult-banner" href="#/difficult"><b>${s.difficult}</b> Difficult word${s.difficult === 1 ? '' : 's'} waiting for a drill <span aria-hidden="true">→</span></a>` : ''}
    <section class="actions">
      <a class="btn ${s.due ? 'btn-primary' : 'btn-muted'}" href="#/review">${s.due ? `Review ${s.due}` : `No reviews due${nd < Infinity ? ` · next ${whenText(nd)}` : ''}`}</a>
      <a class="btn ${s.due ? '' : 'btn-primary'}" href="#/learn">Learn new</a>
    </section>

    <section class="panel">
      <h2>Progress</h2>
      <div class="progress-row"><div class="progress-head"><span>Kanji</span><span>${known(kanji)} / ${kanji.length}</span></div>
        ${bar([{ n: known(kanji), cls: 'known', label: 'known' }], kanji.length)}</div>
      <div class="progress-row"><div class="progress-head"><span>Words &amp; phrases</span><span>${s.word.known} / ${s.word.total}</span></div>
        ${bar([{ n: s.word.known, cls: 'known', label: 'known' }, { n: s.word.learning, cls: 'learning', label: 'learning' }, { n: s.word.queued, cls: 'queued', label: 'queued' }], s.word.total)}
        ${legend([['known', 'Known', s.word.known], ['learning', 'Learning', s.word.learning], ['queued', 'Unlocked', s.word.queued], ['locked', 'Locked', lockedWords]])}</div>
      <div class="progress-row"><div class="progress-head"><span>Sentences</span><span>${s.cloze.known} / ${s.cloze.total}</span></div>
        ${bar([{ n: s.cloze.known, cls: 'known', label: 'known' }, { n: s.cloze.learning, cls: 'learning', label: 'learning' }, { n: s.cloze.queued, cls: 'queued', label: 'queued' }], s.cloze.total)}</div>
      <p class="muted small">Today: ${s.playedToday} cards played (${s.reviewsToday} reviews · ${s.learnedToday} learned) · <a href="#/stats">Detailed stats →</a></p>
    </section>

    <section class="panel">
      <h2>Up next</h2>
      ${nextItems.length ? `<div class="chips">${nextItems.map((it) => chip(it)).join('')}</div>` : '<p class="muted">Nothing queued — keep reviewing to unlock more.</p>'}
      <p class="muted small">${state.queue.length} items in the to-be-learned queue.</p>
    </section>

    <details class="panel how">
      <summary>How it works</summary>
      <ol>
        <li><b>Kanji and kana words, by frequency.</b> The queue starts with the N5 kanji and every word that needs no N5 kanji, interleaved from most to least common. Kana are learned through words.</li>
        <li><b>Learn</b> sessions teach ${state.settings.batchSize} items at a time with several different views (presentation, multiple choice both ways, flashcard). Each item is saved as soon as it has passed its views, so you can stop any time.</li>
        <li><b>Play</b> runs the next N cards — due reviews first, with new items spread through them — so the daily habit is just "N cards".</li>
        <li><b>Review</b> shows each card once, Anki-style: recall it, reveal, and rate yourself <i>Again / Hard / Good / Easy</i>.</li>
        <li>Each successful review moves a card to the next form: <b>romaji → kana → kanji</b>, each tested against the English meaning.</li>
        <li>When a kanji passes its first review in kanji form, every word you can now read jumps to the front of the queue, most frequent first.</li>
        <li>When a word passes its first kanji (or kana) review, its first N5-level practice sentence is queued as a <b>cloze</b> card; each further sentence for that word unlocks when the previous one passes a review. Sentences wait behind kanji and words.</li>
        <li>Typing a word correctly in a sentence also counts as a review of that word, pushing its next review out.</li>
      </ol>
    </details>
  `);
}

function chip(item) {
  const label = item.kind === 'char' ? item.char : item.kind === 'word' ? (item.stages.includes('kanji') ? item.written : item.kana) : item.answer;
  return `<a class="chip chip-${item.kind} ${item.kind === 'char' ? `chip-${item.type}` : ''}" href="#/item/${encodeURIComponent(item.id)}" lang="ja" title="${esc(kindLabel(item))}">${esc(label)}${item.kind === 'cloze' ? ' <small>文</small>' : ''}</a>`;
}

// ------------------------------------------------------------------ learning session

function renderLearn(ignoreLimit = false) {
  if (!learn) {
    const items = nextNewItems(course, state, Date.now(), { ignoreLimit });
    if (!items.length) {
      const s = stats(course, state);
      const limitHit = s.newLeftToday === 0 && state.queue.length > 0;
      render(`<section class="panel center">
        <h2>${limitHit ? 'Daily new-item goal reached' : 'Nothing new to learn right now'}</h2>
        <p class="muted">${limitHit
    ? `You've learned ${state.settings.newPerDay} new items today. Reviews keep them fresh.`
    : 'New words unlock when their characters pass a review, and sentences unlock when words do. Do your reviews to unlock more.'}</p>
        <div class="actions">
          ${s.due ? `<a class="btn btn-primary" href="#/review">Review ${s.due}</a>` : ''}
          ${limitHit ? '<button class="btn" id="more">Learn more anyway</button>' : ''}
        </div></section>`);
      on('#more', 'click', () => renderLearn(true));
      return;
    }
    learn = new LearningSession(items);
  }
  const cur = learn.next();
  if (!cur) return finishLearning();
  const head = `<div class="session-head">
      <span class="pill pill-${cur.item.kind}">${esc(kindLabel(cur.item))}</span>
      <div class="bar thin"><span class="seg seg-known" style="width:${Math.round(learn.progress * 100)}%"></span></div>
      <a class="close" href="#/" aria-label="End session">✕</a>
    </div>`;
  return showLearnView(head, cur);
}

function showLearnView(head, { item, view }) {
  if (view === 'present') return presentView(head, item);
  if (view === 'mc-recognize' || view === 'mc-recall') return mcView(head, item, view === 'mc-recognize' ? 'recognize' : 'recall');
  if (view === 'flip') return flipLearnView(head, item);
  if (view === 'mc-cloze') return clozeView(head, item, 'mc', (ok) => nextLearn(ok));
  if (view === 'type-cloze') return clozeView(head, item, 'type', (ok) => nextLearn(ok));
  return null;
}

// Save an item the moment it has passed all its learning views, so leaving a
// session early keeps everything finished so far.
function saveLearned(item) {
  if (!item || state.cards[item.id]) return;
  completeLearning(course, state, [item.id], Date.now());
  persist();
}

function nextLearn(ok) {
  if (play) return playLearnResult(ok);
  saveLearned(learn.result(ok));
  renderLearn();
}

function finishLearning() {
  const items = learn.finished;
  const mistakes = learn.entries.reduce((n, e) => n + e.mistakes, 0);
  const first = state.settings.learningSteps[0];
  render(`<section class="panel center">
    <h2>Learned ${items.length} new item${items.length === 1 ? '' : 's'}</h2>
    <div class="chips center">${items.map(chip).join('')}</div>
    <p class="muted">${mistakes ? `${mistakes} slip${mistakes === 1 ? '' : 's'} along the way. ` : 'Flawless! '}First review in ${formatInterval(first * 60000)}.</p>
    <div class="actions"><button class="btn btn-primary" id="again">Learn more</button><a class="btn" href="#/">Home</a></div>
  </section>`);
  learn = null;
  on('#again', 'click', () => renderLearn());
  keyHandler = (e) => { if (e.key === 'Enter') renderLearn(); };
}

function audioBtn(item) {
  return `<button class="icon-btn audio" data-say="${esc(speechTextOf(item, course))}" aria-label="Play audio" title="Play audio">🔊</button>`;
}

function bindAudio() {
  on('[data-say]', 'click', (e) => speak(e.currentTarget.dataset.say));
}

function maybeAutoplay(item) {
  if (state.settings.autoplayAudio) speak(speechTextOf(item, course));
}

function heroOf(item) {
  if (item.kind === 'char') return `<div class="hero-char jp" lang="ja">${esc(item.char)}</div>`;
  if (item.stages.includes('kanji')) {
    return `<div class="hero-word jp" lang="ja"><ruby>${esc(item.written)}<rt>${esc(item.kana)}</rt></ruby></div>`;
  }
  return `<div class="hero-word jp" lang="ja">${esc(item.kana)}</div>`;
}

function stagesStrip(item, current = -1) {
  if (item.stages.length < 2) return '';
  return `<div class="stages" aria-label="Review stages">${item.stages.map((s, i) => `<span class="stage ${i === current ? 'on' : ''} ${i < current ? 'done' : ''}">${esc(stageLabel(item, s))}</span>`).join('<span class="arrow">→</span>')}</div>`;
}

function presentView(head, item) {
  if (item.kind === 'cloze') {
    const s = course.sentenceById.get(item.sentenceId);
    const word = course.items.get(item.wordId);
    render(`${head}<section class="card">
      <p class="eyebrow">New sentence</p>
      ${sentenceHtml(s, { span: item.span, mode: 'highlight', furigana: state.settings.furigana ? 'all' : 'off' })}
      <p class="translation">${esc(s.en)}</p>
      <div class="word-ref"><span class="jp" lang="ja">${esc(item.answer)}</span> ← <a href="#/item/${word.id}" class="jp" lang="ja">${esc(word.display)}</a> <span class="muted">${esc(word.meaning)}</span></div>
      ${grammarTags(s)}
      <div class="card-actions">${audioBtn(item)}<button class="btn btn-primary" id="go">Continue</button></div>
    </section>`);
  } else {
    render(`${head}<section class="card">
      <p class="eyebrow">New ${esc(kindLabel(item).toLowerCase())}</p>
      ${heroOf(item)}
      ${detailsHtml(item)}
      ${stagesStrip(item)}
      <div class="card-actions">${audioBtn(item)}<button class="btn btn-primary" id="go">Continue</button></div>
    </section>`);
  }
  bindAudio();
  maybeAutoplay(item);
  const go = () => nextLearn(true);
  on('#go', 'click', go);
  app.querySelector('#go').focus();
  keyHandler = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
}

function grammarTags(sentence) {
  const tags = (sentence.g || []).map((id) => course.grammarById.get(id)).filter(Boolean)
    .filter((g) => !['wa', 'ga', 'wo', 'ni', 'no', 'desu', 'masu'].includes(g.id)); // skip the ubiquitous ones
  if (!tags.length) return '';
  return `<div class="grammar-tags">${tags.slice(0, 4).map((g) => `<a class="gtag" href="#/browse/grammar" title="${esc(g.meaning)}" lang="ja">${esc(g.pattern)}</a>`).join('')}</div>`;
}

// Multiple choice. direction: recognize (form -> gloss) | recall (gloss -> form)
// A wrong pick is recorded as a mix-up between the two words.
function mcView(head, item, direction, { stage = item.stages[0], prefer = [], done = nextLearn } = {}) {
  const { correct, options, idOf } = choiceOptions(course, item, stage, direction, { prefer });
  const promptHtml = direction === 'recognize'
    ? `<div class="prompt">${formHtml(item, stage, 'big')}</div><p class="question">${isKanaChar(item) ? 'Which romaji is this?' : 'What does this mean?'}</p>`
    : `<div class="prompt"><span class="gloss big">${esc(glossOf(item))}</span></div><p class="question">Pick the ${esc(stageLabel(item, stage).toLowerCase())}</p>`;
  const optJp = direction === 'recall' && (stage !== 'romaji');
  render(`${head}<section class="card">
    ${promptHtml}
    <div class="options">${options.map((o, i) => `<button class="option ${optJp ? 'jp' : ''}" ${optJp ? 'lang="ja"' : ''} data-v="${esc(o)}"><kbd>${i + 1}</kbd>${esc(o)}</button>`).join('')}</div>
    <div id="feedback"></div>
  </section>`);
  let answered = false;
  const choose = (btn) => {
    if (answered) return;
    answered = true;
    const ok = btn.dataset.v === correct;
    app.querySelectorAll('.option').forEach((b) => {
      b.disabled = true;
      if (b.dataset.v === correct) b.classList.add('correct');
    });
    if (!ok) {
      btn.classList.add('wrong');
      noteConfusion(item.id, idOf[btn.dataset.v]);
    }
    maybeAutoplay(item);
    const fb = app.querySelector('#feedback');
    fb.innerHTML = `${ok ? '' : `<div class="details-wrap">${detailsHtml(item, { highlightStage: stage })}</div>`}
      <div class="card-actions">${audioBtn(item)}<button class="btn btn-primary" id="go">Continue</button></div>`;
    bindAudio();
    const go = () => done(ok);
    on('#go', 'click', go);
    app.querySelector('#go').focus();
    keyHandler = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
    if (ok) setTimeout(() => { if (app.contains(fb) && app.querySelector('#go')) go(); }, 700);
  };
  on('.option', 'click', (e) => choose(e.currentTarget));
  keyHandler = (e) => {
    const n = Number(e.key);
    const btns = app.querySelectorAll('.option');
    if (n >= 1 && n <= btns.length) choose(btns[n - 1]);
  };
}

// Flashcard inside a learning session: recall the form, reveal, self-rate.
function flipLearnView(head, item) {
  const stage = item.stages[0];
  flashcard(head, item, stage, 'recall', {
    ratingsHtml: () => ratingButtons(null),
    onRate: (r) => nextLearn(r !== AGAIN),
  });
}

// ------------------------------------------------------------------ flashcards (shared)

function ratingButtons(card) {
  const pv = card ? preview(card, Date.now(), srsCfg()) : null;
  const btn = (r, label, cls) => `<button class="rate ${cls}" data-r="${r}"><kbd>${r}</kbd>${label}${pv ? `<small>${formatInterval(pv[r])}</small>` : ''}</button>`;
  return `<div class="ratings">${btn(AGAIN, 'Again', 'r-again')}${btn(HARD, 'Hard', 'r-hard')}${btn(GOOD, 'Good', 'r-good')}${btn(EASY, 'Easy', 'r-easy')}</div>`;
}

function srsCfg() {
  return { ...DEFAULT_SRS, learningSteps: state.settings.learningSteps, relearningSteps: state.settings.relearningSteps };
}

function flashcard(head, item, stage, direction, { ratingsHtml, onRate, badge = '' }) {
  const label = stageLabel(item, stage);
  const front = direction === 'recognize'
    ? `<p class="question">${isKanaChar(item) ? 'Say the romaji' : 'What does it mean?'}</p><div class="prompt">${formHtml(item, stage, 'big')}</div>`
    : `<p class="question">Recall the <b>${esc(label.toLowerCase())}</b>${isKanaChar(item) ? '' : ' for'}</p><div class="prompt"><span class="gloss big">${esc(glossOf(item))}</span></div>`;
  const back = direction === 'recognize'
    ? `<div class="answer"><span class="gloss">${esc(glossOf(item))}</span></div>`
    : `<div class="answer">${formHtml(item, stage, 'big')}</div>`;
  render(`${head}<section class="card flashcard">
    <div class="card-meta"><span class="pill">${esc(label)}</span>${badge}</div>
    ${front}
    <div id="back" hidden>${back}<div class="details-wrap">${detailsHtml(item, { highlightStage: stage })}</div>${noteHtml(item.id)}</div>
    <div id="controls" class="card-actions"><button class="btn btn-primary" id="show">Show answer <kbd>space</kbd></button></div>
  </section>`);
  const reveal = () => {
    app.querySelector('#back').hidden = false;
    app.querySelector('#controls').innerHTML = `${audioBtn(item)}${ratingsHtml()}`;
    bindAudio();
    maybeAutoplay(item);
    on('.rate', 'click', (e) => onRate(Number(e.currentTarget.dataset.r)));
    keyHandler = (e) => {
      const n = Number(e.key);
      if (n >= 1 && n <= 4) onRate(n);
      else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onRate(GOOD); }
    };
  };
  on('#show', 'click', reveal);
  keyHandler = (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); reveal(); } };
}

// ------------------------------------------------------------------ cloze (learn + review)

function clozeView(head, item, mode, done, { card = null } = {}) {
  const s = course.sentenceById.get(item.sentenceId);
  const word = course.items.get(item.wordId);
  const known = knownChars(course, state);
  const furigana = state.settings.furigana ? 'unknown' : 'off';
  const hint = `<p class="translation">${esc(s.en)}</p>`;
  const opts = mode === 'mc' ? clozeOptions(course, item, { prefer: partnersOf(course, state, item.wordId, { learnedOnly: false }) }) : null;
  render(`${head}<section class="card cloze">
    <p class="eyebrow">Fill in the blank</p>
    ${sentenceHtml(s, { span: item.span, mode: 'blank', furigana, known })}
    ${hint}
    ${mode === 'mc'
    ? `<div class="options">${opts.options.map((o, i) => `<button class="option jp" lang="ja" data-v="${esc(o)}"><kbd>${i + 1}</kbd>${esc(o)}</button>`).join('')}</div>`
    : `<form id="typeform" class="type-answer" autocomplete="off">
        <input id="typed" type="text" inputmode="text" lang="ja" placeholder="type in kana or romaji" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Answer">
        <span id="kana-preview" class="kana-preview jp" lang="ja"></span>
        <button class="btn btn-primary" type="submit">Check</button>
        <button class="btn btn-link" type="button" id="dunno">I don't know</button>
      </form>`}
    <div id="feedback"></div>
  </section>`);
  let answered = false;
  const accept = new Set([normalizeAnswer(item.answer), kataToHira(item.reading)]);
  const finish = (ok, given) => {
    if (answered) return;
    answered = true;
    if (!ok && given) {
      // picked or typed another word: that's a mix-up worth remembering
      if (mode === 'mc') noteConfusion(item.id, opts.idOf[given]);
      else for (const other of wordsReadAs(given)) noteConfusion(item.id, other);
    }
    if (mode === 'mc') {
      app.querySelectorAll('.option').forEach((b) => {
        b.disabled = true;
        if (b.dataset.v === item.answer) b.classList.add('correct');
        else if (b.dataset.v === given) b.classList.add('wrong');
      });
    } else {
      const input = app.querySelector('#typed');
      input.disabled = true;
      input.classList.add(ok ? 'correct' : 'wrong');
      app.querySelectorAll('#typeform button').forEach((b) => { b.hidden = true; });
    }
    const fb = app.querySelector('#feedback');
    fb.innerHTML = `<div class="reveal">
        <div class="verdict ${ok ? 'ok' : 'bad'}">${ok ? '✓ Correct' : '✗ Not quite'}</div>
        ${sentenceHtml(s, { span: item.span, mode: 'highlight', furigana: state.settings.furigana ? 'all' : 'off' })}
        <div class="word-ref"><span class="jp" lang="ja">${esc(item.answer)}</span> (<span class="jp" lang="ja">${esc(item.reading)}</span>) ← <a href="#/item/${word.id}" class="jp" lang="ja">${esc(word.display)}</a> <span class="muted">${esc(word.meaning)}</span></div>
        ${grammarTags(s)}
      </div>
      <div class="card-actions" id="after">${audioBtn(item)}</div>`;
    bindAudio();
    maybeAutoplay(item);
    const after = app.querySelector('#after');
    if (!card) {
      // learning session
      after.insertAdjacentHTML('beforeend', '<button class="btn btn-primary" id="go">Continue</button>');
      const go = () => done(ok);
      on('#go', 'click', go);
      app.querySelector('#go').focus();
      keyHandler = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
      return;
    }
    // review: Anki-style rating, suggested by the result
    const showRatings = (passed) => {
      after.querySelectorAll('.ratings, .override').forEach((n) => n.remove());
      after.insertAdjacentHTML('beforeend', ratingButtons(card));
      after.querySelectorAll('.rate').forEach((b) => {
        const r = Number(b.dataset.r);
        if (passed ? r === AGAIN : r !== AGAIN) b.classList.add('dim');
      });
      if (!passed) after.insertAdjacentHTML('beforeend', '<button class="btn btn-link override" id="override">I was right</button>');
      after.querySelectorAll('.rate').forEach((b) => b.addEventListener('click', () => done(Number(b.dataset.r))));
      after.querySelector('#override')?.addEventListener('click', () => showRatings(true));
      keyHandler = (e) => {
        const n = Number(e.key);
        if (n >= 1 && n <= 4) done(n);
        else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); done(passed ? GOOD : AGAIN); }
      };
    };
    showRatings(ok);
  };
  if (mode === 'mc') {
    on('.option', 'click', (e) => finish(e.currentTarget.dataset.v === item.answer, e.currentTarget.dataset.v));
    keyHandler = (e) => {
      const n = Number(e.key);
      const btns = app.querySelectorAll('.option');
      if (n >= 1 && n <= btns.length) btns[n - 1].click();
    };
  } else {
    const input = app.querySelector('#typed');
    const pv = app.querySelector('#kana-preview');
    input.addEventListener('input', () => {
      pv.textContent = /[a-z]/i.test(input.value) ? romajiToKana(input.value) : '';
    });
    app.querySelector('#typeform').addEventListener('submit', (e) => {
      e.preventDefault();
      if (!input.value.trim()) return;
      finish(accept.has(normalizeAnswer(input.value)), input.value);
    });
    on('#dunno', 'click', () => finish(false, ''));
    input.focus();
    keyHandler = null;
  }
}

// ------------------------------------------------------------------ reviews

function renderReview() {
  if (!reviewRun) reviewRun = { done: 0, again: 0 };
  const due = dueCards(state);
  if (!due.length) {
    const nd = nextDueTime(state);
    render(`<section class="panel center">
      <h2>${reviewRun.done ? `Reviewed ${reviewRun.done} card${reviewRun.done === 1 ? '' : 's'}` : 'All caught up'}</h2>
      ${reviewRun.done ? `<p class="muted">${Math.round(((reviewRun.done - reviewRun.again) / reviewRun.done) * 100)}% remembered.</p>` : ''}
      <p class="muted">${nd < Infinity ? `Next review ${whenText(nd)}.` : 'Learn some items to start reviewing.'}</p>
      <div class="actions"><a class="btn btn-primary" href="#/learn">Learn new</a><a class="btn" href="#/">Home</a></div>
    </section>`);
    keyHandler = null;
    updateBadge();
    return;
  }
  const card = due[0];
  const item = course.items.get(card.id);
  const head = `<div class="session-head">
      <span class="pill pill-${item.kind}">${esc(kindLabel(item))}</span>
      <span class="muted small">${due.length} due · ${reviewRun.done} done</span>
      <a class="close" href="#/" aria-label="End reviews">✕</a>
    </div>`;
  showReviewCard(card, head, (rating) => {
    reviewRun.done++;
    if (rating === AGAIN) reviewRun.again++;
    renderReview();
  });
}

// One review, in whichever view the card is due for. Records the answer, then
// calls after(rating, result).
function showReviewCard(card, head, after) {
  const item = course.items.get(card.id);
  const view = reviewView(course, state, card);
  const rate = (rating) => {
    const res = review(course, state, card.id, rating, Date.now(), { typed: view.mode === 'type' });
    persist();
    announce(item, res);
    after(rating, res);
  };
  if (item.kind === 'cloze') {
    clozeView(head, item, view.mode, rate, { card });
    return;
  }
  const badge = card.newStage ? '<span class="pill pill-new">New form</span>' : '';
  flashcard(head + stagesStrip(item, card.stage), item, view.stage, view.direction, {
    ratingsHtml: () => ratingButtons(card),
    onRate: rate,
    badge,
  });
}

function announce(item, res) {
  const msgs = [];
  if (res.stageAdvanced) {
    const next = item.stages[res.card.stage];
    msgs.push(`<b lang="ja">${esc(item.char || item.display)}</b> levelled up — next time: ${esc(stageLabel(item, next))}`);
  }
  if (res.unlocked.length) {
    const unlockedItems = res.unlocked.map((id) => course.items.get(id));
    if (item.kind === 'char') {
      const shown = unlockedItems.slice(0, 5).map((w) => esc(w.display)).join('、');
      msgs.push(`<b lang="ja">${esc(item.char)}</b> learned! Unlocked ${res.unlocked.length} word${res.unlocked.length === 1 ? '' : 's'}: <span lang="ja">${shown}${res.unlocked.length > 5 ? '…' : ''}</span>`);
    } else {
      const word = course.items.get(item.kind === 'cloze' ? item.wordId : item.id);
      msgs.push(`Next practice sentence for <b lang="ja">${esc(word.display)}</b> added to your queue`);
    }
  } else if (res.passedFinalFirst && item.kind === 'char') {
    msgs.push(`<b lang="ja">${esc(item.char)}</b> learned!`);
  }
  if (res.flagged) {
    const f = course.items.get(res.flagged);
    msgs.push(`Marked <b lang="ja">${esc(f.char || f.display)}</b> Difficult — moved to your <a href="#/difficult">Difficult drill</a>`);
  }
  if (res.credited) {
    const word = course.items.get(res.credited.wordId);
    msgs.push(`Typed it — counts as a review of <b lang="ja">${esc(word.display)}</b> too (next ${whenText(res.credited.due)})`);
  }
  if (msgs.length) toast(msgs.join('<br>'));
}

// ------------------------------------------------------------------ play (mixed reviews + new)

function renderPlay(arg) {
  if (!play) {
    const n = Math.max(1, Math.min(500, parseInt(arg, 10) || state.settings.playSize));
    play = new PlaySession(n);
  }
  playStep();
}

function playHead(item) {
  return `<div class="session-head">
      <span class="pill pill-${item.kind}">${esc(kindLabel(item))}</span>
      <div class="bar thin" aria-label="${play.played} of ${play.target} cards"><span class="seg seg-known" style="width:${Math.round(play.progress * 100)}%"></span></div>
      <span class="muted small play-count">${play.played}/${play.target}</span>
      <a class="close" href="#/" aria-label="End play">✕</a>
    </div>`;
}

function playStep() {
  const now = Date.now();
  const due = dueCards(state, now);
  const inPlay = new Set(play.learn.items.map((i) => i.id));
  const live = play.learn.inProgress.length;
  const newLeft = play.extraNew ? Infinity : stats(course, state, now).newLeftToday - live;
  const newItem = newLeft > 0
    ? nextNewItems(course, state, now, { ignoreLimit: true, limit: live + 3 }).find((i) => !inPlay.has(i.id)) || null
    : null;
  const step = play.next({ due: due.length, newItem, newLeft: Number.isFinite(newLeft) ? newLeft : 1e9 });
  if (step.type === 'introduce') {
    play.introduce(step.item);
    return playStep();
  }
  if (step.type === 'learn') {
    const cur = play.learn.next();
    return showLearnView(playHead(cur.item), cur);
  }
  if (step.type === 'review') {
    const card = due[0];
    return showReviewCard(card, playHead(course.items.get(card.id)), (rating, res) => {
      play.reviewed(rating, !!res.credited);
      playStep();
    });
  }
  return finishPlay();
}

function playLearnResult(ok) {
  saveLearned(play.learnResult(ok));
  playStep();
}

function finishPlay() {
  const p = play;
  const s = stats(course, state);
  const limitHit = p.reason === 'empty' && s.newLeftToday === 0 && state.queue.length > 0 && !p.extraNew;
  const rate = p.reviews ? Math.round(((p.reviews - p.again) / p.reviews) * 100) : null;
  render(`<section class="panel center">
    <h2>${p.reason === 'target' ? `Played ${p.played} card${p.played === 1 ? '' : 's'}` : p.played ? `Played ${p.played} — that's everything for now` : 'Nothing to play right now'}</h2>
    <p class="muted">${p.reviews} review${p.reviews === 1 ? '' : 's'}${rate != null ? ` (${rate}% remembered)` : ''} · ${p.learned} new learned${p.credited ? ` · ${p.credited} word review${p.credited === 1 ? '' : 's'} earned by typing` : ''}</p>
    <p class="muted small">Today so far: ${s.playedToday} cards played (${s.reviewsToday} reviews · ${s.learnedToday} learned).</p>
    ${limitHit ? `<p class="muted small">No reviews are due and you've reached today's ${state.settings.newPerDay} new items.</p>` : ''}
    ${p.reason === 'empty' && !limitHit && p.played === 0 ? `<p class="muted small">Next review ${whenText(nextDueTime(state))}.</p>` : ''}
    <div class="actions">
      ${p.reason === 'target' ? `<a class="btn btn-primary" href="#/play/${p.target}" id="again">Play ${p.target} more</a>` : ''}
      ${limitHit ? `<button class="btn btn-primary" id="extra">Keep going with new items</button>` : ''}
      <a class="btn" href="#/">Home</a>
    </div>
  </section>`);
  // the Play-more link keeps the same hash, so start the next run by hand
  on('#again', 'click', (e) => { e.preventDefault(); play = null; renderPlay(String(p.target)); });
  on('#extra', 'click', () => { play = new PlaySession(p.target); play.extraNew = true; playStep(); });
  keyHandler = (e) => { if (e.key === 'Enter') app.querySelector('#again, #extra')?.click(); };
  updateBadge();
}

// ------------------------------------------------------------------ Difficult words & mix-ups

function noteConfusion(a, b) {
  if (b && recordConfusion(course, state, a, b)) persist();
}

// Words whose kana (or written form) is exactly this answer.
let readingIndex;
function wordsReadAs(text) {
  if (!readingIndex) {
    readingIndex = new Map();
    for (const w of course.words) {
      for (const f of [w.kana, w.written]) {
        const k = normalizeAnswer(f);
        if (!readingIndex.has(k)) readingIndex.set(k, new Set());
        readingIndex.get(k).add(w.id);
      }
    }
  }
  return [...(readingIndex.get(normalizeAnswer(text)) || [])];
}

function noteHtml(id) {
  const note = state.notes?.[id];
  return note ? `<div class="note"><span class="detail-label">Your note</span><p>${esc(note)}</p></div>` : '';
}

function noteEditor(id) {
  return `<label class="note-edit"><span class="detail-label">Your note / mnemonic</span>
    <textarea id="note" rows="2" placeholder="e.g. はし with a high start = chopsticks…">${esc(state.notes?.[id] || '')}</textarea></label>`;
}

function bindNoteEditor(id) {
  const ta = app.querySelector('#note');
  if (!ta) return;
  let t;
  ta.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      state.notes ||= {};
      if (ta.value.trim()) state.notes[id] = ta.value.trim();
      else delete state.notes[id];
      persist();
    }, 400);
  });
}

function hasJapaneseVoice() {
  try {
    return 'speechSynthesis' in window && speechSynthesis.getVoices().some((v) => v.lang?.toLowerCase().startsWith('ja'));
  } catch {
    return false;
  }
}

const itemLabelOf = (it) => (it.kind === 'char' ? it.char : it.kind === 'word' ? it.display : it.answer);

function mixupChips(id) {
  const list = confusedWith(state, id).slice(0, 4);
  if (!list.length) return '';
  return `<div class="chips">${list.map(({ id: other, n }) => `<a class="chip chip-word" lang="ja" href="#/item/${encodeURIComponent(other)}">${esc(itemLabelOf(course.items.get(other)))} <small>×${n}</small></a>`).join('')}</div>`;
}

function renderDifficult() {
  const cards = difficultCards(state);
  render(`<h1 class="page-title">Difficult</h1>
    <section class="panel">
      <p class="muted small">A word or kanji you answer <b>Again</b> twice in a row (or a sentence you miss twice in a row) lands here and leaves your normal reviews.
      The drill re-teaches it, tests it four ways, and works through any words you mix it up with. Pass every test without a miss and it goes back to normal reviews, due in 1 day.</p>
      ${cards.length ? `<div class="actions"><a class="btn btn-primary" href="#/drill">Start drill (${Math.min(10, cards.length)})</a></div>` : ''}
    </section>
    ${cards.length ? `<section class="panel"><ul class="list difficult-list">${cards.map((c) => {
    const it = course.items.get(c.id);
    const mix = confusedWith(state, c.id);
    return `<li><a href="#/item/${encodeURIComponent(c.id)}">
        <span class="w-jp jp" lang="ja">${esc(itemLabelOf(it))}${it.kind === 'word' && it.written !== it.kana ? `<small>${esc(it.kana)}</small>` : ''}</span>
        <span class="w-en">${esc(glossOf(it))}<br><small class="muted">${c.lapses} lapse${c.lapses === 1 ? '' : 's'}${mix.length ? ` · mixed up with <span lang="ja">${mix.slice(0, 3).map((m) => esc(itemLabelOf(course.items.get(m.id)))).join('、')}</span>` : ''}</small></span></a></li>`;
  }).join('')}</ul></section>`
    : '<section class="panel center"><p class="muted">No difficult words right now. 🎉</p><a class="btn" href="#/">Home</a></section>'}`);
}

// arg: null (drill up to 10 Difficult items) or "group:<id>" (tell-apart only)
function renderDrill(arg) {
  if (!drill) {
    const groupId = arg?.startsWith('group:') ? arg.slice(6) : null;
    const items = groupId ? [course.items.get(groupId)].filter(Boolean)
      : difficultCards(state).slice(0, 10).map((c) => course.items.get(c.id));
    if (!items.length) {
      location.hash = '#/difficult';
      return;
    }
    const partners = new Map();
    for (const it of items) {
      const ids = groupId ? partnersOf(course, state, it.id, { limit: 3 }) : confusedWith(state, it.id).slice(0, 3).map((p) => p.id);
      partners.set(it.id, ids.map((id) => course.items.get(id)).filter(Boolean));
    }
    drill = new DrillSession(items, { partners, listen: hasJapaneseVoice(), groupOnly: !!groupId });
    Object.assign(drill, { groupOnly: !!groupId, graduated: [], stays: [] });
  }
  drillStep();
}

function drillStageOf(item) {
  const card = state.cards[item.id];
  return card ? item.stages[Math.min(card.stage, item.stages.length - 1)] : item.stages.at(-1);
}

function drillStep() {
  const step = drill.next();
  if (!step) return finishDrill();
  const { item, view } = step;
  const head = `<div class="session-head">
      <span class="pill pill-difficult">${drill.groupOnly ? 'Tell apart' : 'Difficult'}</span>
      <div class="bar thin"><span class="seg seg-learning" style="width:${Math.round(drill.progress * 100)}%"></span></div>
      <a class="close" href="${drill.groupOnly ? `#/item/${encodeURIComponent(item.id)}` : '#/difficult'}" aria-label="End drill">✕</a>
    </div>`;
  const done = (ok) => drillResult(ok, step);
  const stage = drillStageOf(item);
  const prefer = partnersOf(course, state, item.id, { learnedOnly: false, limit: 3 });
  if (view === 'reteach') return reteachView(head, item, done);
  if (view === 'contrast') return contrastView(head, item, drill.tell.get(item.id).group, done);
  if (view === 'tellapart') return tellApartView(head, step, done);
  if (view === 'mc-recognize' || view === 'mc-recall') {
    return mcView(head, item, view === 'mc-recognize' ? 'recognize' : 'recall', { stage, prefer, done });
  }
  if (view === 'type-recall') return typeRecallView(head, item, done);
  if (view === 'listen') return listenView(head, item, stage, prefer, done);
  return done(true);
}

function drillResult(ok, step) {
  if (DRILL_TESTS.includes(step.view)) recordDrill(state, ok);
  const fin = drill.result(ok);
  if (fin && !drill.groupOnly) {
    if (fin.clean && graduateDifficult(state, fin.item.id)) {
      drill.graduated.push(fin.item);
      toast(`<b lang="ja">${esc(itemLabelOf(fin.item))}</b> graduated — back in normal reviews tomorrow`, 2500);
    } else drill.stays.push(fin.item);
  }
  persist();
  drillStep();
}

function continueButton(done, ok = true) {
  const go = () => done(ok);
  on('#go', 'click', go);
  app.querySelector('#go')?.focus();
  keyHandler = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
}

function reteachView(head, item, done) {
  const z = item.kind === 'word' ? sentencesOf(course, item.id)[0] : null;
  const sentence = z ? course.sentenceById.get(z.sentenceId) : null;
  const kanji = kanjiBreakdown(course, item);
  const usedIn = item.kind === 'char'
    ? course.words.filter((w) => w.req.includes(item.char)).sort((a, b) => (state.cards[b.id] ? 1 : 0) - (state.cards[a.id] ? 1 : 0) || a.rank - b.rank).slice(0, 4)
    : [];
  const mix = mixupChips(item.id);
  render(`${head}<section class="card">
    <p class="eyebrow">Let's look at this one again</p>
    ${heroOf(item)}
    ${detailsHtml(item)}
    ${kanji.length ? `<div class="kanji-breakdown">${kanji.map((k) => `<div><span class="jp big-k" lang="ja">${esc(k.char)}</span><span>${esc(k.meanings.join(', '))}<br><small class="jp muted" lang="ja">${esc(k.kana)}</small></span></div>`).join('')}</div>` : ''}
    ${usedIn.length ? `<p class="small muted">Used in: <span lang="ja">${usedIn.map((w) => esc(w.display)).join('、')}</span></p>` : ''}
    ${sentence ? `<div class="reteach-sentence">${sentenceHtml(sentence, { span: z.span, mode: 'highlight', furigana: 'all' })}<p class="translation">${esc(sentence.en)}</p></div>` : ''}
    ${mix ? `<p class="small muted">You've mixed this up with:</p>${mix}` : ''}
    ${noteEditor(item.id)}
    <div class="card-actions">${audioBtn(item)}<button class="btn btn-primary" id="go">Test me</button></div>
  </section>`);
  bindAudio();
  bindNoteEditor(item.id);
  maybeAutoplay(item);
  continueButton(done);
  // typing in the note shouldn't trigger Continue
  app.querySelector('#note')?.addEventListener('keydown', (e) => e.stopPropagation());
}

function contrastView(head, item, group, done) {
  const kanaOf = (it) => (it.kind === 'char' ? it.kana.split(', ')[0] : it.kana);
  // the drilled word is compared with its closest-sounding partner; partners with it
  const closeness = (a, b) => diffHighlight(a, b).split('<mark>').length;
  const closest = group.slice(1).sort((a, b) => closeness(kanaOf(item), kanaOf(a)) - closeness(kanaOf(item), kanaOf(b)))[0];
  const col = (it) => {
    const vs = it === item ? closest : item;
    const k = kanaOf(it);
    const same = it !== item && it.kind === 'word' && k === kanaOf(item);
    return `<div class="contrast-col">
      <div class="jp contrast-kana" lang="ja">${it.kind === 'char' ? esc(it.char) : diffHighlight(k, kanaOf(vs))}</div>
      ${same ? '<div class="small same-sound">same sound — tell by kanji &amp; meaning</div>' : ''}
      ${it.kind === 'word' && it.written !== it.kana ? `<div class="jp muted" lang="ja">${esc(it.written)}</div>` : ''}
      ${it.kind === 'char' ? `<div class="jp muted small" lang="ja">${esc(it.kana)}</div>` : ''}
      <div class="contrast-meaning">${esc(glossOf(it))}</div>
      ${audioBtn(it)}
    </div>`;
  };
  render(`${head}<section class="card">
    <p class="eyebrow">Don't mix these up</p>
    <div class="contrast">${group.map(col).join('')}</div>
    <p class="small muted">The highlighted sounds are what's different. Play each one and say it out loud.</p>
    <div class="card-actions"><button class="btn btn-primary" id="go">Tell them apart</button></div>
  </section>`);
  bindAudio();
  continueButton(done);
}

function tellApartView(head, step, done) {
  const { group, target } = step;
  const t = drill.tell.get(step.item.id);
  const modes = ['meaning', 'reading', ...(hasJapaneseVoice() ? ['audio'] : [])];
  const mode = modes[t.rounds % modes.length];
  const label = (it) => (it.kind === 'char' ? esc(it.char) : `${esc(it.display)}${it.written !== it.kana ? ` <small>${esc(it.kana)}</small>` : ''}`);
  const prompt = mode === 'meaning' ? `<p class="question">Which one means…</p><div class="prompt"><span class="gloss big">${esc(glossOf(target))}</span></div>`
    : mode === 'reading' ? `<p class="question">What does this mean?</p><div class="prompt"><span class="jp big" lang="ja">${esc(target.kana)}</span></div>`
      : `<p class="question">Which one did you hear?</p><div class="prompt"><button class="icon-btn audio big-audio" data-say="${esc(speechTextOf(target, course))}" aria-label="Play again">🔊</button></div>`;
  const order = [...group].sort((a, b) => a.id.localeCompare(b.id));
  const opt = (it, i) => (mode === 'reading'
    ? `<button class="option" data-id="${esc(it.id)}"><kbd>${i + 1}</kbd>${esc(glossOf(it))}</button>`
    : `<button class="option jp" lang="ja" data-id="${esc(it.id)}"><kbd>${i + 1}</kbd>${label(it)}</button>`);
  render(`${head}<section class="card">
    <p class="eyebrow">Tell apart · round ${t.rounds + 1}</p>
    ${prompt}
    <div class="options">${order.map(opt).join('')}</div>
    <div id="feedback"></div>
  </section>`);
  bindAudio();
  if (mode === 'audio') speak(speechTextOf(target, course));
  let answered = false;
  const choose = (btn) => {
    if (answered) return;
    answered = true;
    const ok = btn.dataset.id === target.id;
    app.querySelectorAll('.option').forEach((b) => {
      b.disabled = true;
      if (b.dataset.id === target.id) b.classList.add('correct');
    });
    if (!ok) {
      btn.classList.add('wrong');
      noteConfusion(target.id, btn.dataset.id);
    }
    app.querySelector('#feedback').innerHTML = `${ok ? '' : `<p class="small">That was <b lang="ja">${esc(itemLabelOf(target))}</b> — ${esc(glossOf(target))}</p>`}
      <div class="card-actions">${audioBtn(target)}<button class="btn btn-primary" id="go">Continue</button></div>`;
    bindAudio();
    continueButton(done, ok);
    if (ok) setTimeout(() => { if (app.querySelector('#go')) app.querySelector('#go').click(); }, 600);
  };
  on('.option', 'click', (e) => choose(e.currentTarget));
  keyHandler = (e) => {
    const btns = app.querySelectorAll('.option');
    const n = Number(e.key);
    if (n >= 1 && n <= btns.length) choose(btns[n - 1]);
  };
}

// Meaning -> type the reading yourself (romaji converts to kana as you type).
function typeRecallView(head, item, done) {
  const readings = item.kind === 'char' ? item.kana.split(', ') : [item.kana, ...(item.alt || [])];
  const accept = new Set(readings.map((r) => normalizeAnswer(r)));
  render(`${head}<section class="card">
    <p class="question">Type the reading of</p>
    <div class="prompt"><span class="gloss big">${esc(glossOf(item))}</span></div>
    ${item.kind === 'char' ? `<p class="small muted">Kanji: <span class="jp" lang="ja">${esc(item.char)}</span> — any of its readings counts</p>` : ''}
    <form id="typeform" class="type-answer" autocomplete="off">
      <input id="typed" type="text" lang="ja" placeholder="kana or romaji" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Reading">
      <span id="kana-preview" class="kana-preview jp" lang="ja"></span>
      <button class="btn btn-primary" type="submit">Check</button>
      <button class="btn btn-link" type="button" id="dunno">I don't know</button>
    </form>
    <div id="feedback"></div>
  </section>`);
  const input = app.querySelector('#typed');
  const pv = app.querySelector('#kana-preview');
  input.addEventListener('input', () => { pv.textContent = /[a-z]/i.test(input.value) ? romajiToKana(input.value) : ''; });
  const finish = (given) => {
    const ok = accept.has(normalizeAnswer(given));
    input.disabled = true;
    input.classList.add(ok ? 'correct' : 'wrong');
    app.querySelectorAll('#typeform button').forEach((b) => { b.hidden = true; });
    if (!ok && given) for (const other of wordsReadAs(given)) noteConfusion(item.id, other);
    app.querySelector('#feedback').innerHTML = `<div class="reveal"><div class="verdict ${ok ? 'ok' : 'bad'}">${ok ? '✓ Correct' : '✗ Not quite'}</div>
      ${detailsHtml(item, { highlightStage: 'kana' })}</div>
      <div class="card-actions">${audioBtn(item)}<button class="btn btn-primary" id="go">Continue</button></div>`;
    bindAudio();
    maybeAutoplay(item);
    continueButton(done, ok);
  };
  app.querySelector('#typeform').addEventListener('submit', (e) => {
    e.preventDefault();
    if (input.value.trim()) finish(input.value);
  });
  on('#dunno', 'click', () => finish(''));
  input.focus();
  keyHandler = null;
}

// Hear it, pick the meaning (look-alike choices).
function listenView(head, item, stage, prefer, done) {
  const { correct, options, idOf } = choiceOptions(course, item, stage, 'recognize', { prefer });
  const say = speechTextOf(item, course);
  render(`${head}<section class="card">
    <p class="question">Listen — what does it mean?</p>
    <div class="prompt"><button class="icon-btn audio big-audio" data-say="${esc(say)}" aria-label="Play again">🔊</button></div>
    <div class="options">${options.map((o, i) => `<button class="option" data-v="${esc(o)}"><kbd>${i + 1}</kbd>${esc(o)}</button>`).join('')}</div>
    <div id="feedback"></div>
  </section>`);
  bindAudio();
  speak(say);
  let answered = false;
  const choose = (btn) => {
    if (answered) return;
    answered = true;
    const ok = btn.dataset.v === correct;
    app.querySelectorAll('.option').forEach((b) => {
      b.disabled = true;
      if (b.dataset.v === correct) b.classList.add('correct');
    });
    if (!ok) {
      btn.classList.add('wrong');
      noteConfusion(item.id, idOf[btn.dataset.v]);
    }
    app.querySelector('#feedback').innerHTML = `<div class="details-wrap">${detailsHtml(item)}</div>
      <div class="card-actions">${audioBtn(item)}<button class="btn btn-primary" id="go">Continue</button></div>`;
    bindAudio();
    continueButton(done, ok);
  };
  on('.option', 'click', (e) => choose(e.currentTarget));
  keyHandler = (e) => {
    const btns = app.querySelectorAll('.option');
    const n = Number(e.key);
    if (n >= 1 && n <= btns.length) choose(btns[n - 1]);
  };
}

function finishDrill() {
  const d = drill;
  const left = difficultCards(state).length;
  const chips = (list) => `<div class="chips center">${list.map((it) => `<a class="chip chip-word" lang="ja" href="#/item/${encodeURIComponent(it.id)}">${esc(itemLabelOf(it))}</a>`).join('')}</div>`;
  if (d.groupOnly) {
    const it = d.items[0];
    render(`<section class="panel center"><h2>Practised telling them apart</h2>
      <p class="muted">${[...d.tell.values()].map((t) => `${t.rounds} rounds`).join(', ')}</p>
      <div class="actions"><a class="btn btn-primary" href="#/item/${encodeURIComponent(it.id)}">Back to <span lang="ja">${esc(itemLabelOf(it))}</span></a><a class="btn" href="#/">Home</a></div></section>`);
  } else {
    render(`<section class="panel center">
      <h2>${d.graduated.length ? `${d.graduated.length} graduated` : 'Drill finished'}</h2>
      ${d.graduated.length ? `<p class="muted">Back in normal reviews tomorrow:</p>${chips(d.graduated)}` : ''}
      ${d.stays.length ? `<p class="muted">Still Difficult (a test was missed) — drill again later:</p>${chips(d.stays)}` : ''}
      <div class="actions">
        ${left ? `<a class="btn btn-primary" href="#/difficult" id="again">Drill again (${Math.min(10, left)})</a>` : ''}
        <a class="btn" href="#/">Home</a>
      </div></section>`);
    // already on #/drill, so start the next round directly
    on('#again', 'click', (e) => { e.preventDefault(); drill = null; renderDrill(null); });
  }
  drill = null;
  keyHandler = null;
}

// ------------------------------------------------------------------ browse

const BROWSE_TABS = [['characters', 'Characters'], ['words', 'Words'], ['sentences', 'Sentences'], ['grammar', 'Grammar']];
const browseFilters = { characters: 'kanji', words: 'all', sentences: 'all', q: '' };

function renderBrowse(tab) {
  const tabs = `<nav class="subtabs">${BROWSE_TABS.map(([id, label]) => `<a href="#/browse/${id}" class="${id === tab ? 'on' : ''}">${label}</a>`).join('')}</nav>`;
  const queued = new Set(state.queue);
  const status = (id) => {
    const card = state.cards[id];
    if (card?.difficult) return 'difficult';
    if (card) return card.passedFinal ? 'known' : 'learning';
    return queued.has(id) ? 'queued' : 'locked';
  };
  const filterBar = (key, opts) => `<div class="filters">${opts.map(([v, l]) => `<button class="fchip ${browseFilters[key] === v ? 'on' : ''}" data-f="${key}" data-v="${v}">${l}</button>`).join('')}</div>`;
  const statusOpts = [['all', 'All'], ['known', 'Known'], ['learning', 'Learning'], ['difficult', 'Difficult'], ['queued', 'Queued'], ['locked', 'Locked']];

  let body = '';
  if (tab === 'characters') {
    const f = browseFilters.characters === 'all' ? 'kanji' : browseFilters.characters;
    browseFilters.characters = f;
    if (f === 'kanji') {
      body = `${filterBar('characters', [['kanji', 'Kanji'], ['hiragana', 'Hiragana'], ['katakana', 'Katakana']])}
      <p class="muted small">The ${course.characters.length} N5 kanji, ordered by frequency in Japanese sentences (most common first).</p>
      <div class="char-grid">${course.characters.map((c) => `<a class="tile tile-${status(c.id)}" href="#/item/${encodeURIComponent(c.id)}" title="${esc(c.meanings.join(', '))}">
        <span class="jp" lang="ja">${esc(c.char)}</span><small>${esc(c.meanings[0])}</small></a>`).join('')}</div>`;
    } else {
      const list = course.kana.filter((c) => c.type === f);
      body = `${filterBar('characters', [['kanji', 'Kanji'], ['hiragana', 'Hiragana'], ['katakana', 'Katakana']])}
      <p class="muted small">Reference chart, most common first. Kana don't have cards of their own — you learn them through the kana stage of every word.</p>
      <div class="char-grid">${list.map((c) => `<button class="tile tile-ref" data-say="${esc(c.char)}" title="${esc(c.romaji)}">
        <span class="jp" lang="ja">${esc(c.char)}</span><small>${esc(c.romaji.split(' (')[0])}</small></button>`).join('')}</div>`;
    }
  } else if (tab === 'words') {
    const f = browseFilters.words;
    const q = browseFilters.q.trim().toLowerCase();
    const list = course.words.filter((w) => (f === 'all' || status(w.id) === f)
      && (!q || w.written.includes(q) || w.kana.includes(q) || w.romaji.includes(q) || w.meaning.toLowerCase().includes(q) || w.kana === romajiToKana(q)));
    body = `${filterBar('words', statusOpts)}
      <input class="search" id="q" type="search" placeholder="Search words (English, kana, romaji)" value="${esc(browseFilters.q)}">
      <p class="muted small">${list.length} words · ordered by frequency</p>
      <ul class="list">${list.map((w) => `<li><a href="#/item/${encodeURIComponent(w.id)}">
        <span class="w-jp jp" lang="ja">${esc(w.display)}${w.written !== w.kana ? `<small>${esc(w.kana)}</small>` : ''}</span>
        <span class="w-en">${esc(w.meaning)}</span>${statusBadge(status(w.id))}</a></li>`).join('')}</ul>`;
  } else if (tab === 'sentences') {
    const f = browseFilters.sentences;
    const clozes = [...course.items.values()].filter((i) => i.kind === 'cloze' && (f === 'all' ? status(i.id) !== 'locked' : status(i.id) === f));
    const lockedCount = [...course.items.values()].filter((i) => i.kind === 'cloze' && status(i.id) === 'locked').length;
    body = `${filterBar('sentences', statusOpts.filter(([v]) => v !== 'locked' && v !== 'difficult'))}
      <p class="muted small">${clozes.length} sentences shown · ${lockedCount} still locked (they unlock as you learn each word).</p>
      <ul class="list sentences">${clozes.map((z) => {
    const s = course.sentenceById.get(z.sentenceId);
    return `<li><a href="#/item/${encodeURIComponent(z.id)}">${sentenceHtml(s, { span: z.span, mode: 'highlight', furigana: 'off' })}<span class="w-en">${esc(s.en)}</span>${statusBadge(status(z.id))}</a></li>`;
  }).join('') || '<li class="muted">No sentences yet.</li>'}</ul>`;
  } else {
    body = `<p class="muted small">${course.grammar.length} N5 grammar patterns. Practice sentences are tagged with the patterns they use.</p>
      ${course.grammar.map((g) => {
    const samples = course.sentences.filter((s) => s.g.includes(g.id)).sort((a, b) => a.ja.length - b.ja.length).slice(0, 3);
    return `<details class="grammar" id="g-${g.id}"><summary><span class="jp" lang="ja">${esc(g.pattern)}</span><span class="w-en">${esc(g.meaning)}</span></summary>
        <p><b>Structure:</b> <span lang="ja">${esc(g.structure)}</span></p>
        <p>${esc(g.explanation)}</p>
        <ul class="examples">${g.examples.map((x) => `<li><span class="jp" lang="ja">${esc(x.ja)}</span><br><span class="muted">${esc(x.en)}</span></li>`).join('')}</ul>
        ${samples.length ? `<p class="small muted">From the sentence deck (${g.sentenceCount}):</p><ul class="examples">${samples.map((s) => `<li>${sentenceHtml(s, { furigana: 'all' })}<span class="muted">${esc(s.en)}</span></li>`).join('')}</ul>` : ''}
      </details>`;
  }).join('')}`;
  }
  render(`${tabs}${body}`);
  bindAudio();
  on('.fchip', 'click', (e) => {
    browseFilters[e.currentTarget.dataset.f] = e.currentTarget.dataset.v;
    renderBrowse(tab);
  });
  const q = app.querySelector('#q');
  if (q) {
    q.addEventListener('input', () => {
      browseFilters.q = q.value;
      const pos = q.selectionStart;
      renderBrowse(tab);
      const nq = app.querySelector('#q');
      nq.focus();
      nq.setSelectionRange(pos, pos);
    });
  }
}

function renderItem(id) {
  const item = course.items.get(id);
  if (!item) return renderHome();
  const card = state.cards[id];
  const st = itemStatus(state, id);
  const queuePos = state.queue.indexOf(id);
  const srsInfo = card ? `<div class="srs-info">
      <div><span>Stage</span><b>${esc(stageLabel(item, item.stages[Math.min(card.stage, item.stages.length - 1)]))}</b></div>
      <div><span>Next review</span><b>${whenText(card.due)}</b></div>
      <div><span>Interval</span><b>${card.ivl ? `${card.ivl}d` : card.state}</b></div>
      <div><span>Ease</span><b>${Math.round(card.ease * 100)}%</b></div>
      <div><span>Reviews</span><b>${card.reps || 0}</b></div>
      <div><span>Lapses</span><b>${card.lapses}</b></div>
    </div>` : `<p class="muted">${queuePos >= 0 ? `Position ${queuePos + 1} in the to-be-learned queue.` : 'Locked.'}</p>`;
  let extra = '';
  if (item.kind === 'char') {
    const words = course.words.filter((w) => w.req.includes(item.char)).slice(0, 30);
    extra = words.length ? `<h3>Words using ${esc(item.char)}</h3><div class="chips">${words.map(chip).join('')}</div>` : '';
  } else if (item.kind === 'word') {
    const known = knownChars(course, state);
    const missing = item.req.filter((c) => !known.has(c));
    const clozes = course.clozesByWord.get(item.id) || [];
    extra = `<h3>Characters</h3><div class="chips">${item.req.map((c) => chip(course.charByValue.get(c))).join('')}</div>
      ${st === 'locked' ? `<p class="muted small">Unlocks when you know: <span lang="ja">${esc(missing.join(' '))}</span></p>` : ''}
      <h3>Practice sentences (${clozes.length})</h3>
      <ul class="list sentences">${clozes.map((z) => {
    const s = course.sentenceById.get(z.sentenceId);
    return `<li>${sentenceHtml(s, { span: z.span, mode: 'highlight', furigana: 'all' })}<span class="w-en">${esc(s.en)}</span>${statusBadge(itemStatus(state, z.id))}</li>`;
  }).join('') || '<li class="muted">No N5-level sentences found for this word.</li>'}</ul>`;
  }
  let main;
  if (item.kind === 'cloze') {
    const s = course.sentenceById.get(item.sentenceId);
    const w = course.items.get(item.wordId);
    main = `${sentenceHtml(s, { span: item.span, mode: 'highlight', furigana: 'all' })}<p class="translation">${esc(s.en)}</p>
      <div class="word-ref">Cloze: <span class="jp" lang="ja">${esc(item.answer)}</span> ← <a href="#/item/${w.id}" class="jp" lang="ja">${esc(w.display)}</a> <span class="muted">${esc(w.meaning)}</span></div>${grammarTags(s)}`;
  } else {
    main = `${heroOf(item)}${detailsHtml(item)}${stagesStrip(item, card ? card.stage : -1)}`;
  }
  // Difficult toggle, note and mix-ups (words and kanji you've started learning)
  let tricky = '';
  if (item.kind !== 'cloze') {
    const mix = confusedWith(state, id);
    const sims = (item.sim || []).filter((x) => !mix.some((m) => m.id === x)).map((x) => course.items.get(x)).filter(Boolean);
    const group = partnersOf(course, state, id, { limit: 3 });
    tricky = `<section class="panel">
      ${card ? `<div class="actions"><button class="btn ${card.difficult ? '' : 'btn-danger'}" id="toggle-difficult">${card.difficult ? 'Remove from Difficult' : 'Mark as Difficult'}</button>
        ${card.difficult ? '<a class="btn btn-primary" href="#/drill">Drill Difficult words</a>' : ''}</div>` : ''}
      ${noteEditor(id)}
      <h3>Mixed up with</h3>
      ${mix.length ? mixupChips(id) : '<p class="muted small">No mix-ups recorded yet. Picking or typing another word by mistake records one here.</p>'}
      ${sims.length ? `<h3>Looks or sounds like</h3><div class="chips">${sims.map((x) => `<a class="chip chip-${x.kind}" lang="ja" href="#/item/${encodeURIComponent(x.id)}">${esc(itemLabelOf(x))}${x.kind === 'word' && x.written !== x.kana ? ` <small>${esc(x.kana)}</small>` : ''}</a>`).join('')}</div>` : ''}
      ${card && group.length ? `<div class="actions"><a class="btn" href="#/drill/group:${encodeURIComponent(id)}">Drill this group (<span lang="ja">${[item, ...group.map((g) => course.items.get(g))].map((g) => esc(itemLabelOf(g))).join(' · ')}</span>)</a></div>` : ''}
    </section>`;
  }
  render(`<p><a href="javascript:history.back()" class="back">← Back</a></p>
    <section class="card"><div class="card-meta"><span class="pill pill-${item.kind}">${esc(kindLabel(item))}</span>${statusBadge(st)}${audioBtn(item)}</div>
    ${main}${srsInfo}</section>
    ${tricky}
    <section class="panel">${extra}</section>`);
  bindAudio();
  bindNoteEditor(id);
  on('#toggle-difficult', 'click', () => {
    markDifficult(course, state, id, !card.difficult);
    persist();
    renderItem(id);
  });
}


// ------------------------------------------------------------------ stats

const RANGES = [['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['all', 'All time']];
const SERIES_COLOR = { char: 'var(--series-1)', word: 'var(--series-2)', cloze: 'var(--series-3)' };
const STAGE_NAMES = { romaji: 'Romaji', kana: 'Kana', kanji: 'Kanji', cloze: 'Cloze' };
let statsRange = '30';

const shortDate = (key) => `${Number(key.slice(5, 7))}/${Number(key.slice(8, 10))}`;
const longDate = (key) => new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const pct = (r) => (r == null ? '—' : `${Math.round(r * 100)}%`);

function renderStats(arg) {
  if (arg && RANGES.some(([v]) => v === arg)) statsRange = arg;
  const now = Date.now();
  const n = statsRange === 'all' ? Math.min(365, daysOfHistory(state, now)) : Number(statsRange);
  const rangeLabel = RANGES.find(([v]) => v === statsRange)[1].toLowerCase();
  const snap = snapshot(course, state);
  const rates = successRates(state, now, n);
  const fc = forecast(course, state, now, 14);
  const next = upcoming(course, state, 8);
  const trouble = hardest(course, state, 10);
  const dueNow = fc[0].total;
  const week = fc.slice(0, 7).reduce((a, d) => a + d.total, 0);

  const hist = reviewHistory(state, now, n);
  const learnedRange = hist.reduce((a, d) => a + d.learned, 0);
  const playedRange = rates.reviews + learnedRange;
  const creditedRange = lastDays(now, n).reduce((a, k) => a + (state.days[k]?.credited || 0), 0);
  const tile = (value, label, sub = '') => `<div class="stat"><b>${value}</b><span>${label}</span>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const kindRows = KINDS.map((k) => {
    const b = snap[k];
    const stages = Object.entries(b.stages).map(([st, c]) => `${STAGE_NAMES[st]} ${c}`).join(' · ') || '—';
    return `<tr><th>${KIND_NAMES[k]}</th><td>${b.known}</td><td>${b.learning}</td><td>${b.queued}</td><td>${b.locked}</td><td>${b.total}</td><td class="muted">${stages}</td></tr>`;
  }).join('');

  const stageRows = [];
  for (const kind of KINDS) {
    const stages = kind === 'cloze' ? ['cloze'] : ['romaji', 'kana', 'kanji'];
    for (const st of stages) {
      const r = rates.byStage[`${kind}:${st}`];
      if (!r) continue;
      stageRows.push({ label: `${KIND_NAMES[kind]} · ${STAGE_NAMES[st]}`, value: r.rate, text: `${pct(r.rate)} of ${r.total}`, detail: `${r.passed} passed, ${r.failed} failed` });
    }
  }
  const matRows = [['learning', 'Learning steps'], ['young', 'Young (< 21 days)'], ['mature', 'Mature (21+ days)']]
    .map(([k, label]) => ({ label, value: rates.byMaturity[k].rate, text: rates.byMaturity[k].total ? `${pct(rates.byMaturity[k].rate)} of ${rates.byMaturity[k].total}` : '—', detail: `${rates.byMaturity[k].passed} passed, ${rates.byMaturity[k].failed} failed` }));
  const totalRatings = rates.ratings.reduce((a, b) => a + b, 0);
  const ratingRows = ['Again', 'Hard', 'Good', 'Easy'].map((label, i) => ({
    label, value: totalRatings ? rates.ratings[i] / totalRatings : null,
    text: totalRatings ? `${pct(rates.ratings[i] / totalRatings)} (${rates.ratings[i]})` : '—', detail: `${rates.ratings[i]} answers`,
  }));
  const itemLabel = (item) => (item.kind === 'char' ? item.char : item.kind === 'word' ? item.display : item.answer);

  render(`
    <h1 class="page-title">Stats</h1>
    <div class="filters range">${RANGES.map(([v, l]) => `<a class="fchip ${v === statsRange ? 'on' : ''}" href="#/stats/${v}">${l}</a>`).join('')}</div>
    <section class="stat-cards stat-cards-5">
      ${tile(`${snap.char.known}<small>/${snap.char.total}</small>`, 'kanji known')}
      ${tile(`${snap.word.known}<small>/${snap.word.total}</small>`, 'words known')}
      ${tile(`${snap.cloze.known}<small>/${snap.cloze.total}</small>`, 'sentences known')}
      ${tile(pct(rates.rate), `success, ${rangeLabel}`)}
      ${tile(playedRange, `cards played, ${rangeLabel}`, `${rates.reviews} reviews · ${learnedRange} learned`)}
    </section>

    <section class="panel">
      <h2>What you've learned</h2>
      <p class="muted small">Items that have passed their final form (kanji, or kana for kana words), ${rangeLabel}.</p>
      <div class="chart-slot" data-chart="known"></div>
      <div class="table-scroll"><table class="breakdown">
        <thead><tr><th></th><th>Known</th><th>Learning</th><th>Unlocked</th><th>Locked</th><th>Total</th><th>Cards by current form</th></tr></thead>
        <tbody>${kindRows}</tbody></table></div>
    </section>

    <section class="panel">
      <h2>Coming up</h2>
      <p class="muted small">${dueNow} due today · ${week} in the next 7 days · ${state.queue.length} waiting in the to-be-learned queue. Next 14 days:</p>
      <div class="chart-slot" data-chart="forecast"></div>
      ${next.length ? `<h3>Next reviews</h3><ul class="list upcoming">${next.map(({ card, item, stage }) => `<li><a href="#/item/${encodeURIComponent(item.id)}">
          <span class="w-jp jp" lang="ja">${esc(itemLabel(item))}</span>
          <span class="w-en">${esc(kindLabel(item))} · ${esc(STAGE_NAMES[stage])}</span>
          <span class="when">${whenText(card.due)}</span></a></li>`).join('')}</ul>` : '<p class="muted">Nothing scheduled yet — learn some items first.</p>'}
    </section>

    <section class="panel">
      <h2>Cards played per day</h2>
      <p class="muted small">Reviews passed (Hard / Good / Easy) and failed (Again), plus new items learned, ${rangeLabel}.${creditedRange ? ` Typing words in sentences also earned ${creditedRange} word review${creditedRange === 1 ? '' : 's'} without extra cards.` : ''}</p>
      <div class="chart-slot" data-chart="history"></div>
    </section>

    <section class="panel">
      <h2>Success rate</h2>
      <p class="muted small">Share of reviews not answered “Again”, ${rangeLabel}.</p>
      <h3>By item and form</h3>
      ${stageRows.length ? hBars(stageRows) : '<p class="muted small">No reviews in this range.</p>'}
      <h3>By card maturity</h3>
      ${hBars(matRows)}
      <h3>Answer buttons</h3>
      ${hBars(ratingRows)}
    </section>

    <section class="panel">
      <h2>Needs work</h2>
      ${trouble.length ? `<ul class="list">${trouble.map(({ card, item }) => `<li><a href="#/item/${encodeURIComponent(item.id)}">
          <span class="w-jp jp" lang="ja">${esc(itemLabel(item))}</span>
          <span class="w-en">${esc(kindLabel(item))} · ${card.lapses} lapse${card.lapses === 1 ? '' : 's'} · ease ${Math.round(card.ease * 100)}%</span></a></li>`).join('')}</ul>`
    : '<p class="muted small">No lapses yet — items you forget after learning will show up here.</p>'}
    </section>`);

  drawStatsCharts({ n, fc });
  bindAudio();
}

function drawStatsCharts({ n, fc }) {
  const now = Date.now();
  const slot = (name) => app.querySelector(`[data-chart="${name}"]`);
  const every = (len) => Math.max(1, Math.ceil(len / 6));

  const known = knownOverTime(course, state, now, n);
  const knownSeries = KINDS.map((k) => ({ key: k, name: KIND_NAMES[k], color: SERIES_COLOR[k], values: known.series[k] }));
  const ks = slot('known');
  ks.innerHTML = `${legendHtml(knownSeries, 'line')}${lineChart(ks.clientWidth, {
    labels: known.keys.map(shortDate), titles: known.keys.map(longDate), series: knownSeries, labelEvery: every(n),
  })}${tableHtml(['Date', ...knownSeries.map((s) => s.name)], known.keys.map((k, i) => [k, ...knownSeries.map((s) => s.values[i])]).reverse())}`;

  const fSeries = KINDS.map((k) => ({ key: k, name: KIND_NAMES[k], color: SERIES_COLOR[k] }));
  const fs = slot('forecast');
  fs.innerHTML = `${legendHtml(fSeries)}${stackedBars(fs.clientWidth, {
    rows: fc.map((d, i) => ({ label: i === 0 ? 'Today' : shortDate(d.key), title: `${i === 0 ? 'Today (incl. overdue)' : longDate(d.key)} · ${d.total} due`, values: d })),
    series: fSeries, labelEvery: 3,
  })}${tableHtml(['Date', ...fSeries.map((s) => s.name), 'Total'], fc.map((d) => [d.key, d.char, d.word, d.cloze, d.total]))}`;

  const hist = reviewHistory(state, now, n);
  const hSeries = [
    { key: 'passed', name: 'Passed', color: 'var(--series-1)' },
    { key: 'failed', name: 'Failed', color: 'var(--series-2)' },
    { key: 'learned', name: 'Learned', color: 'var(--series-3)' },
  ];
  const hs = slot('history');
  hs.innerHTML = `${legendHtml(hSeries)}${stackedBars(hs.clientWidth, {
    rows: hist.map((d) => ({ label: shortDate(d.key), title: `${longDate(d.key)} · ${d.passed + d.failed + d.learned} cards played`, values: d })),
    series: hSeries, labelEvery: every(n),
  })}${tableHtml(['Date', 'Played', 'Passed', 'Failed', 'Learned', 'Success'], hist.map((d) => [d.key, d.passed + d.failed + d.learned, d.passed, d.failed, d.learned, d.passed + d.failed ? pct(d.passed / (d.passed + d.failed)) : '—']).reverse())}`;

  bindCharts(app);
}

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (location.hash.startsWith('#/stats')) route({ keepScroll: true }); }, 200);
});

// ------------------------------------------------------------------ settings

function renderSettings() {
  const s = state.settings;
  const meta = course.meta;
  render(`<section class="panel">
    <h2>Study settings</h2>
    <form id="settings" class="settings">
      <label><span>New items per day</span> <input type="number" name="newPerDay" min="1" max="200" value="${s.newPerDay}"></label>
      <label><span>Items per learning session</span> <input type="number" name="batchSize" min="1" max="20" value="${s.batchSize}"></label>
      <label><span>Default Play length (cards)</span> <input type="number" name="playSize" min="1" max="500" value="${s.playSize}"></label>
      <label><span>Learning steps (minutes)</span> <input type="text" name="learningSteps" value="${s.learningSteps.join(' ')}" pattern="[0-9 ]+"></label>
      <label><span>Relearning steps (minutes)</span> <input type="text" name="relearningSteps" value="${s.relearningSteps.join(' ')}" pattern="[0-9 ]+"></label>
      <label><span>Cloze answers</span>
        <select name="clozeMode">
          <option value="mixed" ${s.clozeMode === 'mixed' ? 'selected' : ''}>Mixed (choice + typing)</option>
          <option value="mc" ${s.clozeMode === 'mc' ? 'selected' : ''}>Multiple choice</option>
          <option value="type" ${s.clozeMode === 'type' ? 'selected' : ''}>Typing</option>
        </select></label>
      <label class="check"><input type="checkbox" name="furigana" ${s.furigana ? 'checked' : ''}> Furigana over kanji you haven't learned</label>
      <label class="check"><input type="checkbox" name="autoplayAudio" ${s.autoplayAudio ? 'checked' : ''}> Auto-play audio (device text-to-speech)</label>
    </form>
  </section>
  <section class="panel">
    <h2>Your progress</h2>
    <p class="muted small">Progress is saved only in this browser (localStorage). Export a backup to move it to another device.</p>
    <div class="actions">
      <button class="btn" id="export">Export progress</button>
      <label class="btn">Import progress<input type="file" id="import" accept="application/json" hidden></label>
      <button class="btn btn-danger" id="reset">Reset all progress</button>
    </div>
  </section>
  <section class="panel">
    <h2>About the ${esc(meta.level)} data</h2>
    <p class="small">${meta.counts.kanji} kanji · ${meta.counts.kana} kana (reference chart) · ${meta.counts.words} words &amp; phrases · ${meta.counts.sentences} sentences · ${meta.counts.grammar} grammar patterns.</p>
    <ul class="small">${meta.sources.map((src) => `<li><a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(src.name)}</a> — ${esc(src.license)}</li>`).join('')}</ul>
  </section>`);
  const form = app.querySelector('#settings');
  form.addEventListener('change', () => {
    const fd = new FormData(form);
    const steps = (v, fallback) => {
      const arr = String(v).split(/[\s,]+/).map(Number).filter((n) => n > 0);
      return arr.length ? arr : fallback;
    };
    const clampInt = (v, lo, hi, d) => Math.min(hi, Math.max(lo, parseInt(v, 10) || d));
    state.settings = {
      ...state.settings,
      newPerDay: clampInt(fd.get('newPerDay'), 1, 200, DEFAULT_SETTINGS.newPerDay),
      batchSize: clampInt(fd.get('batchSize'), 1, 20, DEFAULT_SETTINGS.batchSize),
      playSize: clampInt(fd.get('playSize'), 1, 500, DEFAULT_SETTINGS.playSize),
      learningSteps: steps(fd.get('learningSteps'), DEFAULT_SETTINGS.learningSteps),
      relearningSteps: steps(fd.get('relearningSteps'), DEFAULT_SETTINGS.relearningSteps),
      clozeMode: fd.get('clozeMode'),
      furigana: fd.get('furigana') === 'on',
      autoplayAudio: fd.get('autoplayAudio') === 'on',
    };
    persist();
    toast('Settings saved', 1500);
  });
  on('#export', 'click', () => exportState(state));
  on('#import', 'change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = await readImport(file);
      if (!confirm('Replace your current progress with this backup?')) return;
      state = reconcile(course, { ...initialState(course), ...data, level: LEVEL });
      persist();
      toast('Progress imported');
      renderSettings();
    } catch (err) {
      toast(`Import failed: ${esc(err.message)}`);
    }
  });
  on('#reset', 'click', () => {
    if (!confirm('Erase all progress for this level? This cannot be undone.')) return;
    clearState(LEVEL);
    state = initialState(course);
    persist();
    toast('Progress reset');
    location.hash = '#/';
  });
}

boot().catch((err) => {
  console.error(err);
  app.innerHTML = `<section class="panel"><h2>Could not load the course data</h2><p class="muted">${esc(err.message)}</p>
    <p class="small">Serve this folder over HTTP (e.g. <code>python3 -m http.server</code>) rather than opening index.html directly.</p></section>`;
});

// for debugging from the console
window.jlpt = { get state() { return state; }, get course() { return course; }, get drill() { return drill; } };
