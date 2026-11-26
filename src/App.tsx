import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { fetchArticleExcerpt } from './article';
import CardDesigner from './CardDesigner';
import { fetchAllFeeds, feedSources, isAlreadyPosted, selectMenuStories, storyBuckets, storyTemplates } from './feeds';
import { buildClaudeBrief, buildDailyPack, buildOutputs, buildPostedLogFile, parsePackFields } from './outputs';
import { clampText, downloadText, formatDateTime } from './text';
import type { CommandMode, LiveFeedState, PostedLogEntry, StoryCategory, StoryDraft, StoryStatus } from './types';
import { usePostedLog } from './usePostedLog';

const APP_VERSION = '2.0.0';
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

// The workflow sections, in page order. The sidebar nav links to these ids and highlights the one in view.
// step-card and step-video are rendered by CardDesigner.
const workflowSections: Array<{ id: string; label: string }> = [
  { id: 'step-desk', label: 'Story desk' },
  { id: 'step-draft', label: 'Draft & verify' },
  { id: 'step-outputs', label: 'Outputs' },
  { id: 'step-card', label: 'Card studio' },
  { id: 'step-video', label: 'Video & voice' },
  { id: 'step-publish', label: 'Publish & track' },
];
const sectionIds = workflowSections.map((section) => section.id);

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

// Scroll-spy: a section is "in view" while it crosses a thin band ~25% down the viewport; the last
// one in page order wins. A sentinel at the end of the page selects the final section once the
// bottom is reached (a short last section never reaches the band).
function useActiveSection(ids: string[], endId: string) {
  const [active, setActive] = useState(ids[0]);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      return;
    }
    const inBand = new Set<string>();
    let atEnd = false;
    const pick = () => {
      if (atEnd) {
        setActive(ids[ids.length - 1]);
        return;
      }
      const hits = ids.filter((id) => inBand.has(id));
      if (hits.length > 0) {
        setActive(hits[hits.length - 1]);
        return;
      }
      // Above the first section (e.g. back at the top on a phone, where the top bar is tall).
      const first = document.getElementById(ids[0]);
      if (first && first.getBoundingClientRect().top > window.innerHeight * 0.3) {
        setActive(ids[0]);
      }
    };

    const bandObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            inBand.add(entry.target.id);
          } else {
            inBand.delete(entry.target.id);
          }
        }
        pick();
      },
      { rootMargin: '-25% 0px -70% 0px' },
    );
    const endObserver = new IntersectionObserver((entries) => {
      atEnd = entries.some((entry) => entry.isIntersecting);
      pick();
    });

    for (const id of ids) {
      const element = document.getElementById(id);
      if (element) {
        bandObserver.observe(element);
      }
    }
    const end = document.getElementById(endId);
    if (end) {
      endObserver.observe(end);
    }

    return () => {
      bandObserver.disconnect();
      endObserver.disconnect();
    };
  }, [ids, endId]);

  return [active, setActive] as const;
}

function statusChipClass(status: string) {
  return status === 'READY' ? 'gn-chip gn-chip--ok' : 'gn-chip gn-chip--info';
}

function CopyButton({ text, label = 'Copy', className = 'gn-btn gn-btn--sm' }: { text: string; label?: string; className?: string }) {
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
    <button type="button" className={className} onClick={() => void handleCopy()}>
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
      className="gn-btn gn-btn--sm gn-btn--ghost"
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

  const [activeSection, setActiveSection] = useActiveSection(sectionIds, 'gn-page-end');
  const sidebarRef = useRef<HTMLElement>(null);

  // On narrow screens the sidebar is a horizontally scrolling strip — keep the active link in view.
  useEffect(() => {
    const sidebar = sidebarRef.current;
    const link = sidebar?.querySelector<HTMLElement>(`a[href="#${activeSection}"]`);
    if (!sidebar || !link || sidebar.scrollWidth <= sidebar.clientWidth + 1) {
      return;
    }
    const sidebarBox = sidebar.getBoundingClientRect();
    const linkBox = link.getBoundingClientRect();
    const delta = linkBox.left - sidebarBox.left - (sidebarBox.width - linkBox.width) / 2;
    sidebar.scrollTo({ left: sidebar.scrollLeft + delta, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, [activeSection]);

  function jumpToSection(event: ReactMouseEvent<HTMLAnchorElement>, id: string) {
    const target = document.getElementById(id);
    if (!target) {
      return;
    }
    event.preventDefault();
    setActiveSection(id);
    target.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
  }

  return (
    <div className="gn-shell">
      <aside className="gn-sidebar" ref={sidebarRef}>
        <div className="gn-brand">
          <span className="gn-brand__badge">
            <img src={`${import.meta.env.BASE_URL}logo.png`} alt="" />
          </span>
          <div>
            <div className="gn-brand__name">GREATERNEWS</div>
            <div className="gn-brand__sub">Studio</div>
          </div>
        </div>

        <nav className="gn-nav" aria-label="Workflow steps">
          <div className="gn-nav__label">Workflow</div>
          {workflowSections.map((section, index) => (
            <a
              key={section.id}
              href={`#${section.id}`}
              className={activeSection === section.id ? 'is-active' : undefined}
              aria-current={activeSection === section.id ? 'step' : undefined}
              onClick={(event) => jumpToSection(event, section.id)}
            >
              <span className="gn-nav__num">{index + 1}</span>
              {section.label}
            </a>
          ))}
        </nav>

        <div className="gn-sidebar__foot">
          <div className="app-now">
            <span className="app-now__label">Working on</span>
            <strong className="app-now__title">{draft.headline || 'No story selected yet'}</strong>
            <span className="app-now__meta">
              <span className={statusChipClass(draft.status)}>{draft.status}</span>
            </span>
          </div>
        </div>
      </aside>

      <main className="gn-main">
        <header className="app-topbar">
          <div className="gn-topbar app-topbar__inner">
            <div className="gn-topbar__title">
              <h1 className="app-title">GreaterNews Studio</h1>
              <p className="gn-sub">News You Can Trust · verified before it posts</p>
            </div>
            <div className="gn-actions app-topbar__actions">
              <span className="gn-chip gn-chip--plain">v{APP_VERSION}</span>
              <label className="app-date">
                <span className="gn-label">Date</span>
                <input className="gn-input" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
              </label>
              <CopyButton text={pack} label="Copy pack" className="gn-btn" />
              <button type="button" className="gn-btn gn-btn--primary" onClick={() => downloadText(`greaternews_${date}.md`, pack)}>
                Save pack
              </button>
            </div>
          </div>
        </header>

        <div className="gn-container">
          <section id="step-desk" className="gn-card app-section">
            <header className="gn-card__head">
              <div>
                <span className="gn-eyebrow">Story desk</span>
                <h2 className="gn-h2">
                  <span className="gn-step">1</span>Pick today's story
                </h2>
              </div>
              <div className="gn-actions">
                <button type="button" className="gn-btn gn-btn--sm" onClick={() => void refreshLiveStories()} disabled={liveFeedState.loading}>
                  {liveFeedState.loading ? <span className="gn-spin" aria-hidden="true" /> : null}
                  {liveFeedState.loading ? 'Refreshing…' : 'Refresh feeds'}
                </button>
              </div>
            </header>

            <div className="desk-controls">
              <div className="gn-seg app-seg" role="group" aria-label="Command mode">
                {commandModes.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={mode === option.value ? 'is-on is-gold' : undefined}
                    aria-pressed={mode === option.value}
                    onClick={() => setMode(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <input
                className="gn-input topic-input"
                value={topic}
                onChange={(event) => setTopic(event.target.value)}
                placeholder="Filter by topic — e.g. cedi, Black Stars, South Africa"
              />
            </div>

            <p className={`app-status app-status--${liveFeedState.loading ? 'busy' : liveFeedState.error ? 'err' : 'ok'}`}>
              {liveFeedState.error || liveFeedState.message} {liveFeedState.refreshedAt ? `Last refreshed ${liveFeedState.refreshedAt}.` : ''}{' '}
              {liveFeedState.failedFeeds.length > 0 ? `Feeds unavailable: ${liveFeedState.failedFeeds.join(', ')}.` : ''}
            </p>

            <div className="story-grid">
              {storyMenu.map((story) => (
                <button
                  key={story.id}
                  type="button"
                  className={draft.id === story.id ? 'gn-item story-card is-selected' : 'gn-item story-card'}
                  aria-pressed={draft.id === story.id}
                  onClick={() => setDraft(cloneDraft(story))}
                >
                  <span className="story-card-top">
                    <span className={statusChipClass(story.status)}>{story.status}</span>
                    <span className="gn-chip gn-chip--plain">{story.category}</span>
                    {story.isLive ? <span className="gn-chip gn-chip--err">LIVE</span> : null}
                    {isAlreadyPosted(story, postedLog) ? <span className="gn-chip gn-chip--warn">POSTED</span> : null}
                  </span>
                  <strong className="gn-item__title">{story.headline}</strong>
                  <span className="story-card-note">{story.menuNote}</span>
                  <span className="gn-item__meta story-card-meta">
                    <span>{story.primarySource}</span>
                    {story.publishedAt ? <span>{formatDateTime(story.publishedAt)}</span> : null}
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section id="step-draft" className="gn-card app-section">
            <header className="gn-card__head">
              <div>
                <span className="gn-eyebrow">Draft &amp; verify</span>
                <h2 className="gn-h2">
                  <span className="gn-step">2</span>Make the story ours
                </h2>
              </div>
              <div className="gn-actions">
                <button type="button" className="gn-btn gn-btn--sm" onClick={() => void copyBriefWithContext()} disabled={briefState === 'busy'}>
                  {briefState === 'busy' ? <span className="gn-spin" aria-hidden="true" /> : null}
                  {briefState === 'busy' ? 'Fetching article context…' : briefState === 'copied' ? 'Copied ✓' : 'Copy Claude brief'}
                </button>
                <button type="button" className="gn-btn gn-btn--sm" onClick={() => void pasteClaudePack()}>
                  Paste Claude pack
                </button>
                <button type="button" className="gn-btn gn-btn--sm gn-btn--ghost" onClick={() => setDraft(cloneDraft(storyTemplates[0]))}>
                  Reset draft
                </button>
              </div>
            </header>

            <p className="app-note">
              Fast AI drafting: "Copy Claude brief" packages the story with article context → paste into Claude → copy Claude's reply → "Paste Claude pack" fills every field here automatically.
            </p>
            {pasteMessage ? <p className="app-note app-note--flash">{pasteMessage}</p> : null}

            <details className="gn-details rules-details">
              <summary>Editorial guardrails — read before publishing</summary>
              <div className="gn-details__body">
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
                    <span className="gn-chip gn-chip--plain" key={bucket.title} title={bucket.note}>
                      {bucket.emoji} {bucket.title}
                    </span>
                  ))}
                </div>
              </div>
            </details>

            <div className="editor-grid">
              <label className="gn-field span-full">
                <span className="gn-label">Headline</span>
                <input className="gn-input" value={draft.headline} onChange={(event) => updateDraft('headline', event.target.value)} />
                {headlineWords > 9 ? (
                  <em className="field-hint">ℹ {headlineWords} words — fine for posts; the card headline rule is max 9, so shorten it in the Card Studio.</em>
                ) : null}
              </label>

              <label className="gn-field">
                <span className="gn-label">Category</span>
                <select className="gn-select" value={draft.category} onChange={(event) => updateDraft('category', event.target.value as StoryCategory)}>
                  {storyBuckets.map((bucket) => (
                    <option key={bucket.title} value={bucket.title}>
                      {bucket.title}
                    </option>
                  ))}
                </select>
              </label>

              <label className="gn-field">
                <span className="gn-label">Status</span>
                <select className="gn-select" value={draft.status} onChange={(event) => updateDraft('status', event.target.value as StoryStatus)}>
                  <option value="READY">READY</option>
                  <option value="DEVELOPING">DEVELOPING</option>
                </select>
              </label>

              <label className="gn-field">
                <span className="gn-label">Primary source</span>
                <input className="gn-input" value={draft.primarySource} onChange={(event) => updateDraft('primarySource', event.target.value)} />
              </label>

              <label className="gn-field">
                <span className="gn-label">Backup sources</span>
                <input className="gn-input" value={draft.backupSources} onChange={(event) => updateDraft('backupSources', event.target.value)} />
              </label>

              <label className="gn-field span-full">
                <span className="gn-label">Key facts (verified only)</span>
                <textarea className="gn-textarea" value={draft.keyFacts} onChange={(event) => updateDraft('keyFacts', event.target.value)} rows={4} />
              </label>

              <label className="gn-field">
                <span className="gn-label">Verification notes</span>
                <textarea className="gn-textarea" value={draft.verificationNotes} onChange={(event) => updateDraft('verificationNotes', event.target.value)} rows={3} />
              </label>

              <label className="gn-field">
                <span className="gn-label">Our angle</span>
                <textarea className="gn-textarea" value={draft.angle} onChange={(event) => updateDraft('angle', event.target.value)} rows={3} />
                <span className="bucket-chips angle-chips">
                  {angleIdeas[draft.category].map((idea) => (
                    <button key={idea} type="button" className="gn-chip gn-chip--plain app-chip-btn" onClick={() => updateDraft('angle', idea)}>
                      {idea.split(' ').slice(0, 5).join(' ')}…
                    </button>
                  ))}
                </span>
              </label>

              <label className="gn-field">
                <span className="gn-label">
                  Short quote <span className="gn-hint">(under 15 words)</span>
                </span>
                <input className="gn-input" value={draft.quote} onChange={(event) => updateDraft('quote', event.target.value)} />
                {quoteWords > 15 ? (
                  <em className="field-hint warn">⚠ {quoteWords} words — house rule: direct quotes stay under 15. Trim it or paraphrase with attribution.</em>
                ) : null}
              </label>

              <label className="gn-field">
                <span className="gn-label">Engagement question</span>
                <input className="gn-input" value={draft.cta} onChange={(event) => updateDraft('cta', event.target.value)} />
              </label>

              <label className="gn-field">
                <span className="gn-label">Image suggestion</span>
                <input className="gn-input" value={draft.imageSuggestion} onChange={(event) => updateDraft('imageSuggestion', event.target.value)} />
              </label>

              <label className="gn-field">
                <span className="gn-label">Sources searched today</span>
                <input className="gn-input" value={draft.sourcesSearched} onChange={(event) => updateDraft('sourcesSearched', event.target.value)} />
              </label>
            </div>
          </section>

          <section id="step-outputs" className="gn-card app-section">
            <header className="gn-card__head">
              <div>
                <span className="gn-eyebrow">Outputs</span>
                <h2 className="gn-h2">
                  <span className="gn-step">3</span>Every format, ready to post
                </h2>
              </div>
            </header>

            <div className="content-grid">
              <article className="output-card">
                <div className="output-heading">
                  <h3 className="gn-h3">Facebook</h3>
                  <span className="output-actions">
                    <ShareButton text={outputs.facebook} title={draft.headline} />
                    <CopyButton text={outputs.facebook} />
                  </span>
                </div>
                <pre>{outputs.facebook}</pre>
              </article>

              <article className="output-card">
                <div className="output-heading">
                  <h3 className="gn-h3">X</h3>
                  <div className="output-actions">
                    <span className={outputs.x.length > 280 ? 'gn-chip gn-chip--err' : 'gn-chip gn-chip--ok'}>{outputs.x.length}/280</span>
                    <ShareButton text={outputs.x} title={draft.headline} />
                    <CopyButton text={outputs.x} />
                  </div>
                </div>
                <pre>{outputs.x}</pre>
              </article>

              <article className="output-card">
                <div className="output-heading">
                  <h3 className="gn-h3">Instagram</h3>
                  <span className="output-actions">
                    <ShareButton text={outputs.instagram} title={draft.headline} />
                    <CopyButton text={outputs.instagram} />
                  </span>
                </div>
                <pre>{outputs.instagram}</pre>
              </article>

              <article className="output-card">
                <div className="output-heading">
                  <h3 className="gn-h3">WhatsApp</h3>
                  <span className="output-actions">
                    <ShareButton text={outputs.whatsapp} title={draft.headline} />
                    <CopyButton text={outputs.whatsapp} />
                  </span>
                </div>
                <pre>{outputs.whatsapp}</pre>
              </article>

              <article className="output-card">
                <div className="output-heading">
                  <h3 className="gn-h3">Video script</h3>
                  <CopyButton text={outputs.video} />
                </div>
                <pre>{outputs.video}</pre>
              </article>

              <article className="output-card">
                <div className="output-heading">
                  <h3 className="gn-h3">News card brief</h3>
                  <CopyButton text={outputs.card} />
                </div>
                <pre>{outputs.card}</pre>
              </article>
            </div>
          </section>

          <CardDesigner
            suggestedHeadline={draft.headline}
            suggestedSubline={clampText(draft.keyFacts, 120)}
            suggestedSource={draft.primarySource}
            suggestedCategory={draft.category}
            suggestedLink={draft.link ?? ''}
            weeklyHeadlines={weeklyHeadlines}
            weeklyRange={weeklyRange}
          />

          <section id="step-publish" className="gn-card app-section">
            <header className="gn-card__head">
              <div>
                <span className="gn-eyebrow">Publish &amp; track</span>
                <h2 className="gn-h2">
                  <span className="gn-step">6</span>Posted log
                </h2>
              </div>
              <div className="gn-actions">
                <button type="button" className="gn-btn gn-btn--sm" onClick={() => downloadText('posted_log.md', buildPostedLogFile(postedLog))}>
                  Export log
                </button>
                <button type="button" className="gn-btn gn-btn--sm" onClick={backupLog}>
                  Backup (JSON)
                </button>
                <label className="gn-btn gn-btn--sm file-button">
                  Import backup
                  <input type="file" accept=".json,application/json" hidden onChange={(event) => handleImportFile(event.target.files)} />
                </label>
                <button type="button" className="gn-btn gn-btn--sm gn-btn--danger" onClick={clearLog}>
                  Clear log
                </button>
                <button type="button" className="gn-btn gn-btn--sm gn-btn--primary" onClick={() => logStory(draft, date)}>
                  Log current story
                </button>
              </div>
            </header>

            {importMessage ? <p className="app-note app-note--flash">{importMessage}</p> : null}
            {insight ? (
              <div className="app-callout app-callout--ok">
                <strong>Audience insight</strong>
                <p>{insight}</p>
              </div>
            ) : (
              <p className="app-note">
                Tip: after each post has been up for a day, fill in reach / reactions / shares below — once 3+ posts have numbers, the studio shows which categories grow the page.
              </p>
            )}

            {followUps.length > 0 ? (
              <div className="app-callout app-callout--gold">
                <strong>Awaiting follow-up ({followUps.length})</strong>
                <p>These logged stories are still DEVELOPING — check for new facts, post an Update card, then mark them done.</p>
                <div className="followup-list">
                  {followUps.map((entry) => (
                    <div className="gn-item followup-item" key={entry.id}>
                      <div>
                        <strong className="gn-item__title">{entry.title}</strong>
                        <p className="gn-item__meta">
                          {entry.date} · {entry.source}
                        </p>
                      </div>
                      <button type="button" className="gn-btn gn-btn--sm" onClick={() => markFollowedUp(entry.id)}>
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
                  <div className="gn-item log-item" key={entry.id}>
                    <strong className="gn-item__title">{entry.title}</strong>
                    <p className="gn-item__meta">
                      <span>{entry.date}</span>
                      <span>{entry.category}</span>
                      <span>{entry.source}</span>
                      <span className={statusChipClass(entry.status)}>{entry.status}</span>
                      {entry.loggedAt ? <span>{formatDateTime(entry.loggedAt)}</span> : null}
                    </p>
                    <div className="log-metrics">
                      {(['reach', 'reactions', 'shares'] as const).map((field) => (
                        <label key={field} className="gn-field metric-input">
                          <span className="gn-label">{field}</span>
                          <input
                            className="gn-input"
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
                <p className="gn-empty">No stories logged yet. Log each story after it goes out so nothing repeats.</p>
              )}
            </div>
          </section>
        </div>
        <div id="gn-page-end" className="app-page-end" aria-hidden="true" />
      </main>
    </div>
  );
}
