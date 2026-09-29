#!/usr/bin/env python3
"""Build the JLPT N5 data set used by the app (data/n5/*.json).

Sources (downloaded into scripts/.cache on first run):
  * N5 vocabulary  - jamsinclair/open-anki-jlpt-decks (src/n5.csv, MIT)
  * N5 kanji       - davidluzgouveia/kanji-data (kanji.json; KANJIDIC2 based, CC BY-SA)
  * Sentences      - Tatoeba / Tanaka corpus sentences with English, as bundled in
                     scriptin/jmdict-simplified "jmdict-examples-eng" (CC BY 2.0 FR)
  * Word frequency - hermitdave/FrequencyWords ja_50k (OpenSubtitles 2016, CC BY-SA)

The sentence corpus is tokenised with janome so that:
  * character frequency (kana + kanji) comes from real sentences,
  * word frequency is lemma aware (食べ/食べた/食べます all count as 食べる),
  * example sentences can be filtered to "N5 level" (every content word is on the
    N5 list), and cloze targets land on the right (possibly conjugated) token.

Usage:  pip install janome && python3 scripts/build_data.py
"""
import csv
import io
import json
import math
import os
import re
import subprocess
import sys
import tarfile
import urllib.request
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(__file__))
from kana import (hira_to_kata, is_hiragana, is_kana, is_kanji, is_katakana,  # noqa: E402
                  kata_to_hira, to_romaji)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(HERE, '.cache')
OUT = os.path.join(ROOT, 'data', 'n5')

VOCAB_URL = 'https://raw.githubusercontent.com/jamsinclair/open-anki-jlpt-decks/main/src/n5.csv'
KANJI_URL = 'https://raw.githubusercontent.com/davidluzgouveia/kanji-data/master/kanji.json'
FREQ_URL = 'https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2016/ja/ja_50k.txt'
JMDICT_REPO = 'https://github.com/scriptin/jmdict-simplified'

SENTENCES_PER_WORD = (3, 5)   # min / max practice sentences per word
# Sentence difficulty tiers tried in order until a word has enough sentences:
# (max content words not on the N5 list, max kanji outside N5 vocab, max length)
TIERS = [(0, 0, 24), (1, 0, 28), (2, 0, 28), (2, 1, 32), (3, 2, 40)]
MAX_SENTENCE_REUSE = 2        # a sentence may be a cloze for at most this many words


# --------------------------------------------------------------------------- download

def fetch(url, name):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name)
    if not os.path.exists(path):
        print('downloading', url)
        urllib.request.urlretrieve(url, path)
    return path


def fetch_jmdict_examples():
    path = os.path.join(CACHE, 'jmdict-examples-eng.json')
    if os.path.exists(path):
        return path
    tags = subprocess.run(['git', 'ls-remote', '--tags', JMDICT_REPO], check=True,
                          capture_output=True, text=True).stdout.split()
    tag = sorted(t.split('refs/tags/')[1] for t in tags if 'refs/tags/3.' in t)[-1]
    url = f'{JMDICT_REPO}/releases/download/{tag.replace("+", "%2B")}/jmdict-examples-eng-{tag}.json.tgz'
    tgz = fetch(url, 'jmdict-examples-eng.json.tgz')
    with tarfile.open(tgz) as tf:
        member = next(m for m in tf.getmembers() if m.name.endswith('.json'))
        with tf.extractfile(member) as src, open(path, 'wb') as dst:
            dst.write(src.read())
    return path


# --------------------------------------------------------------------------- helpers

def split_variants(s):
    return [v.strip() for v in s.split(';') if v.strip()]


def strip_affix(s):
    return s.replace('～', '').replace('〜', '').strip()


def hira(s):
    return kata_to_hira(s)


def tokenize_all(tokenizer, texts):
    out = []
    for i, t in enumerate(texts):
        toks = []
        for tok in tokenizer.tokenize(t):
            pos = tok.part_of_speech.split(',')
            reading = tok.reading if tok.reading != '*' else tok.surface
            toks.append({
                's': tok.surface,
                'b': tok.base_form if tok.base_form != '*' else tok.surface,
                'p': pos[0], 'p2': pos[1],
                'r': hira(reading),
            })
        out.append(toks)
        if i % 5000 == 0:
            print(f'  tokenised {i}/{len(texts)}')
    return out


# Function words / grammar that is fine inside an N5 sentence even though it is
# not a vocabulary card.
FUNCTION_LEMMAS = set('''
する いる ある なる できる くる 来る 行く いく です ます だ た ない ぬ ん の こと もの ところ よう そう
私 あなた 彼 彼女 これ それ あれ どれ ここ そこ あそこ どこ この その あの どの 人 方 さん くん ちゃん
何 なに なん 誰 だれ いつ どう どうして いくら いくつ 時 とき 日 月 年 円 回 分 たち ら
いい よい 見る 言う 思う もう まだ とても よく 少し ちょっと たくさん 一 二 三 四 五 六 七 八 九 十 百 千 万
'''.split())


# ---------------------------------------------------------------------------- look-alikes

STOP_EN = set("""a an the to of in on at for and or be is are was it its one's someone something
~ (e.g., etc.) etc e.g. counter for with by as from up out do does make very not no than that this
(abbr.) (to) sb sth thing things kind""".split())


def edit_distance(a, b):
    d = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        prev, d[0] = d[:], i
        for j, cb in enumerate(b, 1):
            d[j] = min(prev[j] + 1, d[j - 1] + 1, prev[j - 1] + (ca != cb))
    return d[-1]


def meaning_words(text):
    words = re.findall(r"[a-z']+", text.lower())
    return {w for w in words if len(w) > 2 and w not in STOP_EN}


def add_similar(words, characters, kanji_db, limit=6):
    """`sim`: ids of likely mix-ups, strongest first.

    Words: same kana (4), kana one edit apart (3), a shared N5 kanji (1.5),
    a shared content word in the English meaning (1). Sounding alike ranks first.
    Kanji: shared components (2 each) and a shared reading (1).
    """
    en = {w['id']: meaning_words(w['meaning']) for w in words}
    kanji_of = {w['id']: {c for c in w['written'] if is_kanji(c)} if 'kanji' in w['stages'] else set() for w in words}
    for w in words:
        scores = []
        for o in words:
            if o is w or o['written'] == w['written']:
                continue
            s = 0
            if o['kana'] == w['kana']:
                s += 4
            elif len(w['kana']) >= 2 and abs(len(o['kana']) - len(w['kana'])) <= 1 and edit_distance(w['kana'], o['kana']) == 1:
                s += 3  # sounds almost the same: the likeliest mix-up
            if kanji_of[w['id']] & kanji_of[o['id']]:
                s += 1.5
            if en[w['id']] & en[o['id']]:
                s += 1
            if s >= 1.5:
                scores.append((-s, o['rank'], o['id']))
        w['sim'] = [i for _, _, i in sorted(scores)[:limit]]
    for c in characters:
        rad = set(kanji_db[c['char']].get('wk_radicals') or [])
        readings = set(c['on']) | set(c['kun'])
        scores = []
        for o in characters:
            if o is c:
                continue
            orad = set(kanji_db[o['char']].get('wk_radicals') or [])
            s = 2 * len(rad & orad) + (1 if readings & (set(o['on']) | set(o['kun'])) else 0)
            if s >= 2:
                scores.append((-s, o['rank'], o['id']))
        c['sim'] = [i for _, _, i in sorted(scores)[:limit]]


def main():
    try:
        from janome.tokenizer import Tokenizer
    except ImportError:
        sys.exit('pip install janome')

    vocab_rows = list(csv.DictReader(open(fetch(VOCAB_URL, 'n5.csv'), encoding='utf-8')))
    kanji_db = json.load(open(fetch(KANJI_URL, 'kanji.json'), encoding='utf-8'))
    freq50k = {}
    for line in open(fetch(FREQ_URL, 'ja_50k.txt'), encoding='utf-8'):
        parts = line.split()
        if len(parts) == 2:
            freq50k[parts[0]] = int(parts[1])
    jm = json.load(open(fetch_jmdict_examples(), encoding='utf-8'))

    n5_kanji = [c for c, v in kanji_db.items() if v.get('jlpt_new') == 5]
    n5_kanji_set = set(n5_kanji)

    # ---------------------------------------------------------------- JMdict indexes
    usually_kana = set()          # (kanji, kana) pairs flagged "uk"
    for w in jm['words']:
        misc = set(m for s in w['sense'][:1] for m in s['misc'])
        if 'uk' in misc:
            for k in w['kanji']:
                for r in w['kana']:
                    usually_kana.add((k['text'], r['text']))

    # ---------------------------------------------------------------- sentence corpus
    corpus = {}
    for w in jm['words']:
        for s in w['sense']:
            for ex in s.get('examples', []):
                sid = ex['source']['value']
                if sid in corpus:
                    continue
                ja = next((x['text'] for x in ex['sentences'] if x['lang'] == 'jpn'), None)
                en = next((x['text'] for x in ex['sentences'] if x['lang'] == 'eng'), None)
                if ja and en:
                    corpus[sid] = (ja.strip(), en.strip())
    sids = sorted(corpus, key=int)
    print('corpus sentences:', len(sids))
    tokenizer = Tokenizer()
    tokens = tokenize_all(tokenizer, [corpus[s][0] for s in sids])

    # ---------------------------------------------------------------- characters
    char_count = Counter()
    for sid in sids:
        for c in corpus[sid][0]:
            if is_kana(c) or c in n5_kanji_set:
                char_count[c] += 1
    total_chars = sum(char_count.values())

    # every modern kana, plus the long-vowel mark
    hiragana = [chr(c) for c in range(ord('ぁ'), ord('ゖ') + 1)]
    hiragana = [c for c in hiragana if c not in 'ゐゑゔゕゖゎ']
    katakana = [hira_to_kata(c) for c in hiragana] + ['ヴ', 'ー']
    katakana = [c for c in katakana if c not in 'ヮ']

    def kana_romaji(c):
        if c in 'っッ':
            return 'small tsu (doubles next consonant)'
        if c == 'ー':
            return 'long vowel mark'
        r = to_romaji(c)
        if c in 'ぁぃぅぇぉゃゅょァィゥェォャュョ':
            return f'small {r}'
        return r

    def clean_kun(r):
        return r.replace('-', '').split('.')[0]

    characters = []
    for c in hiragana + katakana:
        characters.append({
            'id': 'c:' + c, 'kind': 'char', 'type': 'hiragana' if is_hiragana(c) else 'katakana',
            'char': c, 'romaji': kana_romaji(c), 'count': char_count[c],
        })
    # rank each kanji's readings by how many N5 words use them
    vocab_pairs = []
    for row in vocab_rows:
        for wr in split_variants(row['expression']):
            for rd in split_variants(row['reading'].replace('(する)', '').replace('(〜を)', '')):
                vocab_pairs.append((strip_affix(wr), strip_affix(rd)))

    def ranked_readings(c, k, on_set):
        cands = [hira(r) for r in k['readings_on']]
        kun_all = k['readings_kun']
        standalone = [r for r in kun_all if not r.startswith('-')]
        for r in (standalone or kun_all):
            cr = clean_kun(r)
            if cr and not cr.endswith('っ') and cr not in cands:
                cands.append(cr)
        cands = [r for r in cands if not r.endswith('っ')]

        def uses(r, wr, rd):
            # strip shared kana at both ends (okurigana / prefixes)
            while wr and rd and not is_kanji(wr[-1]) and wr[-1] == rd[-1]:
                wr, rd = wr[:-1], rd[:-1]
            while wr and rd and not is_kanji(wr[0]) and wr[0] == rd[0]:
                wr, rd = wr[1:], rd[1:]
            if c not in wr or not all(is_kanji(x) for x in wr):
                return False
            if wr == c:
                return rd == r
            if wr.startswith(c):
                return rd.startswith(r)
            if wr.endswith(c):
                return rd.endswith(r)
            return len(r) >= 2 and r in rd

        usage = {r: sum(1 for wr, rd in vocab_pairs if uses(r, wr, rd)) for r in cands}
        on_c = [r for r in cands if r in on_set]
        kun_c = [r for r in cands if r not in on_set]
        best = lambda lst: sorted(lst, key=lambda r: (-usage[r], cands.index(r)))
        picks = best(on_c)[:1] + best(kun_c)[:1]
        for r in best(cands):
            if len(picks) >= 3:
                break
            if usage[r] and r not in picks:
                picks.append(r)
        picks.sort(key=lambda r: (-usage[r], cands.index(r)))
        return picks, cands

    for c in n5_kanji:
        k = kanji_db[c]
        on_set = {hira(r) for r in k['readings_on']}
        readings, cands = ranked_readings(c, k, on_set)
        meanings = [m.lower() for m in k['meanings']
                    if not re.search(r'radical|sign of the|\d(am|pm)', m.lower())][:3]
        characters.append({
            'id': 'c:' + c, 'kind': 'char', 'type': 'kanji', 'char': c,
            'meanings': meanings,
            'on': [r for r in cands if r in on_set][:3],
            'kun': [r for r in cands if r not in on_set][:3],
            'kana': ', '.join(readings),
            'romaji': ', '.join(to_romaji(r) for r in readings),
            'strokes': k['strokes'], 'count': char_count[c],
        })
    # Kana are a reference chart only (learned through words); kanji are cards.
    for group in ('kana', 'kanji'):
        members = [c for c in characters if (c['type'] == 'kanji') == (group == 'kanji')]
        members.sort(key=lambda x: (-x['count'], x['type'] != 'hiragana', x['char']))
        for i, ch in enumerate(members):
            ch['rank'] = i + 1
            ch['freq'] = round(ch['count'] / total_chars * 1e6, 1)  # per million chars
    for ch in characters:
        del ch['count']
    kana_chart = sorted([c for c in characters if c['type'] != 'kanji'], key=lambda c: c['rank'])
    for c in kana_chart:
        del c['kind'], c['id']
    characters = sorted([c for c in characters if c['type'] == 'kanji'], key=lambda c: c['rank'])
    for ch in characters:
        # stages the card moves through as it is reviewed
        ch['stages'] = ['romaji', 'kana', 'kanji']

    char_ids = {c['char'] for c in characters}

    # ---------------------------------------------------------------- words
    words = []
    seen = set()
    for row in vocab_rows:
        written_all = split_variants(row['expression'])
        reading_raw = row['reading']
        is_suru = '(する)' in reading_raw
        reading_raw = reading_raw.replace('(する)', '').replace('(〜を)', '')
        readings_all = [strip_affix(r) for r in split_variants(reading_raw)]
        written = strip_affix(written_all[0])
        kana = readings_all[0]
        if not written or not kana:
            continue
        affix = '～' in row['expression'] or '〜' in row['expression']
        key = (written, kana)
        if key in seen:
            continue
        seen.add(key)
        has_kanji = any(is_kanji(c) for c in written)
        uk = (written, kana) in usually_kana
        all_n5 = has_kanji and all((not is_kanji(c)) or c in n5_kanji_set for c in written)
        if has_kanji and uk:
            stages = ['romaji', 'kana']
        elif all_n5:
            stages = ['romaji', 'kana', 'kanji']
        else:
            stages = ['romaji', 'kana']
        # kanji that must be known before the word is unlocked (none for kana words)
        req = []
        for c in (written if 'kanji' in stages else ''):
            if c in char_ids and c not in req:
                req.append(c)
        display = row['expression'].split(';')[0].strip().replace('〜', '～')
        entry = {
            'id': f'w:{len(words) + 1}', 'kind': 'word',
            'written': written, 'kana': kana, 'romaji': to_romaji(kana),
            'display': display if affix else written,
            'meaning': row['meaning'].strip(),
            'stages': stages, 'req': req,
        }
        alts = [strip_affix(w) for w in written_all[1:]] + readings_all[1:]
        if alts:
            entry['alt'] = alts
        if is_suru:
            entry['suru'] = True
        if has_kanji and 'kanji' not in stages:
            entry['kanjiNote'] = 'usually written in kana' if uk else 'kanji beyond N5'
        entry['_forms'] = {written, kana} | set(strip_affix(w) for w in written_all) | set(readings_all)
        entry['_affix'] = affix
        entry['_uk'] = uk
        entry['_has_kanji'] = has_kanji
        words.append(entry)
    print('words:', len(words))

    # ---------------------------------------------------------------- matching words in sentences
    n5_lemmas = set(FUNCTION_LEMMAS)
    for w in words:
        n5_lemmas |= w['_forms']
    allowed_kanji = set(n5_kanji_set)
    for w in words:
        allowed_kanji |= {c for c in w['written'] if is_kanji(c)}

    def all_kana(x):
        return all(is_kana(c) for c in x)

    # Homophones among "usually kana" words (居る/要る, 有る/在る) cannot be told
    # apart when written in kana; kana hits go to the word used most in kanji.
    kana_owner = {}
    preferred_owner = {'いる': '居る', 'ある': '在る'}
    written_count = Counter(w['written'] for w in words)

    def offsets_of(toks):
        pos, offs = 0, []
        for t in toks:
            offs.append(pos)
            pos += len(t['s'])
        return offs

    def find_spans(w, toks, ja):
        """Return (start, end, reading) spans in `ja` where word w occurs."""
        spans = []
        offs = offsets_of(toks)
        kana_forms = {hira(f) for f in w['_forms'] if all_kana(f)}
        for i, t in enumerate(toks):
            if t['p'] == '記号':
                continue
            if w['_affix']:
                if t['p'] != '名詞' or t['s'] not in w['_forms']:
                    continue
            elif t['p2'] in ('非自立', '接尾'):
                continue  # auxiliary いる in 〜ている, suffix 時 etc.
            if not (t['s'] in w['_forms'] or t['b'] in w['_forms']):
                continue
            if all_kana(t['s']) and all_kana(t['b']):
                # written in kana: only for kana words, or the owner of a "usually kana" reading
                if w['_has_kanji'] and not (w['_uk'] and kana_owner.get(w['kana'], w['id']) == w['id']):
                    continue
                if t['p'] in ('助詞', '助動詞') and t['s'] not in ('ね', 'よ'):
                    continue
            elif (t['s'] in w['_forms'] and hira(t['r']) not in kana_forms
                  and written_count[w['written']] > 1):
                # same kanji, different reading (一日 いちにち / ついたち)
                continue
            if t['p'] == '動詞' and i > 0 and toks[i - 1]['s'] in ('て', 'で') and w['kana'] in ('いる', 'ある', 'おく', 'みる', 'しまう', 'くる', 'いく'):
                continue  # auxiliary use: 〜ている, 〜てある ...
            # keep the tokenizer's reading when it is one of the word's readings
            # (七 なな / しち); otherwise trust the vocab list (一人 ひとり, not いちにん)
            reading = t['r'] if hira(t['r']) in kana_forms or t['s'] != w['written'] else w['kana']
            spans.append((offs[i], offs[i] + len(t['s']), reading))
        if not spans:
            # multi-token words (映画館, 月曜日 ...): substring on token boundaries,
            # checked against the reading of the covered tokens
            for form in (w['written'], w['kana']):
                if len(form) < 2 or (all_kana(form) and w['_has_kanji'] and not w['_uk']):
                    continue
                j = ja.find(form)
                if j < 0 or j not in offs or (j + len(form)) not in offs + [len(ja)]:
                    continue
                a, b = offs.index(j), (offs + [len(ja)]).index(j + len(form))
                if b - a < 2:
                    continue  # single tokens were handled above
                reading = ''.join(hira(t['r']) for t in toks[a:b])
                if reading in kana_forms or written_count[w['written']] == 1:
                    spans.append((j, j + len(form), w['kana'] if form == w['written'] else reading))
                    break
        return spans

    sentence_info = []
    for sid, toks in zip(sids, tokens):
        ja = corpus[sid][0]
        content = [t for t in toks if t['p'] not in ('助詞', '助動詞', '記号')
                   and t['p2'] not in ('数', '固有名詞', '非自立', '接尾')]
        unknown = [t['b'] for t in content if t['b'] not in n5_lemmas and t['s'] not in n5_lemmas]
        bad_kanji = [c for c in ja if is_kanji(c) and c not in allowed_kanji]
        sentence_info.append({
            'sid': sid, 'ja': ja, 'en': corpus[sid][1], 'toks': toks,
            'unknown': len(set(unknown)), 'badKanji': len(set(bad_kanji)),
            'ok': (not re.search(r'[A-Za-zＡ-Ｚａ-ｚ0-9０-９]', ja) and '「' not in ja
                   and '・' not in ja and len(ja) <= 40),
        })

    by_form = defaultdict(list)
    for w in words:
        for f in w['_forms']:
            by_form[f].append(w)
    substring_words = [w for w in words if len(w['written']) >= 2 or len(w['kana']) >= 2]

    def scan():
        counts, cands = Counter(), defaultdict(list)
        for si, info in enumerate(sentence_info):
            maybe = {}
            for t in info['toks']:
                for w in by_form.get(t['s'], []) + by_form.get(t['b'], []):
                    maybe[w['id']] = w
            for w in substring_words:
                if w['written'] in info['ja'] or w['kana'] in info['ja']:
                    maybe[w['id']] = w
            for w in maybe.values():
                spans = find_spans(w, info['toks'], info['ja'])
                if spans:
                    counts[w['id']] += len(spans)
                    if info['ok']:
                        cands[w['id']].append((si, spans[0]))
        return counts, cands

    # pass 1: count kanji-written hits of "usually kana" homophones to pick owners
    for w in words:
        if w['_uk']:
            kana_owner[w['kana']] = None
    first, _ = scan()
    groups = defaultdict(list)
    for w in words:
        if w['_uk']:
            groups[w['kana']].append(w)
    for kana, ws in groups.items():
        pref = [w for w in ws if w['written'] == preferred_owner.get(kana)]
        kana_owner[kana] = (pref or [max(ws, key=lambda w: first[w['id']])])[0]['id']
    word_count, candidates = scan()

    # ---------------------------------------------------------------- word frequency
    total_tok = sum(len(t) for t in tokens)
    total_50k = sum(freq50k.values())
    for w in words:
        corp = word_count[w['id']] / total_tok * 1e6
        sub_forms = [w['written']] + ([w['kana']] if (not w['_has_kanji'] or
                                                        kana_owner.get(w['kana']) == w['id']) else [])
        sub = max(freq50k.get(f, 0) for f in sub_forms) / total_50k * 1e6
        w['freq'] = round(math.sqrt(corp * sub) if corp and sub else (corp or sub) * 0.5, 2)
    words.sort(key=lambda w: -w['freq'])
    for i, w in enumerate(words):
        w['rank'] = i + 1

    # ---------------------------------------------------------------- sentence selection
    use = Counter()
    chosen = {}
    # rarest-first so words with few candidates get first pick
    for w in sorted(words, key=lambda w: len(candidates[w['id']])):
        cands = candidates[w['id']]
        scored = []
        for si, span in cands:
            info = sentence_info[si]
            score = info['unknown'] * 12 + info['badKanji'] * 8 + len(info['ja']) * 0.4 + use[si] * 6
            if len(info['ja']) < 6:
                score += 10  # too short to give context
            scored.append((score, si, span))
        scored.sort()
        picks, seen_ja = [], set()
        # difficulty tiers: (max unknown words, max non-N5 kanji, max length)
        for max_unk, max_bad, max_len in TIERS:
            for score, si, span in scored:
                info = sentence_info[si]
                if (info['unknown'] > max_unk or info['badKanji'] > max_bad
                        or len(info['ja']) > max_len or use[si] >= MAX_SENTENCE_REUSE):
                    continue
                if si in [p[0] for p in picks] or info['ja'][:-1] in seen_ja:
                    continue
                picks.append((si, span))
                seen_ja.add(info['ja'][:-1])
                if len(picks) >= SENTENCES_PER_WORD[1]:
                    break
            if len(picks) >= SENTENCES_PER_WORD[0]:
                break
        for si, _ in picks:
            use[si] += 1
        chosen[w['id']] = picks

    grammar = json.load(open(os.path.join(HERE, 'grammar_n5.json'), encoding='utf-8'))
    particle_ids = {'wa': 'は', 'ga': 'が', 'wo': 'を', 'ni': 'に', 'e': 'へ', 'de': 'で',
                    'to-and': 'と', 'mo': 'も', 'no': 'の', 'ka': 'か'}

    def grammar_tags(info):
        tags = []
        ja = info['ja']
        for g in grammar:
            if g['id'] in particle_ids:
                p = particle_ids[g['id']]
                if any(t['s'] == p and t['p'] == '助詞' for t in info['toks']):
                    tags.append(g['id'])
            elif re.search(g['match'], ja):
                tags.append(g['id'])
        return tags

    sentences = {}
    for w in words:
        refs = []
        for si, (a, b, r) in chosen[w['id']]:
            info = sentence_info[si]
            sid = 's:' + info['sid']
            if sid not in sentences:
                toks = []
                for t in info['toks']:
                    if any(is_kanji(c) for c in t['s']):
                        toks.append([t['s'], t['r']])
                    else:
                        toks.append([t['s']])
                sentences[sid] = {'id': sid, 'ja': info['ja'], 'en': info['en'],
                                  't': toks, 'g': grammar_tags(info)}
            refs.append({'s': sid, 'a': [a, b], 'r': hira(r)})
        w['sentences'] = refs
        for k in [k for k in w if k.startswith('_')]:
            del w[k]

    add_similar(words, characters, kanji_db)

    counts = Counter(len(w['sentences']) for w in words)
    print('sentences per word:', sorted(counts.items()))
    print('unique sentences:', len(sentences))

    for g in grammar:
        g['sentenceCount'] = sum(1 for s in sentences.values() if g['id'] in s['g'])

    # ---------------------------------------------------------------- write
    os.makedirs(OUT, exist_ok=True)

    def dump(name, obj):
        with open(os.path.join(OUT, name), 'w', encoding='utf-8') as f:
            json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))
        print('wrote', name, os.path.getsize(os.path.join(OUT, name)) // 1024, 'KB')

    dump('characters.json', characters)
    dump('kana.json', kana_chart)
    dump('words.json', words)
    dump('sentences.json', sorted(sentences.values(), key=lambda s: int(s['id'][2:])))
    dump('grammar.json', grammar)
    dump('meta.json', {
        'level': 'N5', 'version': jm.get('dictDate', ''),
        'counts': {'characters': len(characters), 'kana': len(kana_chart), 'kanji': len(n5_kanji), 'words': len(words),
                   'sentences': len(sentences), 'grammar': len(grammar)},
        'sources': [
            {'name': 'JLPT N5 vocabulary (open-anki-jlpt-decks)', 'license': 'MIT',
             'url': 'https://github.com/jamsinclair/open-anki-jlpt-decks'},
            {'name': 'Kanji data (KANJIDIC2 via kanji-data)', 'license': 'CC BY-SA 4.0',
             'url': 'https://github.com/davidluzgouveia/kanji-data'},
            {'name': 'Tatoeba / Tanaka Corpus sentences (via jmdict-simplified)', 'license': 'CC BY 2.0 FR',
             'url': 'https://tatoeba.org'},
            {'name': 'Word frequency (FrequencyWords, OpenSubtitles 2016)', 'license': 'CC BY-SA 4.0',
             'url': 'https://github.com/hermitdave/FrequencyWords'},
        ],
    })


if __name__ == '__main__':
    main()
