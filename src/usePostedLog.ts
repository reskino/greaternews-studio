import { useEffect, useState } from 'react';
import type { PostedLogEntry, StoryDraft } from './types';

const storageKey = 'greaternews-posted-log';

function safeLoadLog(): PostedLogEntry[] {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) {
      return [];
    }

    const parsed = JSON.parse(stored) as PostedLogEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function usePostedLog() {
  const [postedLog, setPostedLog] = useState<PostedLogEntry[]>([]);

  useEffect(() => {
    setPostedLog(safeLoadLog());
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(storageKey, JSON.stringify(postedLog));
    }
  }, [postedLog]);

  function logStory(draft: StoryDraft, date: string) {
    const entry: PostedLogEntry = {
      id: `${draft.id}-${date}`,
      date,
      loggedAt: new Date().toISOString(),
      title: draft.headline,
      category: draft.category,
      source: draft.primarySource,
      status: draft.status,
    };

    setPostedLog((current) => (current.some((item) => item.id === entry.id) ? current : [entry, ...current]));
  }

  function markFollowedUp(id: string) {
    setPostedLog((current) => current.map((entry) => (entry.id === id ? { ...entry, status: 'READY' as const } : entry)));
  }

  function clearLog() {
    setPostedLog([]);
  }

  return { postedLog, logStory, markFollowedUp, clearLog };
}
