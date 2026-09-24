// Rendering helpers for items, sentences and multiple-choice options.
import { rubySegments, hasKanji, isKanji, kataToHira } from './kana.js';
import { STAGE_LABELS } from './engine.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

export const TYPE_LABEL = { hiragana: 'Hiragana', katakana: 'Katakana', kanji: 'Kanji' };

export function kindLabel(item) {
  if (item.kind === 'char') return TYPE_LABEL[item.type];
  if (item.kind === 'word') return 'Word';
  return 'Sentence';
}

export const isKanaChar = (item) => item.kind === 'char' && item.type !== 'kanji';

// The form tested at a given stage.
export function formAt(item, stage) {
  if (item.kind === 'char') {
    if (item.type !== 'kanji') return item.char;
    return stage === 'romaji' ? item.romaji : stage === 'kana' ? item.kana : item.char;
  }
  return stage === 'romaji' ? item.romaji : stage === 'kana' ? item.kana : item.written;
}

// What the form is tested against: English meaning (romaji for kana characters).
export function glossOf(item) {
  if (item.kind === 'char') return item.type === 'kanji' ? item.meanings.join(', ') : item.romaji;
  return item.meaning;
}

export const glossLabel = (item) => (isKanaChar(item) ? 'Romaji' : 'Meaning');
export const stageLabel = (item, stage) => (isKanaChar(item) ? TYPE_LABEL[item.type] : STAGE_LABELS[stage]);

export const isJapanese = (stage) => stage === 'kana' || stage === 'kanji';

export function formHtml(item, stage, cls = '') {
  const text = formAt(item, stage);
  if (isJapanese(stage) || isKanaChar(item)) return `<span class="jp ${cls}" lang="ja">${esc(text)}</span>`;
  return `<span class="romaji ${cls}">${esc(text)}</span>`;
}

// Full details of a character or word (shown on presentation / answer side).
export function detailsHtml(item, { highlightStage } = {}) {
  const row = (label, value, stage, jp = false) => value
    ? `<div class="detail-row${highlightStage === stage ? ' hl' : ''}"><span class="detail-label">${label}</span><span class="detail-value${jp ? ' jp' : ''}"${jp ? ' lang="ja"' : ''}>${esc(value)}</span></div>`
    : '';
  if (item.kind === 'char' && item.type !== 'kanji') {
    return `<div class="details">${row('Character', item.char, 'kana', true)}${row('Romaji', item.romaji, 'romaji')}</div>`;
  }
  if (item.kind === 'char') {
    return `<div class="details">
      ${row('Meaning', item.meanings.join(', '), 'meaning')}
      ${row('Romaji', item.romaji, 'romaji')}
      ${row('Kana', item.kana, 'kana', true)}
      ${row('Kanji', item.char, 'kanji', true)}
      ${row('On\'yomi', item.on.join('、'), '', true)}
      ${row('Kun\'yomi', item.kun.join('、'), '', true)}
      <div class="detail-foot">${item.strokes} strokes · frequency rank #${item.rank}</div>
    </div>`;
  }
  const kanjiRow = item.stages.includes('kanji')
    ? row('Kanji', item.written, 'kanji', true)
    : item.written !== item.kana ? row('Written', `${item.written} (${item.kanjiNote || 'reference'})`, '', true) : '';
  return `<div class="details">
    ${row('Meaning', item.meaning, 'meaning')}
    ${row('Romaji', item.romaji, 'romaji')}
    ${row('Kana', item.kana, 'kana', true)}
    ${kanjiRow}
    ${item.alt ? row('Also', item.alt.join('、'), '', true) : ''}
    <div class="detail-foot">${item.suru ? 'する verb · ' : ''}frequency rank #${item.rank}</div>
  </div>`;
}

// Sentence with optional furigana and an optional highlighted/blanked span.
// furigana: 'all' | 'unknown' (only kanji the learner does not know) | 'off'
export function sentenceHtml(sentence, { span = null, mode = 'none', furigana = 'unknown', known = new Set(), blankText = '' } = {}) {
  let pos = 0;
  let out = '';
  let blankDone = false;
  for (const [surface, reading] of sentence.t) {
    const start = pos;
    const end = pos + surface.length;
    pos = end;
    const inSpan = span && start < span[1] && end > span[0];
    if (inSpan && mode === 'blank') {
      // text of this token outside the span stays visible
      const before = surface.slice(0, Math.max(0, span[0] - start));
      const after = surface.slice(Math.max(0, surface.length - Math.max(0, end - span[1])));
      out += esc(before);
      if (!blankDone) {
        out += `<span class="blank">${blankText ? esc(blankText) : '&nbsp;'.repeat(4)}</span>`;
        blankDone = true;
      }
      out += esc(after);
      continue;
    }
    const showRuby = reading && furigana !== 'off'
      && (furigana === 'all' || [...surface].some((c) => isKanji(c) && !known.has(c)));
    let html = '';
    if (showRuby) {
      for (const [text, rt] of rubySegments(surface, reading)) {
        html += rt ? `<ruby>${esc(text)}<rt>${esc(rt)}</rt></ruby>` : esc(text);
      }
    } else html = esc(surface);
    out += inSpan && mode === 'highlight' ? `<mark>${html}</mark>` : html;
  }
  // tokens from the build always cover the whole sentence; fall back to raw text if not
  if (pos !== sentence.ja.length) out = esc(sentence.ja);
  return `<p class="sentence jp" lang="ja">${out}</p>`;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Pick n distinct distractor strings near the item in frequency.
function pickDistractors(item, pool, textOf, n = 3) {
  const answer = textOf(item);
  const sorted = pool.filter((x) => x.id !== item.id)
    .sort((a, b) => Math.abs(a.rank - item.rank) - Math.abs(b.rank - item.rank))
    .slice(0, 40);
  const out = [];
  const seen = new Set([answer]);
  for (const x of shuffle(sorted)) {
    const t = textOf(x);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= n) break;
  }
  return out;
}

function poolFor(course, item, stage) {
  if (item.kind === 'char') return course.characters.filter((c) => c.type === item.type);
  if (stage === 'kanji') return course.words.filter((w) => w.stages.includes('kanji'));
  return course.words;
}

// Options for "form -> meaning" (recognize) or "meaning -> form" (recall).
export function choiceOptions(course, item, stage, direction) {
  const pool = poolFor(course, item, stage);
  const textOf = direction === 'recognize' ? glossOf : (x) => formAt(x, stage);
  const correct = textOf(item);
  return { correct, options: shuffle([correct, ...pickDistractors(item, pool, textOf)]) };
}

// Options for a cloze: other cloze answers that look alike (length, script, ending).
export function clozeOptions(course, cloze) {
  const a = cloze.answer;
  const score = (b) => Math.abs(b.length - a.length) * 2
    + (hasKanji(b) !== hasKanji(a) ? 3 : 0)
    + (kataToHira(b.slice(-1)) !== kataToHira(a.slice(-1)) ? 1 : 0) + Math.random() * 2;
  const seen = new Set([a]);
  const cands = [];
  for (const it of course.items.values()) {
    if (it.kind !== 'cloze' || it.wordId === cloze.wordId || seen.has(it.answer)) continue;
    seen.add(it.answer);
    cands.push(it.answer);
  }
  const picks = cands.map((b) => [score(b), b]).sort((x, y) => x[0] - y[0]).slice(0, 12).map((x) => x[1]);
  return { correct: a, options: shuffle([a, ...shuffle(picks).slice(0, 3)]) };
}

export function statusBadge(status) {
  const label = { known: 'Known', learning: 'Learning', queued: 'Queued', locked: 'Locked' }[status];
  return `<span class="status status-${status}">${label}</span>`;
}

// Japanese text-to-speech (uses the device's voices; silently does nothing if none).
let jaVoice;
export function speak(text) {
  try {
    if (!('speechSynthesis' in window) || !text) return;
    if (jaVoice === undefined) jaVoice = speechSynthesis.getVoices().find((v) => v.lang?.startsWith('ja')) || null;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP';
    if (jaVoice) u.voice = jaVoice;
    u.rate = 0.9;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch { /* ignore */ }
}

export function speechTextOf(item, course) {
  if (item.kind === 'char') return item.type === 'kanji' ? (item.kun[0] || item.on[0] || item.char) : item.char;
  if (item.kind === 'word') return item.stages.includes('kanji') ? item.written : item.kana;
  return course.sentenceById.get(item.sentenceId)?.ja;
}
