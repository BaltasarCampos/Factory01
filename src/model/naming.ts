// Names derived from work items and releases (data-model.md § Work item, § Project config).
import type { ReleasePin } from './types.js';

export const SLUG_MAX = 40;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RELEASE_PIN = /^(v\d+\.\d+\.\d+)@([0-9a-f]{40})$/;

/** Kebab-case slug of an issue title, at most 40 characters. */
export function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
  return slug === '' ? 'item' : slug;
}

export function isSlug(slug: string): boolean {
  return slug.length <= SLUG_MAX && SLUG.test(slug);
}

function checkItem(issue: number, slug: string): void {
  if (!Number.isInteger(issue) || issue < 1)
    throw new Error(`invalid issue number: ${String(issue)}`);
  if (!isSlug(slug)) throw new Error(`invalid slug: ${slug}`);
}

/** `claude/<issue>-<slug>` */
export function itemBranch(issue: number, slug: string): string {
  checkItem(issue, slug);
  return `claude/${String(issue)}-${slug}`;
}

/** `specs/<issue>-<slug>/` */
export function featureDir(issue: number, slug: string): string {
  checkItem(issue, slug);
  return `specs/${String(issue)}-${slug}/`;
}

/** Parse `<tag>@<sha>`; undefined when malformed (a bare tag is malformed). */
export function parseReleasePin(text: string): ReleasePin | undefined {
  const m = RELEASE_PIN.exec(text);
  return m?.[1] !== undefined && m[2] !== undefined ? { tag: m[1], sha: m[2] } : undefined;
}

export function formatReleasePin(pin: ReleasePin): string {
  return `${pin.tag}@${pin.sha}`;
}
