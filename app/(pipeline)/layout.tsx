/**
 * The single first-run gate (FR-33). Every pipeline page lives in this route
 * group (URLs are unchanged — the group segment is invisible), so the gate is
 * enforced at exactly one boundary: until onboarding is finished or a user
 * base resume exists (in-app or a resume/ file), every pipeline page redirects
 * to the guided flow at /setup. /setup itself and the API routes are outside
 * the group.
 */
import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getDb } from '@/lib/db';
import { needsOnboarding } from '@/lib/resume/onboarding';

export const dynamic = 'force-dynamic';

export default function PipelineLayout({ children }: { children: ReactNode }) {
  if (needsOnboarding(getDb())) redirect('/setup');
  return children;
}
