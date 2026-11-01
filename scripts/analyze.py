"""
analyze.py -- one-shot song analysis for a text-only model.

Produces:
  01_lyrics.txt        timestamped transcript (lyrics + timeline)
  02_transcript.json   raw segments from whisper
  03_features.csv      per-frame RMS / spectral centroid / onset strength
  04_energy.png        waveform + loudness curve + brightness curve + section marks
  05_summary.json      tempo, key guess, energy stats, sections, colour words
  00_summary.md        human-readable digest

Usage:
  python analyze.py "<audio file>" --model small --lang zh
"""

import argparse
import json
import os
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import numpy as np
import librosa
import librosa.display
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

try:
    import opencc
    _CC = opencc.OpenCC("t2s")
except Exception:
    _CC = None

# ---------------------------------------------------------------- key profiles
# Krumhansl-Kessler profiles
MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
NOTES_ZH = ["C", "升C", "D", "升D", "E", "F", "升F", "G", "升G", "A", "升A", "B"]


def estimate_key(chroma_mean):
    best = (-2.0, None)
    for i in range(12):
        rotated = np.roll(chroma_mean, -i)
        for prof, mode in ((MAJOR, "major"), (MINOR, "minor")):
            r = np.corrcoef(rotated, prof)[0, 1]
            if r > best[0]:
                best = (r, (NOTES[i], mode))
    return best[1], float(best[0])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--out", default=None)
    ap.add_argument("--model", default="small")
    ap.add_argument("--lang", default="auto", help="zh / en / ja / ... or auto")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--skip-whisper", action="store_true")
    ap.add_argument("--vad", action="store_true", help="enable VAD (good for speech, bad for singing)")
    args = ap.parse_args()

    src = Path(args.audio).expanduser().resolve()
    if not src.exists():
        sys.exit(f"audio not found: {src}")

    out = Path(args.out) if args.out else src.parent / (src.stem + "_analysis")
    out.mkdir(parents=True, exist_ok=True)
    print(f"[1/6] loading {src.name}")
    y, sr = librosa.load(str(src), sr=22050, mono=True)
    dur = librosa.get_duration(y=y, sr=sr)
    print(f"      {dur:.1f}s  sr={sr}")

    hop = 512
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=hop)[0]
    cent = librosa.feature.spectral_centroid(y=y, sr=sr, hop_length=hop)[0]
    rolloff = librosa.feature.spectral_rolloff(y=y, sr=sr, hop_length=hop)[0]
    onset = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    times = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=hop)

    # tempo
    tempo, beats = librosa.beat.beat_track(onset_envelope=onset, sr=sr, hop_length=hop)
    tempo = float(np.atleast_1d(tempo)[0])

    # key
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop)
    (key_note, key_mode), key_corr = estimate_key(chroma.mean(axis=1))

    # energy in dB, relative
    eps = 1e-9
    rms_db = 20 * np.log10(np.maximum(rms, eps))
    rms_db_norm = rms_db - rms_db.max()  # 0 = loudest point

    # ---------------------------------------------------------- coarse sections
    # average over ~5s windows, then classify by percentile
    win = max(1, int(round(5.0 * sr / hop)))
    nwin = int(np.ceil(len(rms) / win))
    win_db = np.array([rms_db[i * win:(i + 1) * win].mean() for i in range(nwin)])
    win_t = np.array([(i * win + win / 2) * hop / sr for i in range(nwin)])

    lo, hi = np.percentile(win_db, 25), np.percentile(win_db, 80)
    labels = []
    for v in win_db:
        if v < lo:
            labels.append("quiet")
        elif v > hi:
            labels.append("loud")
        else:
            labels.append("mid")

    sections = []
    cur, start = labels[0], win_t[0]
    for i in range(1, len(labels)):
        if labels[i] != cur:
            sections.append({"kind": cur, "start": round(float(start), 1),
                             "end": round(float(win_t[i]), 1)})
            cur, start = labels[i], win_t[i]
    sections.append({"kind": cur, "start": round(float(start), 1), "end": round(float(dur), 1)})
    sections = [s for s in sections if s["end"] - s["start"] >= 3]

    # ------------------------------------------------------------- transcription
    segments = []
    info = {}
    if not args.skip_whisper:
        print(f"[2/6] transcribing with faster-whisper '{args.model}' (lang={args.lang}) ...")
        from faster_whisper import WhisperModel
        model = WhisperModel(args.model, device=args.device, compute_type="int8")
        # Decode ourselves: PyAV 19 dropped the kwarg faster-whisper 1.2.1 passes,
        # so hand it a plain 16 kHz mono float32 array instead of a path.
        y16, _ = librosa.load(str(src), sr=16000, mono=True)
        lang = None if str(args.lang).lower() in ("auto", "") else args.lang
        it, info = model.transcribe(
            y16,
            language=lang,
            beam_size=5,
            vad_filter=args.vad,
            vad_parameters=dict(min_silence_duration_ms=500) if args.vad else None,
            condition_on_previous_text=False,
            no_speech_threshold=0.6,
            log_prob_threshold=-1.0,
            compression_ratio_threshold=2.4,
        )
        for s in it:
            text = s.text.strip()
            if text:
                if _CC is not None:
                    text = _CC.convert(text)
                segments.append({"start": round(s.start, 2), "end": round(s.end, 2), "text": text})
                print(f"      {s.start:7.1f}s  {text}")
        print(f"      {len(segments)} segments")

        # collapse runs of identical consecutive lines (whisper loops on instrumental drops)
        deduped = []
        for seg in segments:
            if deduped and deduped[-1]["text"] == seg["text"]:
                deduped[-1]["end"] = seg["end"]
                deduped[-1]["repeats"] = deduped[-1].get("repeats", 1) + 1
                continue
            deduped.append(seg)
        if len(deduped) != len(segments):
            print(f"      collapsed duplicates: {len(segments)} -> {len(deduped)} lines")
        segments = deduped
    else:
        print("[2/6] whisper skipped")

    # ------------------------------------------------------------------- output
    print("[3/6] writing files")

    with open(out / "02_transcript.json", "w", encoding="utf-8") as f:
        json.dump({"info": {"language": getattr(info, "language", None),
                            "language_probability": float(getattr(info, "language_probability", 0) or 0),
                            "duration": dur},
                   "segments": segments}, f, ensure_ascii=False, indent=2)

    with open(out / "01_lyrics.txt", "w", encoding="utf-8") as f:
        f.write(f"# {src.name}\n# duration {dur:.1f}s  key {key_note} {key_mode}  tempo {tempo:.0f} bpm\n\n")
        for s in segments:
            m, sec = divmod(int(s["start"]), 60)
            f.write(f"[{m:02d}:{sec:02d}] {s['text']}\n")
        if not segments:
            f.write("(no lyrics detected)\n")

    with open(out / "03_features.csv", "w", encoding="utf-8") as f:
        f.write("t_sec,rms,rms_db,centroid_hz,rolloff_hz,onset\n")
        for i in range(len(rms)):
            f.write(f"{times[i]:.3f},{rms[i]:.6f},{rms_db[i]:.2f},{cent[i]:.1f},{rolloff[i]:.1f},{onset[min(i, len(onset)-1)]:.4f}\n")

    # plots
    print("[4/6] plotting")
    try:
        plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei", "DejaVu Sans"]
        plt.rcParams["axes.unicode_minus"] = False
    except Exception:
        pass

    fig, axes = plt.subplots(3, 1, figsize=(14, 9), sharex=True,
                             gridspec_kw={"height_ratios": [2, 1, 1]})
    t_axis = np.arange(len(y)) / sr
    axes[0].plot(t_axis, y, linewidth=0.2, color="#4a7ebb")
    axes[0].set_ylabel("waveform")
    axes[0].set_title(f"{src.name}   {dur:.1f}s")

    axes[1].plot(times, rms_db_norm, color="#c0392b", linewidth=0.8)
    axes[1].set_ylabel("loudness (dB rel.)")
    axes[1].set_ylim(-60, 2)
    axes[1].axhline(-20, color="gray", linestyle=":", linewidth=0.6)

    axes[2].plot(times, cent, color="#27ae60", linewidth=0.8)
    axes[2].set_ylabel("brightness (Hz)")
    axes[2].set_xlabel("time (s)")

    for ax in axes:
        for s in sections:
            if s["kind"] == "loud":
                ax.axvspan(s["start"], s["end"], color="orange", alpha=0.10)
            elif s["kind"] == "quiet":
                ax.axvspan(s["start"], s["end"], color="blue", alpha=0.06)

    fig.tight_layout()
    fig.savefig(out / "04_energy.png", dpi=110)
    plt.close(fig)

    # ---------------------------------------------------------------- summary
    brightness = float(np.mean(cent))
    bright_word = "明亮/偏尖锐" if brightness > 2600 else ("偏暗/温暖" if brightness < 1500 else "中等")
    mode_word = "大调（偏明朗）" if key_mode == "major" else "小调（偏忧郁）"

    total_lyrics = sum(len(s["text"]) for s in segments)
    sing_ratio = float(np.sum([s["end"] - s["start"] for s in segments]) / dur) if dur else 0

    summary = {
        "file": src.name,
        "duration_sec": round(dur, 1),
        "tempo_bpm": round(tempo, 1),
        "key_guess": f"{key_note} {key_mode}",
        "key_correlation": round(key_corr, 3),
        "brightness_hz_mean": round(brightness, 1),
        "brightness_word": bright_word,
        "mode_word": mode_word,
        "loudness_db_range": [round(float(np.percentile(rms_db_norm, 5)), 1),
                              round(float(np.percentile(rms_db_norm, 95)), 1)],
        "lyrics_char_count": total_lyrics,
        "vocal_time_ratio": round(sing_ratio, 2),
        "sections": sections,
        "segments_count": len(segments),
    }
    with open(out / "05_summary.json", "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    # ------------------------------------------------------------------ markdown
    print("[5/6] writing 00_summary.md")
    L = []
    L.append(f"# {src.name}\n")
    L.append(f"- 时长：**{dur/60:.1f} 分**（{dur:.0f} 秒）")
    L.append(f"- 速度：**{tempo:.0f} BPM**")
    L.append(f"- 调性（估算）：**{key_note} {key_mode}**（相关系数 {key_corr:.2f}）→ {mode_word}")
    L.append(f"- 音色亮度：**{brightness:.0f} Hz**（{bright_word}）")
    lo_d, hi_d = summary["loudness_db_range"]
    L.append(f"- 动态范围：{lo_d} dB ～ {hi_d} dB（相对最响处）")
    L.append(f"- 人声占比：约 **{sing_ratio*100:.0f}%** 时长检测到人声")
    L.append(f"- 歌词字数：约 {total_lyrics} 字，{len(segments)} 句\n")

    L.append("## 段落结构（按响度自动切分）\n")
    for s in sections:
        kind = {"quiet": "安静 / 稀疏", "mid": "中等 / 铺陈", "loud": "饱满 / 高潮"}[s["kind"]]
        mm1, ss1 = divmod(int(s["start"]), 60)
        mm2, ss2 = divmod(int(s["end"]), 60)
        L.append(f"- `{mm1:02d}:{ss1:02d}` → `{mm2:02d}:{ss2:02d}`　{kind}")

    L.append("\n## 歌词与时间轴\n")
    for s in segments:
        mm, ss = divmod(int(s["start"]), 60)
        L.append(f"`{mm:02d}:{ss:02d}`　{s['text']}")
    if not segments:
        L.append("（未识别到人声/歌词）")

    with open(out / "00_summary.md", "w", encoding="utf-8") as f:
        f.write("\n".join(L))

    print(f"[6/6] done -> {out}\n")
    print("\n".join(L[:20]))


if __name__ == "__main__":
    main()
