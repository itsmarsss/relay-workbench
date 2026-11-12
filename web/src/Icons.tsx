import type { CSSProperties, ReactNode } from 'react';

// The same SVG marks and stroke weight as the original Relay workbench.
const paths: Record<string, ReactNode> = {
  grip: <path d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01" strokeWidth="3" />,
  board: (
    <>
      <rect x="3" y="4" width="5" height="16" rx="1" />
      <rect x="10" y="4" width="5" height="11" rx="1" />
      <rect x="17" y="4" width="4" height="14" rx="1" />
    </>
  ),
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  relay: <path d="M5 5h7a4 4 0 0 1 0 8H5V5Zm7 8 7 6M5 13v6M17 5h2v2" />,
  tasks: <path d="m12 3 10 5-10 5L2 8l10-5Zm-9 9 9 5 9-5M3 16l9 5 9-5" />,
  repository: (
    <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
  ),
  settings: (
    <>
      <path d="M4 7h16M4 17h16" />
      <circle cx="9" cy="7" r="3" />
      <circle cx="15" cy="17" r="3" />
    </>
  ),
  memory: <path d="M3 4h7l2 2 2-2h7v16h-7l-2 2-2-2H3V4Zm9 2v16" />,
  inbox: (
    <>
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="2" />
      <rect x="14" y="3" width="7" height="7" rx="2" />
      <rect x="3" y="14" width="7" height="7" rx="2" />
      <rect x="14" y="14" width="7" height="7" rx="2" />
    </>
  ),
  list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
  sidebar: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M9 4v16" />
    </>
  ),
  bolt: <path d="m13 2-9 12h7l-1 8 10-12h-7l1-8Z" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="13" rx="2" />
      <path d="M16 8V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h4" />
    </>
  ),
  edit: <path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6Z" />,
  trash: <path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6" />,
  resize: <path d="m8 20 12-12M14 20l6-6M20 20h.01" />,
  graph: (
    <>
      <rect x="8" y="3" width="8" height="6" rx="2" />
      <rect x="2" y="16" width="7" height="5" rx="1.5" />
      <rect x="15" y="16" width="7" height="5" rx="1.5" />
      <path d="M12 9v4H5.5v3M12 13h6.5v3" />
    </>
  ),
  chevron: <path d="m9 5 7 7-7 7" />,
  fold: <path d="m4 6 5 6-5 6M20 6l-5 6 5 6" />,
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  back: <path d="M19 12H5m5-5-5 5 5 5" />,
  check: <path d="m5 12 4 4L19 6" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  git: (
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="6" r="2" />
      <path d="M6 7v10m0-3h6a6 6 0 0 0 6-6" />
    </>
  ),
  'pull-request': (
    <>
      <circle cx="6" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="18" r="2" />
      <path d="M6 8v8M18 16V9a3 3 0 0 0-3-3h-3m2.5-2.5L12 6l2.5 2.5" />
    </>
  ),
  alert: <path d="M12 4 2.5 20h19L12 4Zm0 6v4.5m0 2.5v.01" />,
  code: <path d="m8 6-6 6 6 6m8-12 6 6-6 6m-5 3 2-18" />,
  pause: <path d="M8 5v14M16 5v14" />,
  stop: <rect x="5" y="5" width="14" height="14" rx="3" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  search: (
    <>
      <circle cx="10" cy="10" r="6" />
      <path d="m15 15 5 5" />
    </>
  ),
  send: (
    <>
      <path d="m3 11 18-8-8 18-2-8-8-2Z" />
      <path d="m11 13 10-10" />
    </>
  ),
  chat: <path d="M20 11a8 8 0 0 1-8 8H8l-5 2 1-5a8 8 0 1 1 16-5Z" />,
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="m7 9 3 3-3 3m6 0h4" />
    </>
  ),
  storage: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M3 12h18M7 8h1m-1 8h1m4 0h5" />
    </>
  ),
  expand: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />,
  external: (
    <path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" />
  ),
  'split-horizontal': (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M12 4v16" />
    </>
  ),
  'split-vertical': (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 12h18" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 1v2m0 18v2M1 12h2m18 0h2M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2" />
    </>
  ),
  moon: <path d="M20 15.5A9 9 0 0 1 8.5 4a9 9 0 1 0 11.5 11.5Z" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
};

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.bolt}
    </svg>
  );
}

export function RelayMark({ size = 32 }: { size?: number }) {
  return (
    <span className="relay-mark" style={{ width: size, height: size }} aria-hidden="true">
      <Icon name="relay" size={size * 0.68} />
    </span>
  );
}

export function providerName(provider: string) {
  return (
    ({ codex: 'Codex', claude: 'Claude', pi: 'Pi' } as Record<string, string>)[provider] ||
    provider ||
    'Relay'
  );
}

export function ProviderIcon({ provider, size = 28 }: { provider: string; size?: number }) {
  const mark =
    provider === 'codex' ? (
      <>
        <rect x="2.5" y="3.5" width="19" height="17" rx="5" />
        <path d="m7 9 3 3-3 3m6 0h4" />
      </>
    ) : provider === 'claude' ? (
      <>
        {Array.from({ length: 12 }, (_, i) => (
          <path key={i} d="M12 3v5" transform={`rotate(${i * 30} 12 12)`} />
        ))}
        <circle cx="12" cy="12" r="3" />
      </>
    ) : provider === 'pi' ? (
      <>
        <path d="M5 7h14M9 7v10m7-10v8c0 2 1 3 3 2" />
        <path d="M4 8c1-2 2-2 4-2" />
      </>
    ) : (
      paths.relay
    );
  return (
    <span
      className={`provider-mark provider-${['codex', 'claude', 'pi'].includes(provider) ? provider : 'relay'}`}
      style={{ '--provider-size': `${size}px` } as CSSProperties}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {mark}
      </svg>
    </span>
  );
}

export function ProviderName({ provider, size = 24 }: { provider: string; size?: number }) {
  return (
    <span className="provider-identity">
      <ProviderIcon provider={provider} size={size} />
      <span>{providerName(provider)}</span>
    </span>
  );
}
