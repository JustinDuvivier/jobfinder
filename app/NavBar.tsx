'use client';

import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/jobs', label: 'Jobs' },
  { href: '/companies', label: 'Companies' },
  { href: '/rewrites', label: 'Rewrites' },
  { href: '/tracker', label: 'Tracker' },
  { href: '/usage', label: 'Usage' },
  { href: '/setup', label: 'Settings' },
];

/**
 * The HUD top bar. Highlights the active section using the current pathname so
 * the operator always knows which stage of the pipeline they are in.
 */
export function NavBar() {
  const pathname = usePathname() ?? '/';
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/');

  return (
    <nav className="nav">
      <a href="/" className="brand">
        <span className="brand-mark" aria-hidden />
        JobFinder
      </a>
      {LINKS.map((l) => (
        <a key={l.href} href={l.href} className={isActive(l.href) ? 'active' : undefined}>
          {l.label}
        </a>
      ))}
      <span className="spacer" />
      <span className="status" title="Running locally" style={{ borderColor: 'rgba(76,203,139,0.4)', color: 'var(--green)' }}>
        Local
      </span>
    </nav>
  );
}
