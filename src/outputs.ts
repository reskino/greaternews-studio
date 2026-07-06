import type { CommandMode, LiveFeedState, PostedLogEntry, StoryCategory, StoryDraft } from './types';
import { clampText, normalizeWhitespace } from './text';

const baseHashtags = ['#GreaterNews', '#Ghana'];

const categoryHashtags: Record<StoryCategory, string[]> = {
  'Ghana politics & governance': ['#GhanaPolitics', '#Governance', '#GhanaNews'],
  'Ghana business & economy': ['#GhanaEconomy', '#Cedi', '#GhanaBusiness'],
  Sports: ['#BlackStars', '#GhanaFootball', '#Sports'],
  'Entertainment & culture': ['#GhanaEntertainment', '#Showbiz', '#GhanaCulture'],
  'World news': ['#WorldNews', '#Global', '#Africa'],
  'Tech / trending': ['#Tech', '#Trending', '#Innovation'],
};

function storyHashtags(draft: StoryDraft, limit: number) {
  return [...baseHashtags, ...categoryHashtags[draft.category]].slice(0, limit).join(' ');
}

function statusPrefix(draft: StoryDraft) {
  return draft.status === 'DEVELOPING' ? 'DEVELOPING: ' : '';
}

export function buildFacebookPost(draft: StoryDraft) {
  const sources = [draft.primarySource, ...draft.backupSources.split(',').map((item) => item.trim()).filter(Boolean)];

  return [
    `${statusPrefix(draft)}${draft.headline.toUpperCase()}`,
    '',
    draft.keyFacts,
    '',
    draft.angle,
    '',
    draft.quote ? `Quote: "${clampText(draft.quote, 60)}"` : '',
    '',
    `(Source: ${sources.join(' | ')})`,
    storyHashtags(draft, 5),
    '',
    draft.cta,
  ]
    .filter((line, index, lines) => line !== '' || lines[index - 1] !== '')
    .join('\n');
}

export function buildXPost(draft: StoryDraft) {
  const body = normalizeWhitespace(
    `${statusPrefix(draft)}${draft.headline} ${draft.keyFacts} (Source: ${draft.primarySource}) ${storyHashtags(draft, 3)}`,
  );
  return clampText(body, 280);
}

export function buildInstagramCaption(draft: StoryDraft) {
  const hashtags = [
    ...baseHashtags,
    ...categoryHashtags[draft.category],
    '#NewsYouCanTrust',
    '#DailyNews',
    '#WestAfrica',
    '#NewsUpdate',
  ].slice(0, 12);

  return [
    `${statusPrefix(draft)}${draft.headline}`,
    draft.angle,
    draft.keyFacts,
    `(Source: ${draft.primarySource})`,
    '',
    `[IMAGE SUGGESTION] ${draft.imageSuggestion}`,
    '',
    hashtags.join(' '),
  ].join('\n');
}

export function buildWhatsAppStatus(draft: StoryDraft) {
  return [`${statusPrefix(draft)}${draft.headline}`, draft.keyFacts, 'Follow GreaterNews for more 📲'].join('\n');
}

export function buildVideoScript(draft: StoryDraft) {
  return [
    `HOOK (0-3s): ${draft.headline}. Here is what we know.`,
    '',
    `STORY (3-38s): ${draft.keyFacts} ${draft.angle}${draft.quote ? ` In their own words: "${clampText(draft.quote, 60)}".` : ''}`,
    '',
    'CTA (38-45s): Follow GreaterNews for more. News you can trust.',
    '',
    `Source: ${draft.primarySource}`,
  ].join('\n');
}

export function buildNewsCard(draft: StoryDraft) {
  return [
    `HEADLINE: ${clampText(draft.headline, 70)}`,
    'HIGHLIGHT: pick the 2-4 most important words in the headline',
    `SUBLINE: ${clampText(draft.keyFacts, 120)}`,
    `SOURCE STRIP: (Source: ${draft.primarySource})`,
    `IMAGE: ${draft.imageSuggestion}`,
    'BUILD IT: use the Card Studio below — pick a template, find a licensed photo, download all sizes.',
  ].join('\n');
}

export function buildClaudeBrief(draft: StoryDraft, articleExcerpt = '') {
  return [
    'You are the content engine for GreaterNews, a Ghana-first news channel. Tagline: "News You Can Trust." Follow these rules strictly:',
    '- Search the web FIRST and verify with at least 2 independent, current sources — never write news from memory.',
    '- Attribute everything; never fabricate names, figures, dates, or quotes. Direct quotes under 15 words, max one per source.',
    '- Tone: clear, credible, energetic. No slang on hard news, tragedy, or politics. Never take political sides — attribute each side.',
    '- If only one source confirms the story, label it DEVELOPING.',
    '- No graphic violence detail, no unverified death announcements, no medical or financial advice of our own.',
    '',
    'STORY LEAD TO VERIFY:',
    `- Headline: ${draft.headline}`,
    `- Category: ${draft.category}`,
    `- Lead source: ${draft.primarySource}`,
    draft.link ? `- Link: ${draft.link}` : '',
    `- Feed summary: ${clampText(draft.menuNote, 300)}`,
    ...(articleExcerpt
      ? ['', 'ARTICLE EXCERPT (from the lead source — reference only, verify every fact independently):', articleExcerpt]
      : []),
    '',
    'TASK — verify the story now, then produce the full GreaterNews pack:',
    '1. FACEBOOK: hook headline in caps, 3-6 short sentences, source attribution line, 3-5 hashtags including #GreaterNews #Ghana, end with an engagement question.',
    '2. X: max 280 characters, punchy and factual, source + 2-3 hashtags.',
    '3. INSTAGRAM: scroll-stopping first line, 2-4 sentences, blank line, 8-12 hashtags, plus [IMAGE SUGGESTION] (no real people photos for sensitive stories).',
    '4. WHATSAPP STATUS: headline + 2 lines + "Follow GreaterNews for more 📲".',
    '5. VIDEO SCRIPT (30-45s): HOOK (0-3s) → STORY → CTA "Follow GreaterNews. News you can trust." — written the way a presenter speaks.',
    '6. NEWS CARD TEXT: headline max 9 words, highlight phrase (2-4 words to color — skip for tragedy), subline, source strip.',
    '',
    'End with the list of sources you verified against, with URLs.',
    '',
    'Then finish with this machine block so the studio can import your work (plain text, exact labels, one per line):',
    '===FIELDS===',
    'HEADLINE: <the verified story headline>',
    'KEYFACTS: <the 2-4 verified facts in 2-3 sentences>',
    'ANGLE: <our angle in one sentence>',
    'QUOTE: <one attributed quote under 15 words, or leave empty>',
    'CTA: <the engagement question>',
    'IMAGE: <image suggestion for the design team>',
    'SOURCES: <comma-separated outlets you verified against>',
    'STATUS: <READY or DEVELOPING>',
    '===END===',
  ]
    .filter(Boolean)
    .join('\n');
}

const fieldMap: Record<string, keyof StoryDraft> = {
  HEADLINE: 'headline',
  KEYFACTS: 'keyFacts',
  ANGLE: 'angle',
  QUOTE: 'quote',
  CTA: 'cta',
  IMAGE: 'imageSuggestion',
  SOURCES: 'sourcesSearched',
  STATUS: 'status',
};

// Parses the ===FIELDS=== block Claude appends to a pack reply back into draft fields.
export function parsePackFields(text: string): Partial<StoryDraft> | null {
  const match = text.match(/===FIELDS===([\s\S]*?)===END===/);
  if (!match) {
    return null;
  }

  const result: Partial<StoryDraft> = {};
  let currentField: keyof StoryDraft | null = null;

  for (const rawLine of match[1].split('\n')) {
    const line = rawLine.trim();
    const labelMatch = line.match(/^([A-Z]+):\s*(.*)$/);

    if (labelMatch && fieldMap[labelMatch[1]]) {
      currentField = fieldMap[labelMatch[1]];
      const value = labelMatch[2].trim();
      if (currentField === 'status') {
        if (value === 'READY' || value === 'DEVELOPING') {
          result.status = value;
        }
        currentField = null;
      } else if (value) {
        (result as Record<string, string>)[currentField] = value;
      }
    } else if (currentField && line) {
      // Continuation line of a multi-line value (status never reaches here — it resets currentField above).
      (result as Record<string, string>)[currentField] = `${(result as Record<string, string>)[currentField] ?? ''} ${line}`.trim();
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

export function buildOutputs(draft: StoryDraft) {
  return {
    facebook: buildFacebookPost(draft),
    x: buildXPost(draft),
    instagram: buildInstagramCaption(draft),
    whatsapp: buildWhatsAppStatus(draft),
    video: buildVideoScript(draft),
    card: buildNewsCard(draft),
  };
}

export function buildDailyPack(
  date: string,
  mode: CommandMode,
  topic: string,
  draft: StoryDraft,
  menuStories: StoryDraft[],
  logEntries: PostedLogEntry[],
  liveState: LiveFeedState,
) {
  return `# GreaterNews Daily Pack\n\n- Date: ${date}\n- Command mode: ${mode}\n- Topic: ${topic || 'All buckets'}\n- Story status: ${draft.status}\n- Live status: ${liveState.error || liveState.message}\n- Live items: ${liveState.itemCount}\n\n## Story Menu\n${menuStories
    .map(
      (story, index) =>
        `${index + 1}. ${story.headline} - ${story.category}${story.isLive ? `\n   - Live source: ${story.primarySource}` : ''}\n   - ${story.menuNote}\n   - Primary source: ${story.primarySource}\n   - Verification: ${story.verificationNotes}`,
    )
    .join('\n\n')}\n\n## Selected Story\n- Headline: ${draft.headline}\n- Category: ${draft.category}\n- Primary source: ${draft.primarySource}\n- Backup sources: ${draft.backupSources}\n- Sources searched: ${draft.sourcesSearched}\n- Verification notes: ${draft.verificationNotes}\n${draft.link ? `- Source link: ${draft.link}\n` : ''}\n## Facebook\n${buildFacebookPost(draft)}\n\n## X\n${buildXPost(draft)}\n\n## Instagram\n${buildInstagramCaption(draft)}\n\n## WhatsApp\n${buildWhatsAppStatus(draft)}\n\n## Short Video Script\n${buildVideoScript(draft)}\n\n## News Card\n${buildNewsCard(draft)}\n\n## Posted Log Snapshot\n${logEntries.length > 0 ? logEntries.map((entry) => `- ${entry.date}: ${entry.title} (${entry.category})`).join('\n') : '- No logged stories yet.'}\n`;
}

export function buildPostedLogFile(logEntries: PostedLogEntry[]) {
  return `# posted_log\n\n${logEntries.length > 0 ? logEntries.map((entry) => `- ${entry.date} - ${entry.title} - ${entry.category} - ${entry.source} - ${entry.status}`).join('\n') : '- No stories logged yet.'}\n`;
}
