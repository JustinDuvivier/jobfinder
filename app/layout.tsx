import type { ReactNode } from 'react';
import './globals.css';
import { NavBar } from './NavBar';
import { RewriteStatusIndicator } from './RewriteStatusIndicator';

export const metadata = {
  title: 'JobFinder',
  description: 'Personal LinkedIn job-application pipeline.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: browser extensions (Grammarly, Dark Reader,
    // password managers, …) inject attributes onto <html>/<body> after the
    // server HTML arrives, which React otherwise reports as a hydration
    // mismatch. Our own markup here is deterministic, so suppressing the warning
    // on just these two elements is the sanctioned fix and does not mask app
    // bugs (it only applies one level deep, not to children).
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,600;12..96,700;12..96,800&family=JetBrains+Mono:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body suppressHydrationWarning>
        <NavBar />
        {children}
        <RewriteStatusIndicator />
      </body>
    </html>
  );
}
