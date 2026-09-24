// Kana <-> romaji helpers. Mirrors scripts/kana.py (wapuro-style Hepburn).

const BASE = {
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
  か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
  が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
  さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
  ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
  だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
  な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
  は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
  ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
  ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
  や: 'ya', ゆ: 'yu', よ: 'yo',
  ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
  わ: 'wa', を: 'wo', ん: 'n', ゔ: 'vu',
  ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o', ゃ: 'ya', ゅ: 'yu', ょ: 'yo', ゎ: 'wa',
};

const DIGRAPHS = {};
for (const [head, root] of [['き', 'k'], ['ぎ', 'g'], ['に', 'n'], ['ひ', 'h'], ['び', 'b'], ['ぴ', 'p'], ['み', 'm'], ['り', 'r']]) {
  DIGRAPHS[head + 'ゃ'] = root + 'ya';
  DIGRAPHS[head + 'ゅ'] = root + 'yu';
  DIGRAPHS[head + 'ょ'] = root + 'yo';
}
for (const [head, root] of [['し', 'sh'], ['じ', 'j'], ['ち', 'ch'], ['ぢ', 'j']]) {
  DIGRAPHS[head + 'ゃ'] = root + 'a';
  DIGRAPHS[head + 'ゅ'] = root + 'u';
  DIGRAPHS[head + 'ょ'] = root + 'o';
}
Object.assign(DIGRAPHS, {
  しぇ: 'she', じぇ: 'je', ちぇ: 'che', てぃ: 'ti', でぃ: 'di', とぅ: 'tu', どぅ: 'du',
  ふぁ: 'fa', ふぃ: 'fi', ふぇ: 'fe', ふぉ: 'fo', うぃ: 'wi', うぇ: 'we', うぉ: 'wo',
  ゔぁ: 'va', ゔぃ: 'vi', ゔぇ: 've', ゔぉ: 'vo', つぁ: 'tsa', つぇ: 'tse', つぉ: 'tso',
});

export const kataToHira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
export const hiraToKata = (s) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
export const isKanji = (c) => /[一-鿿々]/.test(c);
export const hasKanji = (s) => /[一-鿿々]/.test(s);
export const isKana = (c) => /[ぁ-ゖァ-ヶー]/.test(c);

export function toRomaji(text) {
  const s = kataToHira(text);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const pair = s.slice(i, i + 2);
    if (ch === 'っ') {
      const nxt = DIGRAPHS[s.slice(i + 1, i + 3)] || BASE[s[i + 1]] || '';
      if (nxt.startsWith('ch')) out += 't';
      else if (nxt && !'aiueon'.includes(nxt[0])) out += nxt[0];
      continue;
    }
    if (ch === 'ー') {
      const last = out[out.length - 1];
      out += last && 'aiueo'.includes(last) ? last : '-';
      continue;
    }
    if (ch === 'ん') {
      const nxt = s[i + 1];
      out += nxt && 'あいうえおやゆよ'.includes(nxt) ? "n'" : 'n';
      continue;
    }
    if (DIGRAPHS[pair]) {
      out += DIGRAPHS[pair];
      i++;
      continue;
    }
    out += BASE[ch] ?? ch;
  }
  return out;
}

// romaji -> hiragana, for typed answers (IME-like). Unknown characters pass through.
const R2K = {};
for (const [k, v] of Object.entries(BASE)) if (!'ぁぃぅぇぉゃゅょゎ'.includes(k)) R2K[v] = R2K[v] || k;
for (const [k, v] of Object.entries(DIGRAPHS)) R2K[v] = R2K[v] || k;
Object.assign(R2K, {
  si: 'し', ti: 'ち', tu: 'つ', hu: 'ふ', zi: 'じ', di: 'ぢ', du: 'づ', o: 'お', wo: 'を',
  sya: 'しゃ', syu: 'しゅ', syo: 'しょ', tya: 'ちゃ', tyu: 'ちゅ', tyo: 'ちょ', cya: 'ちゃ', cyu: 'ちゅ', cyo: 'ちょ',
  zya: 'じゃ', zyu: 'じゅ', zyo: 'じょ', jya: 'じゃ', jyu: 'じゅ', jyo: 'じょ',
  xa: 'ぁ', xi: 'ぃ', xu: 'ぅ', xe: 'ぇ', xo: 'ぉ', xya: 'ゃ', xyu: 'ゅ', xyo: 'ょ', xtu: 'っ', xtsu: 'っ',
  la: 'ぁ', li: 'ぃ', lu: 'ぅ', le: 'ぇ', lo: 'ぉ', lya: 'ゃ', lyu: 'ゅ', lyo: 'ょ', ltu: 'っ',
  nn: 'ん', "n'": 'ん', '-': 'ー',
});

export function romajiToKana(input) {
  const s = input.toLowerCase();
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    // doubled consonant -> っ
    if (i + 1 < s.length && c === s[i + 1] && /[bcdfghjkmpqrstvwxz]/.test(c)) {
      out += 'っ';
      i++;
      continue;
    }
    // "nn" before a vowel is ん + n… (konnichiha -> こんにちは)
    if (c === 'n' && s[i + 1] === 'n' && /[aiueoy]/.test(s[i + 2] || '')) {
      out += 'ん';
      i++;
      continue;
    }
    if (c === 't' && s[i + 1] === 'c' && s[i + 2] === 'h') {
      out += 'っ';
      i++;
      continue;
    }
    let matched = false;
    for (let len = 4; len >= 1; len--) {
      const chunk = s.slice(i, i + len);
      if (R2K[chunk]) {
        // "n" alone only becomes ん when not followed by a vowel / y
        if (chunk === 'n' && i + 1 < s.length && /[aiueoy]/.test(s[i + 1])) continue;
        out += R2K[chunk];
        i += len;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out += c;
      i++;
    }
  }
  return out;
}

// Normalises an answer for comparison: hiragana, no spaces/punctuation.
export function normalizeAnswer(s) {
  let t = s.trim().replace(/[\s、。，．,.!！?？「」]/g, '');
  if (/[a-z]/i.test(t)) t = romajiToKana(t);
  return kataToHira(t);
}

// Splits a token (surface + reading) into ruby segments so okurigana is not
// covered by furigana: 食べ/たべ -> [食|た] べ
export function rubySegments(surface, reading) {
  if (!reading || !hasKanji(surface)) return [[surface, null]];
  const r = kataToHira(reading);
  let pre = 0;
  while (pre < surface.length && !isKanji(surface[pre]) && kataToHira(surface[pre]) === r[pre]) pre++;
  let post = 0;
  while (post < surface.length - pre && !isKanji(surface[surface.length - 1 - post])
    && kataToHira(surface[surface.length - 1 - post]) === r[r.length - 1 - post]) post++;
  const segs = [];
  if (pre) segs.push([surface.slice(0, pre), null]);
  segs.push([surface.slice(pre, surface.length - post), r.slice(pre, r.length - post)]);
  if (post) segs.push([surface.slice(surface.length - post), null]);
  return segs;
}
