#!/usr/bin/env python3
"""Render the PWA icons (needs Pillow and a Japanese font such as IPAGothic)."""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

FONT = sys.argv[1] if len(sys.argv) > 1 else '/usr/share/fonts/truetype/fonts-japanese-gothic.ttf'
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'icons')
BG, FG, ACCENT = (190, 30, 45), (255, 255, 255), (255, 214, 214)


def icon(size, maskable=False):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:
        d.rectangle([0, 0, size, size], fill=BG)
    else:
        d.rounded_rectangle([0, 0, size - 1, size - 1], radius=size // 5, fill=BG)
    scale = 0.62 if maskable else 0.72
    font = ImageFont.truetype(FONT, int(size * scale * 0.8))
    text = '日'
    box = d.textbbox((0, 0), text, font=font)
    w, h = box[2] - box[0], box[3] - box[1]
    d.text(((size - w) / 2 - box[0], (size - h) / 2 - box[1] - size * 0.05), text, font=font, fill=FG)
    small = ImageFont.truetype(FONT, int(size * 0.14))
    label = 'N5'
    box = d.textbbox((0, 0), label, font=small)
    w = box[2] - box[0]
    y = size * (0.78 if maskable else 0.8)
    d.text(((size - w) / 2 - box[0], y - box[1]), label, font=small, fill=ACCENT)
    return img


os.makedirs(OUT, exist_ok=True)
for s in (192, 512):
    icon(s).save(os.path.join(OUT, f'icon-{s}.png'))
icon(512, maskable=True).save(os.path.join(OUT, 'maskable-512.png'))
icon(180, maskable=True).convert('RGB').save(os.path.join(OUT, 'apple-touch-icon.png'))
print('icons written to', OUT)
