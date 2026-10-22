// The question loop's factory side (T180, AC-033): the questions under `## Clarifications` in
// `spec.md` and `plan.md`, the Owner's `answers.md`, and which questions are still open, read by
// factory code from the files at the branch head, never from a session's word.
import { describe, expect, it } from 'vitest';
import {
  answersToApply,
  answerCounts,
  openQuestions,
  parseAnswers,
  questionAlert,
  questionProblems,
  questionsIn,
} from '../../src/stations/checks/questions.js';

const clarifications = (...questions: string[]) =>
  ['# Spec', '', '## Clarifications', '', ...questions, '', '## Problem', 'Text.', ''].join('\n');

const Q1 = [
  '- Q1: Which sign-in should visitors use?',
  '  - Why it matters: it changes the login page.',
  '  - Options: A) Email and password B) A magic link by email C) Both',
  '  - Recommended: B, because it needs no password store.',
].join('\n');
const Q2 = '- Q2: How long does a session last?\n  - Options: a short answer, at most five words';

describe('the questions under ## Clarifications (T180)', () => {
  it('reads each question, its options, its applied answer and its Owner action', () => {
    const text = clarifications(
      Q1,
      '- Q2: How long does a session last? → A: one week',
      '- Q3 (follow-up): Who may invite others? → A: B → Owner action: tier raise',
    );
    expect(questionsIn(text, 'spec.md')).toEqual([
      {
        file: 'spec.md',
        n: 1,
        followUp: false,
        text: 'Which sign-in should visitors use?',
        options: { A: 'Email and password', B: 'A magic link by email', C: 'Both' },
      },
      {
        file: 'spec.md',
        n: 2,
        followUp: false,
        text: 'How long does a session last?',
        options: {},
        applied: 'one week',
      },
      {
        file: 'spec.md',
        n: 3,
        followUp: true,
        text: 'Who may invite others?',
        options: {},
        applied: 'B',
        ownerAction: 'tier raise',
      },
    ]);
  });

  it('reads no question outside ## Clarifications, and none from a file without it', () => {
    expect(questionsIn('## Problem\n- Q1: Not a question here?\n', 'spec.md')).toEqual([]);
  });

  it('reads the Owner’s A<n> lines, the last line for a number winning', () => {
    const answers = parseAnswers('# Answers\n\nA1. B\nA2: two weeks\nnot an answer\nA1. C\n');
    expect([...answers]).toEqual([
      [1, 'C'],
      [2, 'two weeks'],
    ]);
  });
});

describe('which answers count: an option, or five words or fewer (clarify’s rule)', () => {
  const [q1] = questionsIn(clarifications(Q1), 'spec.md');
  it.each([
    ['B', true],
    ['a magic link', true],
    ['Both, as long as the link expires', false],
    ['A magic link by email', true],
    ['B) A magic link by email.', true],
    ['  ', false],
  ])('AC-033: the answer %j counts: %s', (answer, counts) => {
    expect(q1 && answerCounts(q1, answer)).toBe(counts);
  });
});

describe('open questions at the branch head (T180)', () => {
  const spec = clarifications(Q1, Q2);

  it('AC-033: a question without an answer, or with one that does not count, is open', () => {
    const open = openQuestions({ spec }, parseAnswers('A1. Both, as long as the link expires\n'));
    expect(open.map((q) => [q.n, q.why])).toEqual([
      [1, 'answer'],
      [2, 'unanswered'],
    ]);
  });

  it('AC-033: once every open question has an answer that counts, none is open', () => {
    expect(openQuestions({ spec }, parseAnswers('A1. B\nA2. one week\n'))).toEqual([]);
  });

  it('an applied question is closed; one needing an Owner action stays open until answered differently', () => {
    const applied = clarifications(
      '- Q1: Which sign-in? → A: B',
      '- Q2: Who may invite others? → A: admins → Owner action: brief change',
    );
    const open = (answers: string) =>
      openQuestions({ spec: applied }, parseAnswers(`A1. B\n${answers}`));
    expect(open('A2. admins\n').map((q) => [q.n, q.why, q.ownerAction])).toEqual([
      [2, 'action', 'brief change'],
    ]);
    expect(open('').map((q) => q.n)).toEqual([2]);
    expect(open('A2. Admins.\n').map((q) => q.n)).toEqual([2]);
    expect(open('A2. only the Owner\n')).toEqual([]);
  });

  it('reads plan.md’s questions with spec.md’s, against the same answers.md', () => {
    const plan = clarifications('- Q3: Which database?\n  - Options: A) SQLite B) Postgres');
    const open = openQuestions({ spec, plan }, parseAnswers('A1. B\nA2. one week\n'));
    expect(open.map((q) => [q.file, q.n])).toEqual([['plan.md', 3]]);
  });

  it('a question the follow-up rule refuses is not the Owner’s to answer', () => {
    const late = clarifications(
      '- Q1: Which sign-in? → A: B',
      '- Q2 (follow-up): How long?',
      '- Q3: And who?',
    );
    expect(openQuestions({ spec: late }, parseAnswers('A1. B\n')).map((q) => q.n)).toEqual([2]);
  });
});

describe('the answers a session applies (T180, slice 24c-2b)', () => {
  const spec = clarifications(
    '- Q1: Which sign-in? → A: B',
    '- Q2: How long?',
    '- Q3: Who may invite? → A: admins → Owner action: tier raise',
    '- Q4: Which page?',
  );
  const plan = clarifications('- Q5: Which database?');
  const answers = parseAnswers(
    'A1. B\nA2. one week\nA3. only the Owner\nA4. Both, if the link expires soon\nA5. SQLite\n',
  );

  it('gives each file’s answers that count to questions not yet applied, never another file’s', () => {
    expect(answersToApply({ spec, plan }, answers, 'spec.md')).toEqual([
      'A2. one week',
      'A3. only the Owner',
    ]);
    expect(answersToApply({ spec, plan }, answers, 'plan.md')).toEqual(['A5. SQLite']);
  });

  it('AC-033 (T182): an applied answer is settled only by the Owner’s matching line; with none it is open', () => {
    const forged = clarifications('- Q1: Which sign-in? → A: B');
    expect(openQuestions({ spec: forged }, new Map()).map((q) => [q.n, q.why])).toEqual([
      [1, 'unanswered'],
    ]);
    expect(openQuestions({ spec: forged }, parseAnswers('A1. B\n'))).toEqual([]);
  });

  it('AC-033 (T182): an applied answer that differs from the Owner’s goes back to the command', () => {
    const stale = clarifications('- Q1: Which sign-in? → A: A');
    expect(answersToApply({ spec: stale }, parseAnswers('A1. B\n'), 'spec.md')).toEqual(['A1. B']);
    const tooLong = parseAnswers('A1. Both, as long as the link expires soon\n');
    expect(openQuestions({ spec: stale }, tooLong).map((q) => q.why)).toEqual(['answer']);
  });

  it('T182: a line with two → A: is refused, never settled, and given the Owner’s answer to rewrite', () => {
    const doubled = clarifications('- Q1: Which sign-in? → A: A → A: B');
    const [q] = questionsIn(doubled, 'spec.md');
    expect(questionProblems(q ? [q] : [], 'spec.md').missing).toEqual([
      'spec.md: Q1 has more than one → A:; the newest answer replaces everything after the question',
    ]);
    expect(answersToApply({ spec: doubled }, parseAnswers('A1. B\n'), 'spec.md')).toEqual([
      'A1. B',
    ]);
    expect(openQuestions({ spec: doubled }, new Map()).map((q) => q.why)).toEqual(['unanswered']);
  });
});

describe('one follow-up round per file (Owner decision 2026-10-21)', () => {
  const problems = (...lines: string[]) =>
    questionProblems(questionsIn(clarifications(...lines), 'spec.md'), 'spec.md');

  it('accepts a first round and one follow-up round', () => {
    expect(
      problems('- Q1: Which? → A: B', '- Q2 (follow-up): Then which?', '- Q3 (follow-up): And?'),
    ).toEqual({ refused: [], missing: [] });
  });

  it('refuses a question not marked as a follow-up after a follow-up', () => {
    expect(
      problems('- Q1: Which? → A: B', '- Q2 (follow-up): Then?', '- Q3: And?').missing,
    ).toEqual([
      'spec.md: Q3 is asked after the follow-up round; take its recommended default under ## Assumptions',
    ]);
  });

  it('refuses a follow-up asked once another follow-up is applied: a third round', () => {
    expect(
      problems('- Q1: Which? → A: B', '- Q2 (follow-up): Then? → A: C', '- Q3 (follow-up): And?')
        .refused,
    ).toEqual([3]);
  });
});

describe('the blocked alert (T180, AC-033)', () => {
  it('quotes each open question through visible(), names answers.md, and gives the way out of an Owner action', () => {
    const spec = clarifications(
      '- Q1: Which sign-in‮ should visitors use?',
      '- Q2: Who may invite others? → A: admins → Owner action: tier raise',
    );
    const plan = clarifications('- Q3: Which database?');
    const open = openQuestions(
      { spec, plan },
      parseAnswers('A3. Postgres because it scales better later\n'),
    );
    const text = questionAlert(open, 'specs/2-add-login/answers.md', 'claude/2-add-login');
    expect(text).toContain('specs/2-add-login/answers.md on claude/2-add-login');
    expect(text).toContain('one `A<n>. <answer>` line per question');
    expect(text).toContain('- Q1 (spec.md): Which sign-in\\u{202e} should visitors use?');
    expect(text).toContain(
      '- Q2 (spec.md): Who may invite others? It needs an Owner action, tier raise: answer differently, or do the action, then close this item and file it again',
    );
    expect(text).toContain(
      '- Q3 (plan.md): Which database? A3 does not count: it is neither one of the options nor five words or fewer',
    );
  });
});
