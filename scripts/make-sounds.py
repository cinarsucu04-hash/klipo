#!/usr/bin/env python3
"""Telifsiz hazır sesleri (basit döngüler) üretir: public/sounds/*.mp3  (numpy + ffmpeg gerekir)."""
import numpy as np, subprocess, wave, os, tempfile
SR = 32000
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'sounds')
os.makedirs(OUT, exist_ok=True)
rng = np.random.default_rng(7)

def hz(n): return 440.0 * 2 ** ((n - 69) / 12)
def env(n, a=0.005, d=0.2):
    t = np.arange(n) / SR
    return np.minimum(1, t / a) * np.exp(-t / d)
def sine(f, dur, d=0.25, a=0.005, harm=()):
    n = int(SR * dur); t = np.arange(n) / SR
    x = np.sin(2 * np.pi * f * t)
    for k, g in harm: x = x + g * np.sin(2 * np.pi * f * k * t)
    return x * env(n, a, d)
def saw(f, dur, d=0.3, a=0.01):
    n = int(SR * dur); t = np.arange(n) / SR
    x = 2 * ((f * t) % 1) - 1
    return x * env(n, a, d)
def kick(dur=0.35):
    n = int(SR * dur); t = np.arange(n) / SR
    f = 110 * np.exp(-t * 18) + 42
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 9)
def snare(dur=0.2):
    n = int(SR * dur); t = np.arange(n) / SR
    return (rng.standard_normal(n) * 0.7 + np.sin(2 * np.pi * 190 * t) * 0.4) * np.exp(-t * 22)
def hat(dur=0.05, open_=False):
    n = int(SR * (0.22 if open_ else dur)); t = np.arange(n) / SR
    x = np.diff(rng.standard_normal(n + 1))
    return x * np.exp(-t * (14 if open_ else 70))
def bass808(f, dur):
    n = int(SR * dur); t = np.arange(n) / SR
    return np.sin(2 * np.pi * f * t * (1 + 0.04 * np.exp(-t * 20))) * np.exp(-t * 2.2) * np.minimum(1, t / 0.004)

class Track:
    def __init__(self, bpm, bars):
        self.bpm = bpm; self.beat = 60 / bpm
        self.n = int(SR * self.beat * 4 * bars)
        self.buf = np.zeros(self.n)
    def put(self, sound, beat_pos, gain=1.0):
        i = int(SR * self.beat * beat_pos)
        if i >= self.n: return
        s = sound[: self.n - i]
        self.buf[i : i + len(s)] += s * gain
    def done(self):
        x = self.buf.copy()
        x = np.tanh(x * 0.9)
        # döngü dikişi: son 40 ms'de yumuşak geçiş
        f = int(SR * 0.04); x[-f:] *= np.linspace(1, 0, f)
        return (x / max(1e-6, np.abs(x).max()) * 0.85).astype(np.float32)

def render(name, x):
    with tempfile.TemporaryDirectory() as d:
        w = os.path.join(d, 'a.wav')
        with wave.open(w, 'wb') as f:
            f.setnchannels(1); f.setsampwidth(2); f.setframerate(SR)
            f.writeframes((x * 32767).astype('<i2').tobytes())
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', w, '-codec:a', 'libmp3lame', '-b:a', '56k', os.path.join(OUT, name)], check=True)
    print('✓', name, round(len(x) / SR, 1), 'sn')

def neon():
    t = Track(100, 10)  # 10 ölçü ≈ 24 sn
    prog = [45, 41, 48, 43]  # Am F C G kökleri
    for bar in range(10):
        root = prog[bar % 4]
        for b in range(4):
            t.put(kick(), bar * 4 + b, 0.9)
            t.put(hat(), bar * 4 + b + 0.5, 0.25)
        t.put(snare(), bar * 4 + 1, 0.5); t.put(snare(), bar * 4 + 3, 0.5)
        for s in range(8):
            note = root + [0, 12, 7, 12, 0, 12, 7, 19][s]
            t.put(saw(hz(note), 0.22, 0.12), bar * 4 + s * 0.5, 0.28)
        for k in (0, 4, 7):
            t.put(saw(hz(root + 24 + k), 1.9, 1.4, 0.2), bar * 4, 0.07)
    return t.done()

def lofi():
    t = Track(80, 8)  # 8 ölçü = 24 sn
    chords = [[57, 60, 64, 67], [53, 57, 60, 64], [48, 52, 55, 59], [55, 59, 62, 65]]
    for bar in range(8):
        for k in chords[bar % 4]:
            t.put(sine(hz(k), 2.6, 1.0, 0.01, ((2, 0.4), (3, 0.15))), bar * 4, 0.16)
            t.put(sine(hz(k), 1.2, 0.6, 0.01, ((2, 0.4),)), bar * 4 + 2, 0.12)
        t.put(kick(), bar * 4, 0.8); t.put(kick(), bar * 4 + 2.5, 0.6)
        t.put(snare(), bar * 4 + 1, 0.4); t.put(snare(), bar * 4 + 3, 0.4)
        for s in range(8): t.put(hat(), bar * 4 + s * 0.5, 0.18 if s % 2 else 0.12)
        t.put(sine(hz(chords[bar % 4][0] - 24), 1.8, 0.8), bar * 4, 0.35)
    t.buf += rng.standard_normal(t.n) * 0.004
    return t.done()

def dance():
    t = Track(128, 12)  # 12 ölçü ≈ 22.5 sn
    roots = [45, 45, 43, 41]
    for bar in range(12):
        for b in range(4):
            t.put(kick(), bar * 4 + b, 1.0)
            t.put(hat(open_=True), bar * 4 + b + 0.5, 0.3)
        t.put(snare(), bar * 4 + 1, 0.5); t.put(snare(), bar * 4 + 3, 0.5)
        for s in range(16):
            t.put(hat(), bar * 4 + s * 0.25, 0.12)
        for s in range(8):
            t.put(saw(hz(roots[bar % 4] + (12 if s % 2 else 0)), 0.2, 0.08), bar * 4 + s * 0.5 + 0.25, 0.3)
        if bar % 2 == 1:
            for k in (0, 3, 7): t.put(saw(hz(roots[bar % 4] + 24 + k), 0.4, 0.2), bar * 4 + 3, 0.12)
    return t.done()

def trap():
    t = Track(140, 11)  # ≈ 18.9 sn
    roots = [33, 33, 36, 31]
    for bar in range(11):
        t.put(bass808(hz(roots[bar % 4]), 1.6), bar * 4, 1.0)
        t.put(bass808(hz(roots[bar % 4] + 5), 0.7), bar * 4 + 2.5, 0.8)
        t.put(kick(), bar * 4, 0.6); t.put(kick(), bar * 4 + 2.75, 0.5)
        t.put(snare(), bar * 4 + 2, 0.9)
        for s in range(8): t.put(hat(), bar * 4 + s * 0.5, 0.25)
        for s in range(6): t.put(hat(), bar * 4 + 3 + s * (1 / 6) * 1, 0.2)
        for k in (0, 3, 7, 10):
            t.put(sine(hz(roots[bar % 4] + 36 + k), 0.9, 0.5, 0.01, ((2, 0.3),)), bar * 4 + (0 if bar % 2 == 0 else 1), 0.07)
    return t.done()

def smile():
    t = Track(110, 10)  # ≈ 21.8 sn
    pent = [72, 74, 76, 79, 81, 84]
    pattern = [0, 2, 4, 2, 3, 1, 2, 0]
    for bar in range(10):
        shift = [0, 0, -2, -2][bar % 4]
        for s, p in enumerate(pattern):
            t.put(sine(hz(pent[p] + shift), 0.5, 0.18, 0.003, ((2, 0.5), (4, 0.2))), bar * 4 + s * 0.5, 0.3)
        t.put(kick(), bar * 4, 0.6); t.put(kick(), bar * 4 + 2, 0.5)
        t.put(snare(0.12), bar * 4 + 1, 0.35); t.put(snare(0.12), bar * 4 + 3, 0.35)
        for s in range(4): t.put(hat(), bar * 4 + s + 0.5, 0.2)
        t.put(sine(hz(48 + shift), 1.6, 0.9), bar * 4, 0.35)
    return t.done()

for fn, name in ((neon, 'neon-gece.mp3'), (lofi, 'lofi-kahve.mp3'), (dance, 'hizli-akis.mp3'), (trap, 'trap-golge.mp3'), (smile, 'gulumse.mp3')):
    render(name, fn())
