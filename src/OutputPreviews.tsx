// Read-only previews of the generated posts, styled like each network so the editor sees how the
// text will actually read. They only display the strings from outputs.ts — copying always uses
// the raw text, never what is rendered here.
import type { ReactNode } from 'react';

const logoSrc = `${import.meta.env.BASE_URL}logo.png`;

/** Colour #hashtags (and, for WhatsApp, render *bold* the way the app does). Everything else stays plain text. */
function richText(text: string, whatsappBold = false): ReactNode[] {
  const pattern = whatsappBold ? /(#[A-Za-z0-9_]+|\*[^*\n]+\*)/g : /(#[A-Za-z0-9_]+)/g;
  return text.split(pattern).map((part, index) => {
    if (part.length > 1 && part.startsWith('#')) {
      return (
        <span key={index} className="gn-social__tag">
          {part}
        </span>
      );
    }
    if (whatsappBold && part.length > 2 && part.startsWith('*') && part.endsWith('*')) {
      return <strong key={index}>{part.slice(1, -1)}</strong>;
    }
    return part;
  });
}

function Avatar({ size = '', ring = false }: { size?: '' | 'sm'; ring?: boolean }) {
  return (
    <span className={`gn-avatar${size ? ` gn-avatar--${size}` : ''}${ring ? ' gn-avatar--ring' : ''}`}>
      <img src={logoSrc} alt="" />
    </span>
  );
}

const icons = {
  like: 'M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3Zm0 0 4-7a2 2 0 0 1 3 2l-1 5h6a2 2 0 0 1 2 2.3l-1.3 7A2 2 0 0 1 17.7 21H7',
  comment: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z',
  share: 'M14 5l7 7-7 7M21 12H9a6 6 0 0 0-6 6',
  heart: 'M12 20s-7-4.4-9-9a4.8 4.8 0 0 1 9-3 4.8 4.8 0 0 1 9 3c-2 4.6-9 9-9 9Z',
  send: 'M21 3 10 14M21 3l-7 18-4-7-7-4 18-7Z',
  save: 'M6 3h12v18l-6-4-6 4V3Z',
};

function Icon({ path }: { path: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}

export function FacebookPreview({ text }: { text: string }) {
  return (
    <article className="gn-social gn-social--fb" aria-label="Facebook post preview">
      <header className="gn-social__head">
        <Avatar />
        <div>
          <div className="gn-social__name">GreaterNews</div>
          <div className="gn-social__meta">Just now · 🌐</div>
        </div>
        <span className="gn-social__more" aria-hidden="true">
          ···
        </span>
      </header>
      <div className="gn-social__body">{richText(text)}</div>
      <footer className="gn-social__bar" aria-hidden="true">
        <span>
          <Icon path={icons.like} />
          Like
        </span>
        <span>
          <Icon path={icons.comment} />
          Comment
        </span>
        <span>
          <Icon path={icons.share} />
          Share
        </span>
      </footer>
    </article>
  );
}

/** Twitter-style ring that fills as the post approaches the limit. */
export function CharRing({ used, max }: { used: number; max: number }) {
  const radius = 9.5;
  const circumference = 2 * Math.PI * radius;
  const ratio = Math.min(used / max, 1);
  const state = used > max ? ' is-over' : used > max - 20 ? ' is-near' : '';
  return (
    <svg className={`gn-ring${state}`} viewBox="0 0 24 24" aria-hidden="true">
      <circle className="gn-ring__track" cx="12" cy="12" r={radius} />
      <circle className="gn-ring__bar" cx="12" cy="12" r={radius} strokeDasharray={circumference} strokeDashoffset={circumference * (1 - ratio)} />
    </svg>
  );
}

export function XPreview({ text, limit = 280 }: { text: string; limit?: number }) {
  return (
    <article className="gn-social gn-social--x" aria-label="X post preview">
      <Avatar />
      <div>
        <div className="gn-social__line">
          <span className="gn-social__name">GreaterNews</span>
          <span className="gn-social__meta">@GreaterNews · now</span>
        </div>
        <div className="gn-social__body">{richText(text)}</div>
        <footer className="gn-social__foot">
          <span>
            {text.length} / {limit} characters
          </span>
          <CharRing used={text.length} max={limit} />
        </footer>
      </div>
    </article>
  );
}

export function InstagramPreview({ text }: { text: string }) {
  return (
    <article className="gn-social gn-social--ig" aria-label="Instagram caption preview">
      <header className="gn-social__head">
        <Avatar size="sm" ring />
        <div className="gn-social__name">greaternews</div>
        <span className="gn-social__more" aria-hidden="true">
          ···
        </span>
      </header>
      <div className="gn-social__icons" aria-hidden="true">
        <span>
          <Icon path={icons.heart} />
        </span>
        <span>
          <Icon path={icons.comment} />
        </span>
        <span>
          <Icon path={icons.send} />
        </span>
        <span>
          <Icon path={icons.save} />
        </span>
      </div>
      <div className="gn-social__body">
        <b>greaternews</b>
        {richText(text)}
      </div>
    </article>
  );
}

export function WhatsAppPreview({ text }: { text: string }) {
  return (
    <div className="gn-wa" aria-label="WhatsApp message preview">
      <div className="gn-wa__bar">
        <Avatar size="sm" />
        <div>
          <strong>GreaterNews</strong>
          <small>Status update</small>
        </div>
      </div>
      <div className="gn-wa__chat">
        <span className="gn-wa__day">Today</span>
        <div className="gn-wa__bubble">
          {richText(text, true)}
          <span className="gn-wa__time">
            now<b aria-hidden="true">✓✓</b>
          </span>
        </div>
      </div>
    </div>
  );
}

/** "HOOK (0-3s): …" lines → beats; "Source: …" → the footer line. */
export function parseScript(text: string) {
  const beats: Array<{ label: string; time: string; text: string }> = [];
  let source = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const beat = line.match(/^([A-Z][A-Z ]*?)\s*\(([^)]*)\):\s*(.*)$/);
    if (beat) {
      beats.push({ label: beat[1], time: beat[2], text: beat[3] });
    } else if (/^Source:/i.test(line)) {
      source = line.replace(/^Source:\s*/i, '');
    } else if (line && beats.length > 0) {
      beats[beats.length - 1].text += ` ${line}`;
    }
  }
  return { beats, source };
}

export function ScriptTimeline({ text }: { text: string }) {
  const { beats, source } = parseScript(text);
  if (beats.length === 0) {
    return <pre className="app-plain">{text}</pre>;
  }
  return (
    <div className="script-timeline">
      <ol className="gn-timeline">
        {beats.map((beat) => (
          <li className="gn-timeline__item" key={`${beat.label}-${beat.time}`}>
            <span className="gn-timeline__time">{beat.time}</span>
            <span className="gn-timeline__rail" aria-hidden="true" />
            <div>
              <span className="gn-timeline__label">{beat.label}</span>
              <p className="gn-timeline__text">{beat.text}</p>
            </div>
          </li>
        ))}
      </ol>
      {source ? <p className="gn-hint script-timeline__source">Source: {source}</p> : null}
    </div>
  );
}

/** "KEY: value" lines → a definition list. */
export function CardBriefList({ text }: { text: string }) {
  const rows = text
    .split('\n')
    .map((line) => line.match(/^([A-Z][A-Z ]+):\s*(.*)$/))
    .filter((match): match is RegExpMatchArray => match !== null);
  if (rows.length === 0) {
    return <pre className="app-plain">{text}</pre>;
  }
  return (
    <dl className="gn-kvlist">
      {rows.map((row) => [
        <dt key={`${row[1]}-k`}>{row[1].toLowerCase()}</dt>,
        <dd key={`${row[1]}-v`}>{row[2]}</dd>,
      ])}
    </dl>
  );
}
