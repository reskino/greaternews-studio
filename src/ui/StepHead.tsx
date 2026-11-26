import type { ReactNode } from 'react';

/** Section header in the GN pattern: "STEP n · NAME" eyebrow, display title, one-line purpose, actions on the right. */
export default function StepHead({
  step,
  name,
  title,
  sub,
  hero = false,
  children,
}: {
  step: number;
  name: string;
  title: string;
  sub: string;
  hero?: boolean;
  children?: ReactNode;
}) {
  return (
    <header className="gn-card__head step-head">
      <div>
        <span className="gn-eyebrow">
          Step {step} · {name}
        </span>
        {hero ? <h1 className="gn-h1 step-head__hero">{title}</h1> : <h2 className="gn-h2">{title}</h2>}
        <p className="gn-sub">{sub}</p>
      </div>
      {children ? <div className="gn-actions step-head__actions">{children}</div> : null}
    </header>
  );
}

const iconPaths = {
  story: 'M6 3h9l4 4v14H6V3Zm9 0v4h4M9 11h7M9 15h7M9 19h4',
  sources: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  verified: 'M12 3l7 3v6c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6l7-3Zm-3.5 9 2.5 2.5 4.5-5',
  angle: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12ZM8.5 12h.01M12 12h.01M15.5 12h.01',
  photo: 'M4 6h16v13H4V6Zm0 10 5-5 4 4 2-2 5 5M15 9.5h.01',
  text: 'M5 6V4h14v2M12 4v16M9 20h6',
  palette: 'M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.9 1.2-1.8-.5-1.2.3-2.2 1.5-2.2H17a4 4 0 0 0 4-4 9 9 0 0 0-9-10ZM7.5 11.5h.01M10 7.5h.01M15 7.5h.01',
  script: 'M5 5h14M5 10h14M5 15h9M5 20h6',
  film: 'M4 4h16v16H4V4Zm4 0v16M16 4v16M4 9h4M4 15h4M16 9h4M16 15h4',
} as const;

export type IconName = keyof typeof iconPaths;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="gn-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={iconPaths[name]} />
    </svg>
  );
}

/** A titled sub-panel inside a section card. */
export function Panel({ icon, title, aside, className = '', children }: { icon: IconName; title: string; aside?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <div className={`gn-panel ${className}`.trim()}>
      <div className="gn-panel__head">
        <h3 className="gn-panel__title">
          <span className="gn-panel__icon">
            <Icon name={icon} />
          </span>
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </div>
  );
}
