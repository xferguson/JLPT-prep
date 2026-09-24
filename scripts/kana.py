"""Kana <-> romaji helpers shared by the data build scripts.

Romanization is "wapuro" Hepburn (the style people type on a keyboard):
long vowels are written out (とうきょう -> toukyou, コーヒー -> koohii),
っ doubles the next consonant, and ん before a vowel/y becomes n'.
The same rules are implemented in js/kana.js for the app.
"""

BASE = {
    'あ': 'a', 'い': 'i', 'う': 'u', 'え': 'e', 'お': 'o',
    'か': 'ka', 'き': 'ki', 'く': 'ku', 'け': 'ke', 'こ': 'ko',
    'が': 'ga', 'ぎ': 'gi', 'ぐ': 'gu', 'げ': 'ge', 'ご': 'go',
    'さ': 'sa', 'し': 'shi', 'す': 'su', 'せ': 'se', 'そ': 'so',
    'ざ': 'za', 'じ': 'ji', 'ず': 'zu', 'ぜ': 'ze', 'ぞ': 'zo',
    'た': 'ta', 'ち': 'chi', 'つ': 'tsu', 'て': 'te', 'と': 'to',
    'だ': 'da', 'ぢ': 'ji', 'づ': 'zu', 'で': 'de', 'ど': 'do',
    'な': 'na', 'に': 'ni', 'ぬ': 'nu', 'ね': 'ne', 'の': 'no',
    'は': 'ha', 'ひ': 'hi', 'ふ': 'fu', 'へ': 'he', 'ほ': 'ho',
    'ば': 'ba', 'び': 'bi', 'ぶ': 'bu', 'べ': 'be', 'ぼ': 'bo',
    'ぱ': 'pa', 'ぴ': 'pi', 'ぷ': 'pu', 'ぺ': 'pe', 'ぽ': 'po',
    'ま': 'ma', 'み': 'mi', 'む': 'mu', 'め': 'me', 'も': 'mo',
    'や': 'ya', 'ゆ': 'yu', 'よ': 'yo',
    'ら': 'ra', 'り': 'ri', 'る': 'ru', 'れ': 're', 'ろ': 'ro',
    'わ': 'wa', 'を': 'wo', 'ん': 'n',
    'ゔ': 'vu',
    # small kana on their own
    'ぁ': 'a', 'ぃ': 'i', 'ぅ': 'u', 'ぇ': 'e', 'ぉ': 'o',
    'ゃ': 'ya', 'ゅ': 'yu', 'ょ': 'yo', 'ゎ': 'wa',
}

# Two-kana combinations (yōon and loanword extensions).
DIGRAPHS = {}
for head, root in [('き', 'k'), ('ぎ', 'g'), ('に', 'n'), ('ひ', 'h'), ('び', 'b'),
                   ('ぴ', 'p'), ('み', 'm'), ('り', 'r')]:
    DIGRAPHS[head + 'ゃ'] = root + 'ya'
    DIGRAPHS[head + 'ゅ'] = root + 'yu'
    DIGRAPHS[head + 'ょ'] = root + 'yo'
for head, root in [('し', 'sh'), ('じ', 'j'), ('ち', 'ch'), ('ぢ', 'j')]:
    DIGRAPHS[head + 'ゃ'] = root + 'a'
    DIGRAPHS[head + 'ゅ'] = root + 'u'
    DIGRAPHS[head + 'ょ'] = root + 'o'
DIGRAPHS.update({
    'しぇ': 'she', 'じぇ': 'je', 'ちぇ': 'che',
    'てぃ': 'ti', 'でぃ': 'di', 'とぅ': 'tu', 'どぅ': 'du',
    'ふぁ': 'fa', 'ふぃ': 'fi', 'ふぇ': 'fe', 'ふぉ': 'fo',
    'うぃ': 'wi', 'うぇ': 'we', 'うぉ': 'wo',
    'ゔぁ': 'va', 'ゔぃ': 'vi', 'ゔぇ': 've', 'ゔぉ': 'vo',
    'つぁ': 'tsa', 'つぇ': 'tse', 'つぉ': 'tso',
})


def kata_to_hira(s):
    return ''.join(chr(ord(c) - 0x60) if 'ァ' <= c <= 'ヶ' else c for c in s)


def hira_to_kata(s):
    return ''.join(chr(ord(c) + 0x60) if 'ぁ' <= c <= 'ゖ' else c for c in s)


def is_hiragana(c):
    return 'ぁ' <= c <= 'ゖ'


def is_katakana(c):
    return 'ァ' <= c <= 'ヶ' or c == 'ー'


def is_kana(c):
    return is_hiragana(c) or is_katakana(c)


def is_kanji(c):
    return '一' <= c <= '鿿' or c == '々'


def to_romaji(text):
    s = kata_to_hira(text)
    out = []
    i = 0
    while i < len(s):
        pair = s[i:i + 2]
        ch = s[i]
        if ch == 'っ':
            # double the first consonant of what follows
            nxt = DIGRAPHS.get(s[i + 1:i + 3]) or BASE.get(s[i + 1:i + 2], '')
            if nxt.startswith('ch'):
                out.append('t')
            elif nxt and nxt[0] not in 'aiueon':
                out.append(nxt[0])
            else:
                out.append('')  # sokuon at end of word / before vowel: drop
            i += 1
            continue
        if ch == 'ー':
            prev = ''.join(out)
            out.append(prev[-1] if prev and prev[-1] in 'aiueo' else '-')
            i += 1
            continue
        if ch == 'ん':
            nxt = s[i + 1:i + 2]
            out.append("n'" if nxt and (nxt in 'あいうえおやゆよ') else 'n')
            i += 1
            continue
        if pair in DIGRAPHS:
            out.append(DIGRAPHS[pair])
            i += 2
            continue
        out.append(BASE.get(ch, ch))
        i += 1
    return ''.join(out)
