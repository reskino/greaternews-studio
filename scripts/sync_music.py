"""Regenerate public/music/tracks.json from the audio files in public/music/.

Drop your royalty-free tracks (mp3/m4a/ogg/wav) into public/music/, then run:
    python scripts/sync_music.py
It writes tracks.json listing every track, with a readable label derived from the
file name (e.g. "afro-groove.mp3" -> "Afro Groove"). Edit the labels afterwards if
you want. Then commit + push (git add public/music && git commit && git push).
"""

import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MUSIC_DIR = os.path.join(ROOT, "public", "music")
EXTS = {".mp3", ".m4a", ".ogg", ".wav", ".aac", ".flac"}


def label_for(filename):
    stem = os.path.splitext(filename)[0]
    words = stem.replace("_", " ").replace("-", " ").split()
    return " ".join(word.capitalize() for word in words) or filename


def main():
    if not os.path.isdir(MUSIC_DIR):
        print(f"No music dir at {MUSIC_DIR}")
        return
    files = sorted(f for f in os.listdir(MUSIC_DIR) if os.path.splitext(f)[1].lower() in EXTS)
    tracks = [{"file": f, "label": label_for(f)} for f in files]
    out = os.path.join(MUSIC_DIR, "tracks.json")
    with open(out, "w", encoding="utf-8") as handle:
        json.dump(tracks, handle, indent=2)
        handle.write("\n")
    if tracks:
        print(f"Wrote {len(tracks)} track(s) to tracks.json:")
        for track in tracks:
            print(f"  - {track['file']}  ->  {track['label']}")
        print("\nNow: git add public/music && git commit -m 'add music' && git push")
    else:
        print("No audio files found in public/music/ — drop some mp3/m4a/ogg/wav files there first.")


if __name__ == "__main__":
    main()
