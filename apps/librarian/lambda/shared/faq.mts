import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FAQ_PATH = path.join(ROOT, 'faq.json');
const TOKEN_RE = /[a-z0-9][a-z0-9'-]{1,}/gi;

type Replacements = Record<string, unknown>;

interface FaqSourceEntry {
  question: string;
  answer: string;
}

interface FaqSection {
  title: string;
  entries?: FaqSourceEntry[];
}

interface FaqData {
  sections?: FaqSection[];
}

interface FaqEntry {
  section: string;
  question: string;
  answer: string;
  answer_text: string;
  url: string;
}

interface SearchFaqOptions {
  limit?: number;
  replacements?: Replacements;
}

let faqCache: FaqData | undefined;

export function loadFaq() {
  if (!faqCache) {
    faqCache = JSON.parse(fs.readFileSync(FAQ_PATH, 'utf8')) as FaqData;
  }
  return faqCache;
}

export function renderFaqAnswer(answer: unknown, replacements: Replacements = {}) {
  return String(answer || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => String(replacements[key] ?? ''));
}

export function markdownToPlainText(markdown: unknown) {
  return String(markdown || '')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/^[ \t]*[-*]\s+/gm, '')
    .replace(/[>#*_~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Words every FAQ question and answer share: "the and of" scored five
// entries (QA2 F14). A query of only these matches nothing, and says so.
const FAQ_STOPWORDS = new Set([
  'about',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'can',
  'do',
  'does',
  'for',
  'from',
  'how',
  'if',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'so',
  'that',
  'the',
  'this',
  'to',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'with'
]);

// "Jamie's" is Jamie: the possessive is stripped, or entries that say only
// "Jamie's" never scored for "Jamie" (QA2 L2-8).
function tokenize(value: unknown) {
  return Array.from(String(value || '').matchAll(TOKEN_RE), (match) =>
    match[0].toLowerCase().replace(/'s?$/, '')
  ).filter((term) => term.length > 1);
}

/** The words of a query the FAQ is searched by: no common words. */
export function faqQueryTerms(query: unknown) {
  return [...new Set(tokenize(query).filter((term) => !FAQ_STOPWORDS.has(term)))];
}

export function faqEntries(replacements: Replacements = {}): FaqEntry[] {
  const entries: FaqEntry[] = [];
  for (const section of loadFaq().sections || []) {
    for (const entry of section.entries || []) {
      const answer = renderFaqAnswer(entry.answer, replacements);
      entries.push({
        section: section.title,
        question: entry.question,
        answer,
        answer_text: markdownToPlainText(answer),
        url: '/faq/'
      });
    }
  }
  return entries;
}

/** Every FAQ entry the query scores on, best first. */
export function searchFaqAll(query: unknown, replacements: Replacements = {}) {
  const queryTerms = faqQueryTerms(query);
  if (!queryTerms.length) return [];
  const scored = [];
  for (const entry of faqEntries(replacements)) {
    const questionTerms = tokenize(entry.question);
    const answerTerms = tokenize(entry.answer_text);
    const sectionTerms = tokenize(entry.section);
    let score = 0;
    for (const term of queryTerms) {
      score += questionTerms.filter((item) => item === term).length * 8;
      score += sectionTerms.filter((item) => item === term).length * 3;
      score += answerTerms.filter((item) => item === term).length;
    }
    if (score > 0) scored.push({ score, entry });
  }
  return scored
    .sort((left, right) => right.score - left.score || left.entry.question.localeCompare(right.entry.question))
    .map(({ entry }) => entry);
}

export function searchFaq(query: unknown, { limit = 5, replacements = {} }: SearchFaqOptions = {}) {
  return searchFaqAll(query, replacements).slice(0, Math.max(1, Math.min(Number(limit) || 5, 10)));
}
