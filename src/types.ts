export type CommandMode = 'daily-run' | 'auto' | 'story' | 'breaking';

export type StoryStatus = 'READY' | 'DEVELOPING';

export type StoryCategory =
  | 'Ghana politics & governance'
  | 'Ghana business & economy'
  | 'Sports'
  | 'Entertainment & culture'
  | 'World news'
  | 'Tech / trending';

export type StoryDraft = {
  id: string;
  title: string;
  category: StoryCategory;
  status: StoryStatus;
  headline: string;
  primarySource: string;
  backupSources: string;
  sourcesSearched: string;
  verificationNotes: string;
  keyFacts: string;
  angle: string;
  quote: string;
  cta: string;
  imageSuggestion: string;
  menuNote: string;
  publishedAt?: string;
  link?: string;
  isLive: boolean;
};

export type StoryBucket = {
  title: StoryCategory;
  emoji: string;
  note: string;
};

export type PostedLogEntry = {
  id: string;
  date: string;
  loggedAt?: string;
  title: string;
  category: StoryCategory;
  source: string;
  status: StoryStatus;
};

export type FeedSource = {
  label: string;
  url: string;
  newsDomain: string;
  categoryHint?: StoryCategory;
  priority: number;
  backupSources: string;
  sourcesSearched: string;
  verificationNotes: string;
  keyFactsPrefix: string;
  angle: string;
  quote: string;
  cta: string;
  imageSuggestion: string;
  menuNote: string;
};

export type FeedItem = {
  title: string;
  link: string;
  summary: string;
  publishedAt?: string;
};

export type LiveFeedState = {
  loading: boolean;
  message: string;
  refreshedAt: string;
  feedCount: number;
  itemCount: number;
  error: string;
  failedFeeds: string[];
};
