import { describe, it, expect } from 'vitest';
import { JOB_STATUSES } from '../types';
import type { JobStatus } from '../types';
import {
  TRANSITIONS,
  canTransition,
  assertTransition,
  isTerminal,
  canPass,
  canContinue,
  canApprove,
  canEdit,
  canOpenRewrite,
  isTrackerStatus,
  DECISION_QUEUE_STATUSES,
  TRACKER_STATUSES,
} from './transitions';

// The full set of transitions the state machine permits. Every (from -> to)
// pair listed here must be allowed; every pair NOT listed must be rejected.
const VALID: ReadonlyArray<[JobStatus, JobStatus]> = [
  ['new', 'scored'],
  ['scored', 'passed'],
  ['scored', 'rewriting'],
  ['rewriting', 'approved'],
  ['rewriting', 'passed'],
  ['approved', 'rewriting'],
  ['approved', 'applied'],
  ['applied', 'interview'],
  ['applied', 'rejected'],
  ['applied', 'withdrawn'],
  ['applied', 'ghosted'],
  ['interview', 'offer'],
  ['interview', 'rejected'],
  ['interview', 'withdrawn'],
  ['offer', 'accepted'],
  ['offer', 'withdrawn'],
];

const TERMINAL: readonly JobStatus[] = [
  'passed',
  'accepted',
  'rejected',
  'withdrawn',
  'ghosted',
];

describe('transition table integrity', () => {
  it('has an entry for every status in the union', () => {
    for (const status of JOB_STATUSES) {
      expect(TRANSITIONS[status]).toBeDefined();
    }
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...JOB_STATUSES].sort());
  });

  it('only ever targets statuses that exist in the union', () => {
    for (const targets of Object.values(TRANSITIONS)) {
      for (const target of targets) {
        expect(JOB_STATUSES).toContain(target);
      }
    }
  });

  it('never lists a self-transition', () => {
    for (const status of JOB_STATUSES) {
      expect(TRANSITIONS[status]).not.toContain(status);
    }
  });
});

describe('canTransition — every valid transition is allowed', () => {
  it.each(VALID)('%s -> %s is allowed', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });
});

describe('canTransition — every invalid transition is rejected', () => {
  // Exhaustively check the full from x to matrix; anything not in VALID must be false.
  const validSet = new Set(VALID.map(([f, t]) => `${f}->${t}`));
  for (const from of JOB_STATUSES) {
    for (const to of JOB_STATUSES) {
      const allowed = validSet.has(`${from}->${to}`);
      if (allowed) continue;
      it(`${from} -> ${to} is rejected`, () => {
        expect(canTransition(from, to)).toBe(false);
      });
    }
  }
});

describe('assertTransition', () => {
  it('does not throw on a valid transition', () => {
    expect(() => assertTransition('scored', 'rewriting')).not.toThrow();
  });

  it('throws on an invalid transition with a descriptive message', () => {
    expect(() => assertTransition('new', 'approved')).toThrow(
      'Invalid status transition: new -> approved',
    );
  });
});

describe('isTerminal', () => {
  it.each(TERMINAL)('%s is terminal', (status) => {
    expect(isTerminal(status)).toBe(true);
  });

  it.each(JOB_STATUSES.filter((s) => !TERMINAL.includes(s)))(
    '%s is not terminal',
    (status) => {
      expect(isTerminal(status)).toBe(false);
    },
  );
});

describe('action predicates', () => {
  it('canPass from scored (decline in triage) or rewriting (back out of a rewrite)', () => {
    for (const status of JOB_STATUSES) {
      expect(canPass(status)).toBe(status === 'scored' || status === 'rewriting');
    }
  });

  it('canContinue only from scored', () => {
    for (const status of JOB_STATUSES) {
      expect(canContinue(status)).toBe(status === 'scored');
    }
  });

  it('canApprove only from rewriting', () => {
    for (const status of JOB_STATUSES) {
      expect(canApprove(status)).toBe(status === 'rewriting');
    }
  });

  it('canEdit only while rewriting (gates autosave and regenerate)', () => {
    for (const status of JOB_STATUSES) {
      expect(canEdit(status)).toBe(status === 'rewriting');
    }
  });

  it('canOpenRewrite while mid-rewrite or once approved (reopenable)', () => {
    for (const status of JOB_STATUSES) {
      expect(canOpenRewrite(status)).toBe(status === 'rewriting' || status === 'approved');
    }
  });

  it('isTrackerStatus covers approved and everything downstream, not the queue stages', () => {
    const expected: JobStatus[] = [
      'approved',
      'applied',
      'interview',
      'offer',
      'accepted',
      'rejected',
      'withdrawn',
      'ghosted',
    ];
    for (const status of JOB_STATUSES) {
      expect(isTrackerStatus(status)).toBe(expected.includes(status));
    }
    // Order matters too: the Tracker board renders its lanes in this order.
    expect([...TRACKER_STATUSES]).toEqual(expected);
    // Queue/in-progress stages are excluded.
    for (const s of ['new', 'scored', 'passed', 'rewriting'] as JobStatus[]) {
      expect(isTrackerStatus(s)).toBe(false);
    }
  });
});

describe('named status sets', () => {
  it('the decision queue is exactly the triage stages, in lifecycle order', () => {
    expect([...DECISION_QUEUE_STATUSES]).toEqual(['new', 'scored']);
  });

  it('the decision queue and the tracker never overlap', () => {
    for (const status of DECISION_QUEUE_STATUSES) {
      expect(TRACKER_STATUSES).not.toContain(status);
    }
  });

  it('every named-set member is a status in the union', () => {
    for (const status of [...DECISION_QUEUE_STATUSES, ...TRACKER_STATUSES]) {
      expect(JOB_STATUSES).toContain(status);
    }
  });

  it('the named sets plus the deliberate outsiders cover every status', () => {
    // A new status must land in a named set or be consciously added here —
    // otherwise it would be invisible to both the decision queue and the
    // Tracker, and this test fails loudly instead.
    const outsiders: JobStatus[] = ['passed', 'rewriting'];
    expect(new Set([...DECISION_QUEUE_STATUSES, ...TRACKER_STATUSES, ...outsiders])).toEqual(
      new Set(JOB_STATUSES),
    );
  });
});
