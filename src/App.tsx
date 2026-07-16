import { useEffect, useMemo, useState } from 'react';
import { fetchArticleExcerpt } from './article';
import CardDesigner from './CardDesigner';
import { fetchAllFeeds, feedSources, isAlreadyPosted, selectMenuStories, storyBuckets, storyTemplates } from './feeds';
import { buildClaudeBrief, buildDailyPack, buildOutputs, buildPostedLogFile, parsePackFields } from './outputs';
import { clampText, downloadText, formatDateTime } from './text';
import type { CommandMode, LiveFeedState, PostedLogEntry, StoryCategory, StoryDraft, StoryStatus } from './types';
import { usePostedLog } from './usePostedLog';

const APP_VERSION = '1.9.0';
const today = new Date().toISOString().slice(0, 10);

const commandModes: Array<{ value: CommandMode; label: string }> = [
  { value: 'daily-run', label: 'Daily run' },
  { value: 'auto', label: 'Auto' },
  { value: 'story', label: 'Story on topic' },
  { value: 'breaking', label: 'Breaking' },
];

function cloneDraft(draft: StoryDraft): StoryDraft {
  return { ...draft };
}

function wordCount(value: string) {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

const angleIdeas: Record<StoryCategory, string[]> = {
  'Ghana politics & governance': [
    'What this means for ordinary Ghanaians, in plain terms.',
    'What happens next — the process and the timeline from here.',
    'Who wins, who loses, and why it matters beyond politics.',
  ],
  'Ghana business & economy': [
    'What this does to prices in your pocket this month.',
    'What it means for businesses, jobs, and the market.',
    'The trend behind the number — better or worse than last quarter?',
  ],
  Sports: [
    'What this result means for what comes next.',
    'The standout performance behind the scoreline.',
    'What must change before the next fixture.',
  ],
  'Entertainment & culture': [
    'Why this moment matters for Ghanaian culture.',
    'The story behind the announcement.',
    'What fans should watch for next.',
  ],
  'World news': [
    'Why this matters to Ghana and Africa.',
    'What changes now on the global stage.',
    'The context behind the headline in two sentences.',
  ],
  'Tech / trending': [
    'What this means for users in Ghana.',
    'Why now — the shift behind the launch.',
    'Who gains from this change, and who should be careful.',
  ],
};

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be blocked; keep the button usable.
    }
  }

  return (
    <button type="button" className="secondary copy-button" onClick={() => void handleCopy()}>
      {copied ? 'Copied ✓' : label}
    </button>
  );
}

function ShareButton({ text, title }: { text: string; title: string }) {
  if (typeof navigator === 'undefined' || !navigator.share) {
    return null;
  }

  return (
    <button
      type="button"
      className="secondary copy-button"
      onClick={() => {
        navigator.share({ title, text }).catch(() => {
          // User dismissed the share sheet.
        });
      }}
    >
      Share
    </button>
  );
}

export default function App() {
  const [mode, setMode] = useState<CommandMode>('daily-run');
  const [topic, setTopic] = useState('');
  const [date, setDate] = useState(today);
  const [draft, setDraft] = useState<StoryDraft>(() => cloneDraft(storyTemplates[0]));
  const [liveStories, setLiveStories] = useState<StoryDraft[]>([]);
  const [liveFeedState, setLiveFeedState] = useState<LiveFeedState>({
    loading: true,
    message: 'Loading live feeds…',
    refreshedAt: '',
    feedCount: 0,
    itemCount: 0,
    error: '',
    failedFeeds: [],
  });
  const { postedLog, logStory, markFollowedUp, updateEngagement, importEntries, clearLog } = usePostedLog();
  const [importMessage, setImportMessage] = useState('');

  async function refreshLiveStories(signal?: AbortSignal) {
    setLiveFeedState((current) => ({ ...current, loading: true, message: 'Refreshing live sources…', error: '' }));

    const { stories, failedFeeds } = await fetchAllFeeds(signal);

    setLiveStories(stories);
    setLiveFeedState({
      loading: false,
      message:
        stories.length > 0
          ? `Loaded ${stories.length} live story cards from ${feedSources.length - failedFeeds.length} of ${feedSources.length} feeds.`
          : 'No live stories matched, so the app is using fallback slots.',
      refreshedAt: new Date().toLocaleString('en-GH', { dateStyle: 'medium', timeStyle: 'short' }),
      feedCount: feedSources.length,
      itemCount: stories.length,
      error: failedFeeds.length > 0 && stories.length === 0 ? 'Some feeds were unavailable, so fallback story slots are active.' : '',
      failedFeeds,
    });
  }

  useEffect(() => {
    const controller = new AbortController();
    void refreshLiveStories(controller.signal);

    return () => {
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const storyMenu = useMemo(() => selectMenuStories(mode, topic, liveStories, postedLog), [liveStories, mode, postedLog, topic]);

  useEffect(() => {
    if (storyMenu.length > 0 && !storyMenu.some((story) => story.id === draft.id)) {
      setDraft(cloneDraft(storyMenu[0]));
    }
  }, [draft.id, storyMenu]);

  const outputs = useMemo(() => buildOutputs(draft), [draft]);
  const pack = useMemo(
    () => buildDailyPack(date, mode, topic, draft, storyMenu, postedLog, liveFeedState),
    [date, draft, liveFeedState, mode, postedLog, storyMenu, topic],
  );

  const followUps = postedLog.filter((entry) => entry.status === 'DEVELOPING');

  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const weekEntries = postedLog.filter((entry) => entry.date >= weekAgo);
  const weeklyHeadlines = weekEntries.slice(0, 5).map((entry) => entry.title);
  const weekDates = weekEntries.map((entry) => entry.date).sort();
  const friendlyDay = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-GH', { month: 'long', day: 'numeric' });
  const weeklyRange =
    weekDates.length > 0 ? `${friendlyDay(weekDates[0])} – ${friendlyDay(weekDates[weekDates.length - 1])}, ${weekDates[weekDates.length - 1].slice(0, 4)}` : '';

  const measured = postedLog.filter((entry) => typeof entry.reactions === 'number');
  let insight = '';
  if (measured.length >= 3) {
    const byCategory = new Map<string, { sum: number; count: number }>();
    for (const entry of measured) {
      const bucket = byCategory.get(entry.category) ?? { sum: 0, count: 0 };
      bucket.sum += entry.reactions ?? 0;
      bucket.count += 1;
      byCategory.set(entry.category, bucket);
    }
    const ranked = [...byCategory.entries()]
      .map(([category, bucket]) => ({ category, avg: bucket.sum / bucket.count, count: bucket.count }))
      .sort((a, b) => b.avg - a.avg);
    const best = ranked[0];
    insight = `Best performing category so far: ${best.category} — averaging ${Math.round(best.avg)} reactions over ${best.count} post${best.count > 1 ? 's' : ''}. Lean into what works.`;
  }

  function updateDraft(field: keyof StoryDraft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function backupLog() {
    downloadText(`greaternews_log_backup_${date}.json`, JSON.stringify(postedLog, null, 2));
  }

  const [briefState, setBriefState] = useState<'idle' | 'busy' | 'copied'>('idle');

  async function copyBriefWithContext() {
    if (briefState === 'busy') {
      return;
    }

    setBriefState('busy');
    let excerpt = '';
    if (draft.link) {
      try {
        excerpt = await fetchArticleExcerpt(draft.link);
      } catch {
        // Article not reachable — the brief still works from the feed summary.
      }
    }

    try {
      await navigator.clipboard.writeText(buildClaudeBrief(draft, excerpt));
      setBriefState('copied');
      window.setTimeout(() => setBriefState('idle'), 1600);
    } catch {
      setBriefState('idle');
    }
  }

  const quoteWords = wordCount(draft.quote);
  const headlineWords = wordCount(draft.headline);

  const [pasteMessage, setPasteMessage] = useState('');

  async function pasteClaudePack() {
    try {
      const text = await navigator.clipboard.readText();
      const fields = parsePackFields(text);
      if (fields) {
        setDraft((current) => ({ ...current, ...fields }));
        setPasteMessage(`Imported ${Object.keys(fields).length} fields from Claude's pack.`);
      } else {
        setPasteMessage("No ===FIELDS=== block found — copy Claude's full reply first.");
      }
    } catch {
      setPasteMessage('Clipboard read was blocked — allow clipboard access and try again.');
    }
    window.setTimeout(() => setPasteMessage(''), 4000);
  }

  function handleImportFile(files: FileList | null) {
    const file = files?.[0];
    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as PostedLogEntry[];
        if (!Array.isArray(parsed)) {
          throw new Error('Not a backup file');
        }
        importEntries(parsed);
        setImportMessage(`Imported ${parsed.length} entries (duplicates skipped).`);
      } catch {
        setImportMessage('Could not read that file — use a JSON backup made with the Backup button.');
      }
      window.setTimeout(() => setImportMessage(''), 4000);
    };
    reader.readAsText(file);
  }

  return (
    <main className="shell">
      <header className="topbar card">
        <div className="topbar-brand">
          <h1>GreaterNews Studio</h1>
          <p>News You Can Trust · verified before it posts</p>
        </div>
        <div className="topbar-actions">
          <span className="pill">v{APP_VERSION}</span>
          <label className="topbar-date">
            <span>Date</span>
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </label>
          <CopyButton text={pack} label="Copy pack" />
          <button type="button" className="primary" onClick={() => downloadText(`greaternews_${date}.md`, pack)}>
            Save pack
          </button>
        </div>
      </header>

      <section className="card step-card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Step 1 — Story desk</p>
            <h2>Pick today's story</h2>
          </div>
          <div className="menu-actions">
            <button type="button" className="secondary" onClick={() => void refreshLiveStories()} disabled={liveFeedState.loading}>
              {liveFeedState.loading ? 'Refreshing…' : 'Refresh feeds'}
            </button>
          </div>
        </div>

        <div className="desk-controls">
          <div className="mode-grid">
            {commandModes.map((option) => (
              <button
                key={option.value}
                type="button"
                className={mode === option.value ? 'mode-button active' : 'mode-button'}
                onClick={() => setMode(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <input
            className="topic-input"
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            placeholder="Filter by topic — e.g. cedi, Black Stars, South Africa"
          />
        </div>

        <p className="feed-status">
          {liveFeedState.error || liveFeedState.message} {liveFeedState.refreshedAt ? `Last refreshed ${liveFeedState.refreshedAt}.` : ''}{' '}
          {liveFeedState.failedFeeds.length > 0 ? `Feeds unavailable: ${liveFeedState.failedFeeds.join(', ')}.` : ''}
        </p>

        <div className="story-grid">
          {storyMenu.map((story) => (
            <button
              key={story.id}
              type="button"
              className={draft.id === story.id ? 'story-card active' : 'story-card'}
              onClick={() => setDraft(cloneDraft(story))}
            >
              <div className="story-card-top">
                <span className="pill-inline">{story.status}</span>
                <span className="pill-inline muted">{story.category}</span>
                {story.isLive ? <span className="pill-inline muted">LIVE</span> : null}
                {isAlreadyPosted(story, postedLog) ? <span className="pill-inline warn">POSTED</span> : null}
              </div>
              <strong>{story.headline}</strong>
              <p>{story.menuNote}</p>
              <small>{story.primarySource}</small>
              {story.publishedAt ? <small>{formatDateTime(story.publishedAt)}</small> : null}
            </button>
          ))}
        </div>
      </section>

      <section className="card step-card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Step 2 — Draft & verify</p>
            <h2>Make the story ours</h2>
          </div>
          <div className="menu-actions">
            <button type="button" className="secondary copy-button" onClick={() => void copyBriefWithContext()} disabled={briefState === 'busy'}>
              {briefState === 'busy' ? 'Fetching article context…' : briefState === 'copied' ? 'Copied ✓' : 'Copy Claude brief'}
            </button>
            <button type="button" className="secondary copy-button" onClick={() => void pasteClaudePack()}>
              Paste Claude pack
            </button>
            <button type="button" className="secondary" onClick={() => setDraft(cloneDraft(storyTemplates[0]))}>
              Reset draft
            </button>
          </div>
        </div>

        <p className="feed-status">
          Fast AI drafting: "Copy Claude brief" packages the story with article context → paste into Claude → copy Claude's reply → "Paste Claude pack" fills every field here automatically.
        </p>
        {pasteMessage ? <p className="feed-status">{pasteMessage}</p> : null}

        <details className="rules-details">
          <summary>Editorial guardrails — read before publishing</summary>
          <ul className="rule-list">
            <li>Always search the web before writing; never write news from memory.</li>
            <li>Use at least 2 independent sources for major or breaking claims.</li>
            <li>Attribute every story; never fabricate names, numbers, or quotes.</li>
            <li>Quotes under 15 words, one per source, in quotation marks.</li>
            <li>Keep tragedy, crime, and politics factual and restrained — no slang, no sides.</li>
            <li>Check the posted log so a story never repeats.</li>
          </ul>
          <div className="bucket-chips">
            {storyBuckets.map((bucket) => (
              <span className="bucket-chip" key={bucket.title} title={bucket.note}>
                {bucket.emoji} {bucket.title}
              </span>
            ))}
          </div>
        </details>

        <div className="editor-grid">
          <label className="span-full">
            <span>Headline</span>
            <input value={draft.headline} onChange={(event) => updateDraft('headline', event.target.value)} />
            {headlineWords > 9 ? (
              <em className="field-hint">ℹ {headlineWords} words — fine for posts; the card headline rule is max 9, so shorten it in the Card Studio.</em>
            ) : null}
          </label>

          <label>
            <span>Category</span>
            <select value={draft.category} onChange={(event) => updateDraft('category', event.target.value as StoryCategory)}>
              {storyBuckets.map((bucket) => (
                <option key={bucket.title} value={bucket.title}>
                  {bucket.title}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>Status</span>
            <select value={draft.status} onChange={(event) => updateDraft('status', event.target.value as StoryStatus)}>
              <option value="READY">READY</option>
              <option value="DEVELOPING">DEVELOPING</option>
            </select>
          </label>

          <label>
            <span>Primary source</span>
            <input value={draft.primarySource} onChange={(event) => updateDraft('primarySource', event.target.value)} />
          </label>

          <label>
            <span>Backup sources</span>
            <input value={draft.backupSources} onChange={(event) => updateDraft('backupSources', event.target.value)} />
          </label>

          <label className="span-full">
            <span>Key facts (verified only)</span>
            <textarea value={draft.keyFacts} onChange={(event) => updateDraft('keyFacts', event.target.value)} rows={4} />
          </label>

          <label>
            <span>Verification notes</span>
            <textarea value={draft.verificationNotes} onChange={(event) => updateDraft('verificationNotes', event.target.value)} rows={3} />
          </label>

          <label>
            <span>Our angle</span>
            <textarea value={draft.angle} onChange={(event) => updateDraft('angle', event.target.value)} rows={3} />
            <span className="bucket-chips angle-chips">
              {angleIdeas[draft.category].map((idea) => (
                <button key={idea} type="button" className="bucket-chip query-chip" onClick={() => updateDraft('angle', idea)}>
                  {idea.split(' ').slice(0, 5).join(' ')}…
                </button>
              ))}
            </span>
          </label>

          <label>
            <span>Short quote (under 15 words)</span>
            <input value={draft.quote} onChange={(event) => updateDraft('quote', event.target.value)} />
            {quoteWords > 15 ? (
              <em className="field-hint warn">⚠ {quoteWords} words — house rule: direct quotes stay under 15. Trim it or paraphrase with attribution.</em>
            ) : null}
          </label>

          <label>
            <span>Engagement question</span>
            <input value={draft.cta} onChange={(event) => updateDraft('cta', event.target.value)} />
          </label>

          <label>
            <span>Image suggestion</span>
            <input value={draft.imageSuggestion} onChange={(event) => updateDraft('imageSuggestion', event.target.value)} />
          </label>

          <label>
            <span>Sources searched today</span>
            <input value={draft.sourcesSearched} onChange={(event) => updateDraft('sourcesSearched', event.target.value)} />
          </label>
        </div>
      </section>

      <section className="card step-card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Step 3 — Outputs</p>
            <h2>Every format, ready to post</h2>
          </div>
        </div>

        <div className="grid content-grid">
          <article className="output-card">
            <div className="output-heading">
              <p className="eyebrow">Facebook</p>
              <span className="output-actions"><ShareButton text={outputs.facebook} title={draft.headline} /><CopyButton text={outputs.facebook} /></span>
            </div>
            <pre>{outputs.facebook}</pre>
          </article>

          <article className="output-card">
            <div className="output-heading">
              <p className="eyebrow">X</p>
              <div className="output-actions">
                <span className={outputs.x.length > 280 ? 'pill danger' : 'pill'}>{outputs.x.length}/280</span>
                <ShareButton text={outputs.x} title={draft.headline} />
                <CopyButton text={outputs.x} />
              </div>
            </div>
            <pre>{outputs.x}</pre>
          </article>

          <article className="output-card">
            <div className="output-heading">
              <p className="eyebrow">Instagram</p>
              <span className="output-actions"><ShareButton text={outputs.instagram} title={draft.headline} /><CopyButton text={outputs.instagram} /></span>
            </div>
            <pre>{outputs.instagram}</pre>
          </article>

          <article className="output-card">
            <div className="output-heading">
              <p className="eyebrow">WhatsApp</p>
              <span className="output-actions"><ShareButton text={outputs.whatsapp} title={draft.headline} /><CopyButton text={outputs.whatsapp} /></span>
            </div>
            <pre>{outputs.whatsapp}</pre>
          </article>

          <article className="output-card">
            <div className="output-heading">
              <p className="eyebrow">Video script</p>
              <CopyButton text={outputs.video} />
            </div>
            <pre>{outputs.video}</pre>
          </article>

          <article className="output-card">
            <div className="output-heading">
              <p className="eyebrow">News card brief</p>
              <CopyButton text={outputs.card} />
            </div>
            <pre>{outputs.card}</pre>
          </article>
        </div>
      </section>

      <div className="step-wrap">
        <p className="eyebrow step-eyebrow">Step 4 — Card Studio</p>
        <CardDesigner
          suggestedHeadline={draft.headline}
          suggestedSubline={clampText(draft.keyFacts, 120)}
          suggestedSource={draft.primarySource}
          suggestedCategory={draft.category}
          suggestedLink={draft.link ?? ''}
          weeklyHeadlines={weeklyHeadlines}
          weeklyRange={weeklyRange}
        />
      </div>

      <section className="card step-card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Step 5 — Publish & track</p>
            <h2>Posted log</h2>
          </div>
          <div className="menu-actions">
            <button type="button" className="secondary" onClick={() => downloadText('posted_log.md', buildPostedLogFile(postedLog))}>
              Export log
            </button>
            <button type="button" className="secondary" onClick={backupLog}>
              Backup (JSON)
            </button>
            <label className="secondary file-button">
              Import backup
              <input type="file" accept=".json,application/json" hidden onChange={(event) => handleImportFile(event.target.files)} />
            </label>
            <button type="button" className="secondary" onClick={clearLog}>
              Clear log
            </button>
            <button type="button" className="primary" onClick={() => logStory(draft, date)}>
              Log current story
            </button>
          </div>
        </div>

        {importMessage ? <p className="feed-status">{importMessage}</p> : null}
        {insight ? (
          <div className="callout insight-callout">
            <strong>Audience insight</strong>
            <p>{insight}</p>
          </div>
        ) : (
          <p className="feed-status">
            Tip: after each post has been up for a day, fill in reach / reactions / shares below — once 3+ posts have numbers, the studio shows which categories grow the page.
          </p>
        )}

        {followUps.length > 0 ? (
          <div className="callout followup-callout">
            <strong>Awaiting follow-up ({followUps.length})</strong>
            <p>These logged stories are still DEVELOPING — check for new facts, post an Update card, then mark them done.</p>
            <div className="followup-list">
              {followUps.map((entry) => (
                <div className="followup-item" key={entry.id}>
                  <div>
                    <strong>{entry.title}</strong>
                    <p>
                      {entry.date} · {entry.source}
                    </p>
                  </div>
                  <button type="button" className="secondary" onClick={() => markFollowedUp(entry.id)}>
                    Mark updated
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="log-list">
          {postedLog.length > 0 ? (
            postedLog.map((entry) => (
              <div className="log-item" key={entry.id}>
                <strong>{entry.title}</strong>
                <p>
                  {entry.date} | {entry.category} | {entry.source} | {entry.status}
                  {entry.loggedAt ? ` | ${formatDateTime(entry.loggedAt)}` : ''}
                </p>
                <div className="log-metrics">
                  {(['reach', 'reactions', 'shares'] as const).map((field) => (
                    <label key={field} className="metric-input">
                      <span>{field}</span>
                      <input
                        type="number"
                        min={0}
                        placeholder="—"
                        value={entry[field] ?? ''}
                        onChange={(event) => updateEngagement(entry.id, field, event.target.value)}
                      />
                    </label>
                  ))}
                </div>
              </div>
            ))
          ) : (
            <p className="empty-state">No stories logged yet. Log each story after it goes out so nothing repeats.</p>
          )}
        </div>
      </section>
    </main>
  );
}
