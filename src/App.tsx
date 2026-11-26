import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { fetchArticleExcerpt } from './article';
import CardDesigner from './CardDesigner';
import type { CardStatus } from './CardDesigner';
import { fetchAllFeeds, feedSources, isAlreadyPosted, selectMenuStories, storyBuckets, storyTemplates } from './feeds';
import { CardBriefList, FacebookPreview, InstagramPreview, ScriptTimeline, WhatsAppPreview, XPreview, parseScript } from './OutputPreviews';
import { buildClaudeBrief, buildDailyPack, buildOutputs, buildPostedLogFile, parsePackFields } from './outputs';
import { clampText, downloadText, formatDateTime } from './text';
import type { CommandMode, LiveFeedState, PostedLogEntry, StoryCategory, StoryDraft } from './types';
import StepHead, { Panel } from './ui/StepHead';
import { usePostedLog } from './usePostedLog';

const APP_VERSION = '2.2.0';
// The GreaterNews helper on this PC (scripts/resolver.py) — holds the Claude key for one-click drafting.
const CLAUDE_HELPER = 'http://localhost:5199';
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

// ---- read-only signals for the checklist, the sidebar ticks and the status chips ----

/** Template text that means "not filled in yet". */
const placeholderFacts = new Set(storyTemplates.map((template) => template.keyFacts.trim()));
const placeholderHeadlines = new Set(storyTemplates.map((template) => template.headline.trim()));
/** Every feed pre-fills a to-do note ("Check … against a second outlet") — that is not verification yet. */
const defaultNotes = [...feedSources, ...storyTemplates].map((item) => item.verificationNotes.trim()).filter(Boolean);
const CARD_HEADLINE_MAX = 9;

function countSources(primary: string, backups: string) {
  const names = [primary, ...backups.split(/[,;|]/)].map((name) => name.trim().toLowerCase()).filter(Boolean);
  return new Set(names).size;
}

/** What the build knows about its optional services (see vite-env.d.ts). */
const hostedProxy = Boolean(import.meta.env.VITE_TTS_PROXY_URL);
const webImageSearch = Boolean(import.meta.env.VITE_SERPER_API_KEY || (import.meta.env.VITE_GOOGLE_CSE_KEY && import.meta.env.VITE_GOOGLE_CSE_CX));

/** "26 Nov 2026, 5:47 am" → ["5:47 am", "26 Nov 2026"] for the stat tile. */
function splitRefresh(value: string): [string, string] {
  const cut = value.lastIndexOf(', ');
  return cut > 0 ? [value.slice(cut + 2), value.slice(0, cut).replace(/\s\d{4}$/, '')] : [value, ''];
}

type OutputKey = 'facebook' | 'x' | 'instagram' | 'whatsapp' | 'video' | 'card';
const outputTabs: Array<{ key: OutputKey; label: string; title: string; shareable: boolean }> = [
  { key: 'facebook', label: 'Facebook', title: 'Facebook post', shareable: true },
  { key: 'x', label: 'X', title: 'X post', shareable: true },
  { key: 'instagram', label: 'Instagram', title: 'Instagram caption', shareable: true },
  { key: 'whatsapp', label: 'WhatsApp', title: 'WhatsApp status', shareable: true },
  { key: 'video', label: 'Video script', title: 'Short video script', shareable: false },
  { key: 'card', label: 'Card brief', title: 'News card brief', shareable: false },
];

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

  // One-click drafting through the GreaterNews helper on this PC (scripts/resolver.py), which holds the
  // Claude key — a public web page can't keep a key secret. It answers only the GreaterNews studio
  // (origin check). Where it isn't running, the manual copy/paste steps below still work.
  const [helper, setHelper] = useState<'checking' | 'online' | 'offline'>('checking');
  const [autoState, setAutoState] = useState<'idle' | 'busy'>('idle');
  const [autoSeconds, setAutoSeconds] = useState(0);

  useEffect(() => {
    let alive = true;
    fetch(`${CLAUDE_HELPER}/health`, { signal: AbortSignal.timeout(2500) })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { claude?: boolean } | null) => {
        if (alive) setHelper(data?.claude ? 'online' : 'offline');
      })
      .catch(() => {
        if (alive) setHelper('offline');
      });
    return () => {
      alive = false;
    };
  }, []);

  async function draftWithClaude() {
    if (autoState === 'busy') {
      return;
    }
    setAutoState('busy');
    setAutoSeconds(0);
    const started = Date.now();
    const timer = window.setInterval(() => setAutoSeconds(Math.round((Date.now() - started) / 1000)), 1000);
    try {
      let excerpt = '';
      if (draft.link) {
        try {
          excerpt = await fetchArticleExcerpt(draft.link);
        } catch {
          // Article not reachable — the brief still works from the feed summary.
        }
      }
      const response = await fetch(`${CLAUDE_HELPER}/draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' }, // a "simple" request: no extra CORS round-trip
        body: buildClaudeBrief(draft, excerpt),
        signal: AbortSignal.timeout(480_000),
      });
      const data = (await response.json()) as { text?: string; error?: string };
      const fields = data.text ? parsePackFields(data.text) : null;
      if (fields) {
        setDraft((current) => ({ ...current, ...fields }));
        setPasteMessage(`Claude verified the story and filled ${Object.keys(fields).length} fields — review them below.`);
      } else {
        setPasteMessage(data.error ? `Claude couldn't draft it: ${data.error}` : "Claude's reply had no fields block — try again, or use the manual steps.");
      }
    } catch {
      setHelper('offline');
      setPasteMessage('The Claude helper on this PC is not answering — use the manual steps below.');
    } finally {
      window.clearInterval(timer);
      setAutoState('idle');
      window.setTimeout(() => setPasteMessage(''), 9000);
    }
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

  // ---- rail hosts: CardDesigner portals its live preview + card buttons into these ----
  const [previewHost, setPreviewHost] = useState<HTMLDivElement | null>(null);
  const [actionsHost, setActionsHost] = useState<HTMLDivElement | null>(null);
  const [card, setCard] = useState<CardStatus>({ hasPhoto: false, hasCredit: false, headline: '', captions: 0, voice: 'Off' });
  const [outputTab, setOutputTab] = useState<OutputKey>('facebook');

  // ---- derived, read-only signals ----
  const storyPicked = draft.isLive || !placeholderHeadlines.has(draft.headline.trim());
  const sourceCount = countSources(draft.primarySource, draft.backupSources);
  const keyFactsFilled = draft.keyFacts.trim() !== '' && !placeholderFacts.has(draft.keyFacts.trim());
  const notes = draft.verificationNotes.trim();
  const notesWritten = notes !== '' && !defaultNotes.some((note) => notes.startsWith(note));
  const cardHeadlineWords = wordCount(card.headline);
  const cardHeadlineOk = cardHeadlineWords > 0 && cardHeadlineWords <= CARD_HEADLINE_MAX && !placeholderHeadlines.has(card.headline.trim());
  const draftReady = storyPicked && keyFactsFilled && notesWritten && sourceCount >= 2;
  const storyLogged = isAlreadyPosted(draft, postedLog);

  const checks = [
    { key: 'story', label: 'Story selected', done: storyPicked, target: 'step-desk', detail: draft.isLive ? draft.primarySource : '' },
    {
      key: 'headline',
      label: `Card headline ≤ ${CARD_HEADLINE_MAX} words`,
      done: cardHeadlineOk,
      target: 'step-card',
      detail: placeholderHeadlines.has(card.headline.trim()) ? 'placeholder' : cardHeadlineWords ? `${cardHeadlineWords} words` : '',
    },
    { key: 'sources', label: '2+ sources', done: sourceCount >= 2, target: 'step-draft', detail: `${sourceCount}` },
    { key: 'facts', label: 'Key facts filled', done: keyFactsFilled, target: 'step-draft', detail: '' },
    { key: 'notes', label: 'Verification notes written', done: notesWritten, target: 'step-draft', detail: '' },
    { key: 'photo', label: 'Photo with a credit line', done: card.hasPhoto && card.hasCredit, target: 'step-card', detail: card.hasPhoto && !card.hasCredit ? 'no credit' : '' },
    { key: 'status', label: 'Status is READY', done: draft.status === 'READY', target: 'step-draft', detail: draft.status === 'READY' ? '' : draft.status.toLowerCase() },
  ];
  const checksDone = checks.filter((check) => check.done).length;

  const stepDone: Record<string, boolean> = {
    'step-desk': storyPicked,
    'step-draft': draftReady,
    'step-outputs': draftReady,
    'step-card': cardHeadlineOk && card.hasPhoto && card.hasCredit,
    'step-video': card.captions > 0,
    'step-publish': storyLogged,
  };

  const feedsLive = liveFeedState.feedCount - liveFeedState.failedFeeds.length;
  const feedsKnown = liveFeedState.feedCount > 0;
  const feedsChip = !feedsKnown
    ? 'gn-chip gn-chip--warn'
    : feedsLive === liveFeedState.feedCount
      ? 'gn-chip gn-chip--ok'
      : feedsLive > 0
        ? 'gn-chip gn-chip--warn'
        : 'gn-chip gn-chip--err';
  const [refreshTime, refreshDay] = splitRefresh(liveFeedState.refreshedAt);
  const showFeedLine = liveFeedState.loading || Boolean(liveFeedState.error) || (!liveFeedState.loading && liveFeedState.itemCount === 0) || liveFeedState.failedFeeds.length > 0;
  const modeLabel = commandModes.find((option) => option.value === mode)?.label ?? '';

  const avgReactions = measured.length > 0 ? Math.round(measured.reduce((sum, entry) => sum + (entry.reactions ?? 0), 0) / measured.length) : null;

  const activeOutput = outputTabs.find((tab) => tab.key === outputTab) ?? outputTabs[0];
  const outputText = outputs[activeOutput.key];
  const scriptBeats = parseScript(outputs.video).beats;
  const outputMeta: Record<OutputKey, string> = {
    facebook: `${outputs.facebook.length} characters`,
    x: `${outputs.x.length}/280`,
    instagram: `${(outputs.instagram.match(/#[A-Za-z0-9_]+/g) ?? []).length} hashtags`,
    whatsapp: `${outputs.whatsapp.split('\n').filter(Boolean).length} lines`,
    video: `${scriptBeats.length} beats${scriptBeats.length ? ` · ${scriptBeats[scriptBeats.length - 1].time.split('-').pop()}` : ''}`,
    card: 'For the designer',
  };

  function renderOutputPreview(key: OutputKey) {
    switch (key) {
      case 'facebook':
        return <FacebookPreview text={outputs.facebook} />;
      case 'x':
        return <XPreview text={outputs.x} />;
      case 'instagram':
        return <InstagramPreview text={outputs.instagram} />;
      case 'whatsapp':
        return <WhatsAppPreview text={outputs.whatsapp} />;
      case 'video':
        return <ScriptTimeline text={outputs.video} />;
      default:
        return <CardBriefList text={outputs.card} />;
    }
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
            <div className="gn-brand__sub">News Studio</div>
          </div>
        </div>

        <nav className="gn-nav" aria-label="Workflow steps">
          <div className="gn-nav__label">Workflow</div>
          {workflowSections.map((section, index) => {
            const isActive = activeSection === section.id;
            const isDone = stepDone[section.id];
            return (
              <a
                key={section.id}
                href={`#${section.id}`}
                className={[isActive ? 'is-active' : '', isDone ? 'is-done' : ''].filter(Boolean).join(' ') || undefined}
                aria-current={isActive ? 'step' : undefined}
                title={isDone ? `${section.label} — done` : undefined}
                onClick={(event) => jumpToSection(event, section.id)}
              >
                <span className="gn-nav__num">{isDone ? '✓' : index + 1}</span>
                {section.label}
              </a>
            );
          })}
        </nav>

        <div className="gn-sidebar__foot">
          <div className="gn-nav__label">Status</div>
          <div className="app-engines">
            <span className={feedsChip}>{feedsKnown ? `Feeds · ${feedsLive}/${liveFeedState.feedCount} live` : 'Feeds · loading…'}</span>
            <span className={hostedProxy ? 'gn-chip gn-chip--ok' : 'gn-chip gn-chip--warn'} title="Drafts video scripts and speaks the voiceover">
              {hostedProxy ? 'Drafting + voice · hosted' : 'Drafting + voice · local only'}
            </span>
            <span className={webImageSearch ? 'gn-chip gn-chip--ok' : 'gn-chip'}>{webImageSearch ? 'Image search · web + free' : 'Image search · free sources'}</span>
            <span className={card.voice === 'Off' ? 'gn-chip' : 'gn-chip gn-chip--info'}>Voice · {card.voice}</span>
          </div>
          <p className="gn-hint app-version">GreaterNews Studio v{APP_VERSION}</p>
        </div>
      </aside>

      <main className="gn-main">
        <div className="gn-layout">
          <div className="gn-col">
            <section id="step-desk" className="gn-card gn-card--accent app-section app-hero">
              <StepHead
                step={1}
                name="Story desk"
                hero
                title="What's today's story?"
                sub="Pick a lead from today's live feeds, or filter by topic — then verify it in step 2."
              />

              <div className="hero-search">
                <label className="hero-search__field">
                  <span className="visually-hidden">Filter stories by topic</span>
                  <input
                    className="gn-input hero-search__input"
                    value={topic}
                    onChange={(event) => setTopic(event.target.value)}
                    placeholder="Filter by topic — e.g. cedi, Black Stars, South Africa"
                  />
                </label>
                <button type="button" className="gn-btn hero-search__btn" onClick={() => void refreshLiveStories()} disabled={liveFeedState.loading}>
                  {liveFeedState.loading ? <span className="gn-spin" aria-hidden="true" /> : <span aria-hidden="true">↻</span>}
                  {liveFeedState.loading ? 'Refreshing…' : 'Refresh feeds'}
                </button>
              </div>

              <div className="hero-modes">
                <span className="gn-small gn-muted">Mode</span>
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
              </div>

              <div className="gn-stats hero-stats">
                <div className="gn-stat">
                  <span className="gn-stat__v">{liveFeedState.loading && liveFeedState.itemCount === 0 ? '…' : liveFeedState.itemCount}</span>
                  <span className="gn-stat__k">Stories loaded</span>
                </div>
                <div className="gn-stat">
                  <span className="gn-stat__v">{feedsKnown ? `${feedsLive}/${liveFeedState.feedCount}` : '…'}</span>
                  <span className="gn-stat__k">Feeds live</span>
                </div>
                <div className="gn-stat">
                  <span className="gn-stat__v">{refreshTime || '—'}</span>
                  <span className="gn-stat__k">Refreshed{refreshDay ? ` · ${refreshDay}` : ''}</span>
                </div>
                <div className="gn-stat">
                  <span className="gn-stat__v">{weekEntries.length}</span>
                  <span className="gn-stat__k">Logged this week</span>
                </div>
              </div>

              {showFeedLine ? (
                <p className={`app-status app-status--${liveFeedState.loading ? 'busy' : liveFeedState.error || liveFeedState.itemCount === 0 ? 'err' : 'warn'}`}>
                  {liveFeedState.loading || liveFeedState.error || liveFeedState.itemCount === 0 ? `${liveFeedState.error || liveFeedState.message} ` : ''}
                  {liveFeedState.failedFeeds.length > 0 ? `Feeds unavailable: ${liveFeedState.failedFeeds.join(', ')}.` : ''}
                </p>
              ) : null}

              <div className="hero-picks__head">
                <span className="gn-eyebrow">Today's menu</span>
                <span className="gn-small gn-muted">
                  {storyMenu.length} {storyMenu.length === 1 ? 'story' : 'stories'} · {modeLabel}
                  {topic.trim() ? ` · “${topic.trim()}”` : ''}
                </span>
              </div>
              <div className="story-grid">
                {storyMenu.map((story, index) => {
                  const selected = draft.id === story.id;
                  return (
                    <article
                      key={story.id}
                      className={selected ? 'gn-item story-card is-selected' : 'gn-item story-card'}
                      onClick={() => setDraft(cloneDraft(story))}
                    >
                      <div className="story-card__top">
                        <span className="story-card__rank">{index + 1}</span>
                        <h3 className="story-card__title">{story.headline}</h3>
                      </div>
                      <p className="gn-item__summary story-card__summary">{story.menuNote}</p>
                      <div className="story-card__foot">
                        <div className="gn-item__meta story-card__meta">
                          <span className="gn-chip gn-chip--plain">{story.category}</span>
                          {story.status === 'DEVELOPING' ? <span className="gn-chip gn-chip--info">DEVELOPING</span> : null}
                          {!story.isLive ? <span className="gn-chip gn-chip--violet">Template slot</span> : null}
                          {isAlreadyPosted(story, postedLog) ? <span className="gn-chip gn-chip--warn">Posted</span> : null}
                          <span className="story-card__source">
                            {story.primarySource}
                            {story.publishedAt ? ` · ${formatDateTime(story.publishedAt)}` : ''}
                          </span>
                          {story.link ? (
                            <a href={story.link} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
                              open ↗
                            </a>
                          ) : null}
                        </div>
                        {selected ? (
                          <span className="gn-chip gn-chip--gold story-card__picked">In draft</span>
                        ) : (
                          <button
                            type="button"
                            className="gn-btn gn-btn--xs gn-btn--primary"
                            onClick={(event) => {
                              event.stopPropagation();
                              setDraft(cloneDraft(story));
                            }}
                          >
                            Use
                          </button>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>

            <section id="step-draft" className="gn-card app-section">
              <StepHead step={2} name="Draft & verify" title="Make the story ours" sub="Verify the lead, then shape the facts, sources and angle every format is built from.">
                <button type="button" className="gn-btn gn-btn--sm gn-btn--ghost" onClick={() => setDraft(cloneDraft(storyTemplates[0]))}>
                  Reset draft
                </button>
              </StepHead>

              <div className="ai-flow">
                <span className="ai-flow__label">Fast AI drafting</span>
                <div className="ai-flow__auto">
                  <button type="button" className="gn-btn gn-btn--primary" onClick={() => void draftWithClaude()} disabled={helper !== 'online' || autoState === 'busy'}>
                    {autoState === 'busy' ? <span className="gn-spin" aria-hidden="true" /> : <span aria-hidden="true">✨</span>}
                    {autoState === 'busy' ? `Claude is verifying the story… ${autoSeconds}s` : 'Draft with Claude — automatic'}
                  </button>
                  <span className={`gn-chip ${helper === 'online' ? 'gn-chip--ok' : helper === 'offline' ? 'gn-chip--warn' : ''}`}>
                    {helper === 'online' ? 'Claude helper on this PC · ready' : helper === 'offline' ? 'Helper not running on this device' : 'Checking…'}
                  </span>
                </div>
                <p className="gn-hint ai-flow__hint">
                  {helper === 'offline'
                    ? 'The automatic button works on the GreaterNews PC, where the Claude helper runs (it starts with the PC). On other devices, use the three steps below.'
                    : 'One click: Claude searches the web, checks 2+ independent sources and fills every field below — about a minute.'}
                </p>
                <details className="ai-flow__manual" open={helper === 'offline'}>
                  <summary>Or do it by hand with claude.ai</summary>
                <div className="ai-flow__steps">
                  <button type="button" className="gn-btn gn-btn--sm gn-btn--primary" onClick={() => void copyBriefWithContext()} disabled={briefState === 'busy'}>
                    {briefState === 'busy' ? <span className="gn-spin" aria-hidden="true" /> : null}
                    {briefState === 'busy' ? 'Fetching article context…' : briefState === 'copied' ? 'Copied ✓' : '1 · Copy Claude brief'}
                  </button>
                  <span className="ai-flow__arrow" aria-hidden="true">→</span>
                  <span className="ai-flow__step">2 · Paste into Claude, copy its reply</span>
                  <span className="ai-flow__arrow" aria-hidden="true">→</span>
                  <button type="button" className="gn-btn gn-btn--sm" onClick={() => void pasteClaudePack()}>
                    3 · Paste Claude pack
                  </button>
                </div>
                <p className="gn-hint ai-flow__hint">The brief packages the story with article context; the pack fills every field below automatically.</p>
                </details>
              </div>
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

              <div className="draft-panels">
                <Panel
                  icon="story"
                  title="The story"
                  className="draft-panel--wide"
                  aside={<span className={headlineWords > CARD_HEADLINE_MAX ? 'gn-chip gn-chip--warn' : 'gn-chip gn-chip--plain'}>{headlineWords} words</span>}
                >
                  <label className="gn-field">
                    <span className="gn-label">Headline</span>
                    <input className="gn-input" value={draft.headline} onChange={(event) => updateDraft('headline', event.target.value)} />
                    {headlineWords > 9 ? (
                      <em className="field-hint">ℹ {headlineWords} words — fine for posts; the card headline rule is max 9, so shorten it in the Card Studio.</em>
                    ) : null}
                  </label>
                  <div className="field-grid">
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
                    <div className="gn-field">
                      <span className="gn-label">Status</span>
                      <div className="gn-seg status-seg" role="group" aria-label="Story status">
                        {(['READY', 'DEVELOPING'] as const).map((status) => (
                          <button
                            key={status}
                            type="button"
                            className={draft.status === status ? `is-on status-seg--${status.toLowerCase()}` : undefined}
                            aria-pressed={draft.status === status}
                            onClick={() => updateDraft('status', status)}
                          >
                            {status}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </Panel>

                <Panel
                  icon="sources"
                  title="Sources"
                  aside={<span className={sourceCount >= 2 ? 'gn-chip gn-chip--ok' : 'gn-chip gn-chip--warn'}>{sourceCount} {sourceCount === 1 ? 'source' : 'sources'}</span>}
                >
                  <label className="gn-field">
                    <span className="gn-label">Primary source</span>
                    <input className="gn-input" value={draft.primarySource} onChange={(event) => updateDraft('primarySource', event.target.value)} />
                  </label>
                  <label className="gn-field">
                    <span className="gn-label">
                      Backup sources <span className="gn-hint">(comma-separated)</span>
                    </span>
                    <input className="gn-input" value={draft.backupSources} onChange={(event) => updateDraft('backupSources', event.target.value)} />
                  </label>
                  <label className="gn-field">
                    <span className="gn-label">Sources searched today</span>
                    <input className="gn-input" value={draft.sourcesSearched} onChange={(event) => updateDraft('sourcesSearched', event.target.value)} />
                  </label>
                </Panel>

                <Panel
                  icon="verified"
                  title="Verified facts & notes"
                  aside={<span className={notesWritten ? 'gn-chip gn-chip--ok' : 'gn-chip gn-chip--warn'}>{notesWritten ? 'Notes written' : 'Needs notes'}</span>}
                >
                  <label className="gn-field">
                    <span className="gn-label">Key facts (verified only)</span>
                    <textarea className="gn-textarea" value={draft.keyFacts} onChange={(event) => updateDraft('keyFacts', event.target.value)} rows={4} />
                  </label>
                  <label className="gn-field">
                    <span className="gn-label">
                      Verification notes <span className="gn-hint">(what you checked, against what)</span>
                    </span>
                    <textarea className="gn-textarea" value={draft.verificationNotes} onChange={(event) => updateDraft('verificationNotes', event.target.value)} rows={3} />
                  </label>
                </Panel>

                <Panel
                  icon="angle"
                  title="Angle & engagement"
                  className="draft-panel--wide"
                  aside={draft.quote.trim() ? <span className={quoteWords > 15 ? 'gn-chip gn-chip--err' : 'gn-chip gn-chip--plain'}>quote {quoteWords}/15 words</span> : null}
                >
                  <div className="angle-grid">
                  <label className="gn-field">
                    <span className="gn-label">Our angle</span>
                    <textarea className="gn-textarea" value={draft.angle} onChange={(event) => updateDraft('angle', event.target.value)} rows={4} />
                    <span className="bucket-chips angle-chips">
                      {angleIdeas[draft.category].map((idea) => (
                        <button key={idea} type="button" className="gn-chip gn-chip--plain gn-chip--btn" onClick={() => updateDraft('angle', idea)}>
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
                  </div>
                </Panel>
              </div>
            </section>

            <section id="step-outputs" className="gn-card app-section">
              <StepHead step={3} name="Outputs" title="Every format, ready to post" sub="Generated from your draft — preview how each platform will read it, then copy." />

              <div className="gn-seg out-tabs" role="tablist" aria-label="Output format">
                {outputTabs.map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    role="tab"
                    aria-selected={outputTab === tab.key}
                    className={outputTab === tab.key ? 'is-on' : undefined}
                    onClick={() => setOutputTab(tab.key)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div className="out-stage" role="tabpanel" aria-label={activeOutput.title}>
                <div className="out-stage__bar">
                  <div className="out-stage__title">
                    <h3 className="gn-h3">{activeOutput.title}</h3>
                    <span className={activeOutput.key === 'x' && outputs.x.length > 280 ? 'gn-chip gn-chip--err' : 'gn-chip gn-chip--plain'}>{outputMeta[activeOutput.key]}</span>
                  </div>
                  <div className="gn-actions">
                    {activeOutput.shareable ? <ShareButton text={outputText} title={draft.headline} /> : null}
                    <CopyButton key={activeOutput.key} text={outputText} className="gn-btn gn-btn--sm gn-btn--primary" />
                  </div>
                </div>
                <div className="out-stage__view">{renderOutputPreview(activeOutput.key)}</div>
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
              previewHost={previewHost}
              actionsHost={actionsHost}
              onStatusChange={setCard}
            />

            <section id="step-publish" className="gn-card app-section">
              <StepHead step={6} name="Publish & track" title="Posted log" sub="Log each story after it goes out so nothing repeats — then add reach and reactions.">
                <button type="button" className="gn-btn gn-btn--primary" onClick={() => logStory(draft, date)}>
                  Log current story
                </button>
              </StepHead>

              <div className="gn-stats publish-stats">
                <div className="gn-stat">
                  <span className="gn-stat__v">{postedLog.length}</span>
                  <span className="gn-stat__k">Logged</span>
                </div>
                <div className="gn-stat">
                  <span className="gn-stat__v">{weekEntries.length}</span>
                  <span className="gn-stat__k">This week</span>
                </div>
                <div className="gn-stat">
                  <span className="gn-stat__v">{followUps.length}</span>
                  <span className="gn-stat__k">Awaiting follow-up</span>
                </div>
                <div className="gn-stat">
                  <span className="gn-stat__v">{avgReactions ?? '—'}</span>
                  <span className="gn-stat__k">Avg reactions</span>
                </div>
              </div>

              <div className="log-tools">
                <span className="log-tools__label">Log file</span>
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
                </div>
              </div>
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

          <aside className="gn-rail app-rail" aria-label="Preview and publish">
            <section className="gn-card rail-card rail-preview" aria-label="Live card preview">
              <div ref={setPreviewHost} className="rail-preview__host" />
            </section>

            <section className="gn-card rail-card" aria-label="Publish pack">
              <div className="rail-card__head">
                <span className="gn-eyebrow">Publish pack</span>
                <label className="app-date">
                  <span className="visually-hidden">Pack date</span>
                  <input className="gn-input" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
                </label>
              </div>
              <div className="rail-actions">
                <button type="button" className="gn-btn gn-btn--primary" onClick={() => downloadText(`greaternews_${date}.md`, pack)}>
                  Save pack
                </button>
                <CopyButton text={pack} label="Copy pack" className="gn-btn" />
                <div ref={setActionsHost} className="rail-actions__slot" />
              </div>
              <p className="gn-hint rail-card__hint" title={`Saves greaternews_${date}.md`}>One .md file: the menu, the story and every format.</p>
            </section>

            <section className="gn-card rail-card" aria-label="Ready to publish checklist">
              <div className="rail-card__head">
                <span className="gn-eyebrow">Ready to publish</span>
                <span className={checksDone === checks.length ? 'rail-score is-complete' : 'rail-score'}>
                  {checksDone}/{checks.length}
                </span>
              </div>
              <div className={checksDone === checks.length ? 'gn-progress is-complete' : 'gn-progress'} aria-hidden="true">
                <span style={{ width: `${(checksDone / checks.length) * 100}%` }} />
              </div>
              <ul className="gn-checklist">
                {checks.map((check) => (
                  <li key={check.key}>
                    <a href={`#${check.target}`} className={check.done ? 'gn-check is-done' : 'gn-check'} onClick={(event) => jumpToSection(event, check.target)}>
                      <span className="gn-check__box" aria-hidden="true" />
                      <span>
                        {check.label}
                        <span className="visually-hidden">{check.done ? ' — done' : ' — to do'}</span>
                      </span>
                      {check.detail ? <span className="gn-check__detail">{check.detail}</span> : null}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          </aside>
        </div>
        <div id="gn-page-end" className="app-page-end" aria-hidden="true" />
      </main>
    </div>
  );
}
