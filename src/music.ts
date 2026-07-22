// Optional user-provided music tracks. Drop audio files in public/music/ and list them in
// public/music/tracks.json ([{ file, label }]); they show up as selectable video sounds and are
// mixed under the voiceover. Served from the app's own origin, so no CORS issues.
export type MusicTrack = { id: string; label: string; url: string };

// A sound value of `track:<file>` refers to a user track; anything else is a built-in synth mood.
export function isTrackId(sound: string): boolean {
  return sound.startsWith('track:');
}

export async function loadMusicTracks(): Promise<MusicTrack[]> {
  try {
    const base = import.meta.env.BASE_URL;
    const response = await fetch(`${base}music/tracks.json`, { cache: 'no-cache' });
    if (!response.ok) {
      return [];
    }
    const raw = (await response.json()) as Array<{ file?: string; label?: string }>;
    return raw
      .filter((track) => track && track.file)
      .map((track) => ({ id: `track:${track.file}`, label: String(track.label || track.file), url: `${base}music/${track.file}` }));
  } catch {
    return [];
  }
}

// Resolve a `track:<file>` sound to its URL using a loaded track list.
export function musicUrlFor(sound: string, tracks: MusicTrack[]): string | null {
  return tracks.find((track) => track.id === sound)?.url ?? null;
}
