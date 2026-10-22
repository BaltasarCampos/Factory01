// The question loop's factory side (T180, AC-033; Owner decisions 2026-10-19 to 2026-10-21).
// Spec and Plan ask the Owner under `## Clarifications` at the top of `spec.md` and `plan.md`,
// numbered on across both files:
//
//   - Q<n>: <question>                 open
//   - Q<n> (follow-up): <question>     the one follow-up round of that file
//   - Q<n>: <question> → A: <answer>   applied by the station's command
//   - Q<n>: … → A: <answer> → Owner action: <brief change | tier raise>   stays open
//
// The Owner answers in the feature's `answers.md` with `A<n>. <answer>` lines. Which questions are
// open is read by factory code from the files at the branch head, never from a session's word: an
// answer counts only when it is one of the question's options or five words or fewer, clarify's
// own rule. A question needing an Owner action stays open until the Owner answers it differently,
// so the item stays blocked and nothing relaunches (no done path before Gate A).
//
// An applied answer is settled only when the Owner's `A<n>.` line matches it (T182): with no line
// the question is open, and with a different line that counts the station's command applies it,
// so the factory heals a mismatch instead of a session having to. A line with two `→ A:` is
// refused, never settled, and the Owner's answer goes back to the command to rewrite it.
import { visible } from '../../notify/summary.js';
import { section } from './spec.js';

export type QuestionFile = 'spec.md' | 'plan.md';

export interface Question {
  file: QuestionFile;
  n: number;
  followUp: boolean;
  /** The question as written, without its marker or answer. */
  text: string;
  /** Option texts by letter, from its `- Options:` line. */
  options: Record<string, string>;
  /** The answer the command applied (`→ A: …`). */
  applied?: string;
  /** The Owner action the applied answer needs (`→ Owner action: …`). */
  ownerAction?: string;
  /** The line has more than one `→ A:`. */
  doubled?: true;
}

export interface OpenQuestion extends Question {
  /** No answer yet, an answer that does not count, or an Owner action to take. */
  why: 'unanswered' | 'answer' | 'action';
}

const QUESTION = /^\s*- Q(\d+)( \(follow-up\))?:\s*(.*)$/;

/** The questions under `## Clarifications` in `text`, in order. */
export function questionsIn(text: string, file: QuestionFile): Question[] {
  const lines = section(text.split('\n'), 'Clarifications') ?? [];
  const found: Question[] = [];
  for (const line of lines) {
    const m = QUESTION.exec(line);
    if (m !== null) {
      const rest = m[3] ?? '';
      const [question = ''] = rest.split(/\s*→ (?:A|Owner action):/);
      const applied = /→ A:\s*(.*?)\s*(?:→ Owner action:|$)/.exec(rest)?.[1];
      const ownerAction = /→ Owner action:\s*(.*?)\s*$/.exec(rest)?.[1];
      found.push({
        ...{ file, n: Number(m[1]), followUp: m[2] !== undefined, text: question.trim() },
        options: {},
        ...(applied === undefined ? {} : { applied }),
        ...(ownerAction === undefined ? {} : { ownerAction }),
        ...(rest.split('→ A:').length > 2 ? { doubled: true as const } : {}),
      });
      continue;
    }
    const options = /^\s+- Options:\s*(.*)$/.exec(line)?.[1];
    const last = found.at(-1);
    if (options === undefined || last === undefined) continue;
    for (const [, letter = '', option = ''] of options.matchAll(
      /\b([A-Z])\)\s*(.*?)\s*(?=\b[A-Z]\)|$)/g,
    ))
      last.options[letter] = option;
  }
  return found;
}

/** The Owner's answers by question number; a later `A<n>.` line replaces an earlier one. */
export function parseAnswers(text: string | undefined): Map<number, string> {
  const answers = new Map<number, string>();
  for (const line of (text ?? '').split('\n')) {
    const m = /^A(\d+)[.:]\s+(.*\S)\s*$/.exec(line);
    if (m !== null) answers.set(Number(m[1]), m[2] ?? '');
  }
  return answers;
}

const same = (a: string, b: string) => {
  const norm = (s: string) =>
    s
      .replace(/\s+/g, ' ')
      .replace(/[.\s]+$/, '')
      .trim()
      .toLowerCase();
  return norm(a) === norm(b);
};

/** The answer as an option's letter when it names one, by letter or text; otherwise as written. */
function canonical(q: Question, answer: string): string {
  for (const [letter, option] of Object.entries(q.options))
    if ([letter, `${letter})`, option, `${letter}) ${option}`].some((form) => same(answer, form)))
      return letter;
  return answer;
}

/** Whether two answers are the same, a letter and its option's text counting as equal. */
export const sameAnswer = (q: Question, a: string, b: string) =>
  same(canonical(q, a), canonical(q, b));

/** Clarify's rule: an answer counts when it is one of the question's options or ≤ five words. */
export function answerCounts(q: Question, answer: string): boolean {
  const words = answer
    .trim()
    .split(/\s+/)
    .filter((w) => w !== '');
  if (words.length === 0) return false;
  if (words.length <= 5) return true;
  return Object.entries(q.options).some(
    ([letter, option]) => same(answer, option) || same(answer, `${letter}) ${option}`),
  );
}

/**
 * The one follow-up round per file: a question not marked as a follow-up after a follow-up, or a
 * follow-up still unanswered once another follow-up is applied (a third round), is refused.
 */
export function questionProblems(
  questions: readonly Question[],
  file: QuestionFile,
): { refused: number[]; missing: string[] } {
  const first = questions.findIndex((q) => q.followUp);
  const followUps = questions.filter((q) => q.followUp);
  const refused = questions
    .filter(
      (q, i) =>
        (first !== -1 && i > first && !q.followUp) ||
        (q.followUp && q.applied === undefined && followUps.some((f) => f.applied !== undefined)),
    )
    .map((q) => q.n);
  const missing = [
    ...refused.map(
      (n) =>
        `${file}: Q${String(n)} is asked after the follow-up round; take its recommended default under ## Assumptions`,
    ),
    // Not refused: the Owner's answer still goes to the command, which rewrites the line.
    ...questions
      .filter((q) => q.doubled === true)
      .map(
        (q) =>
          `${file}: Q${String(q.n)} has more than one → A:; the newest answer replaces everything after the question`,
      ),
  ];
  return { refused, missing };
}

/**
 * Whether the command applied the Owner's own answer and nothing is left to the Owner: the
 * applied answer matches the Owner's `A<n>.` line (T182).
 */
export function settled(q: Question, answers: ReadonlyMap<number, string>): boolean {
  const owner = answers.get(q.n);
  if (q.applied === undefined || q.ownerAction !== undefined || q.doubled === true) return false;
  return owner !== undefined && sameAnswer(q, q.applied, owner);
}

type Files = { spec?: string | undefined; plan?: string | undefined };

/** The questions of both files the follow-up rule does not refuse, `spec.md`'s first. */
function asked(files: Files): Question[] {
  return (['spec.md', 'plan.md'] as const).flatMap((file) => {
    const text = file === 'spec.md' ? files.spec : files.plan;
    const questions = text === undefined ? [] : questionsIn(text, file);
    const { refused } = questionProblems(questions, file);
    return questions.filter((q) => !refused.includes(q.n));
  });
}

/** Settled, answered for a session to apply, or why it is still the Owner's. */
export function standing(
  q: Question,
  answers: ReadonlyMap<number, string>,
): 'settled' | 'apply' | OpenQuestion['why'] {
  if (settled(q, answers)) return 'settled';
  const answer = answers.get(q.n);
  if (q.ownerAction !== undefined && q.doubled !== true) {
    const changed = answer !== undefined && !sameAnswer(q, answer, q.applied ?? '');
    return changed && answerCounts(q, answer) ? 'apply' : 'action';
  }
  if (answer === undefined) return 'unanswered';
  return answerCounts(q, answer) ? 'apply' : 'answer';
}

/** The questions still the Owner's to answer, in `spec.md`'s order and then `plan.md`'s. */
export function openQuestions(files: Files, answers: ReadonlyMap<number, string>): OpenQuestion[] {
  return asked(files).flatMap((q): OpenQuestion[] => {
    const why = standing(q, answers);
    return why === 'settled' || why === 'apply' ? [] : [{ ...q, why }];
  });
}

/** The Owner's answers that `file`'s station applies next, as `A<n>. <answer>` lines. */
export function answersToApply(
  files: Files,
  answers: ReadonlyMap<number, string>,
  file: QuestionFile,
): string[] {
  return asked(files)
    .filter((q) => q.file === file && standing(q, answers) === 'apply')
    .map((q) => `A${String(q.n)}. ${answers.get(q.n) ?? ''}`);
}

/** The blocked alert: each open question quoted through `visible()`, and where to answer. */
export function questionAlert(
  open: readonly OpenQuestion[],
  answersPath: string,
  branch: string,
): string {
  const lines = open.map((q) => {
    const n = String(q.n);
    const head = `- Q${n} (${q.file}): ${visible(q.text)}`;
    if (q.why === 'action')
      return `${head} It needs an Owner action, ${visible(q.ownerAction ?? '')}: answer differently, or do the action, then close this item and file it again`;
    if (q.why === 'answer')
      return `${head} A${n} does not count: it is neither one of the options nor five words or fewer`;
    return head;
  });
  return [
    `waits for the Owner's answers in ${answersPath} on ${branch}, one \`A<n>. <answer>\` line per question: an option, or five words or fewer.`,
    ...lines,
  ].join('\n');
}
