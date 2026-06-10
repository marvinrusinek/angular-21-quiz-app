import { getQuizData } from '../quiz-data-cache';
import { isOptionCorrect } from './is-option-correct';
import { norm } from './text-norm';

function isFetLike(text: string, explanation?: string): boolean {
  const n = norm(text);
  if (!n) return false;
  if (n.includes('are correct because')) return true;
  if (n.includes('is correct because')) return true;
  if (n.includes('correct because')) return true;
  return !!explanation && explanation.length > 10 && n.includes(explanation);
}

function scrapeSelectedOptionTexts(): Set<string> {
  const out = new Set<string>();
  const selectors = [
    'codelab-option-item',
    '.option-row',
    '.option-item',
    'li[role="option"]',
    '.mat-mdc-list-option'
  ];
  for (const sel of selectors) {
    const rows = document.querySelectorAll(sel);
    for (const row of Array.from(rows) as any[]) {
      const cls = String(row?.className ?? '');
      const looksSelected = cls.includes('selected')
        || cls.includes('highlight')
        || cls.includes('active')
        || row?.querySelector?.('.selected, .highlight, .active, mat-icon.correct-icon, .correct-icon') != null;
      if (!looksSelected) continue;
      const txt = norm(row?.textContent ?? '');
      if (txt) out.add(txt);
    }
  }
  return out;
}

function findQuestionTextFromPristine():
  { qText: string; correctTexts: string[]; explanation: string } | null {
  const bodyText = norm(document.body?.textContent ?? '');
  if (!bodyText) return null;
  for (const quiz of (getQuizData() as any[]) ?? []) {
    for (const pq of quiz?.questions ?? []) {
      const qt = norm(pq?.questionText ?? '');
      if (!qt) continue;
      if (!bodyText.includes(qt)) continue;
      const correctTexts = ((pq?.options ?? []) as any[])
        .filter((o: any) => isOptionCorrect(o))
        .map((o: any) => norm(o?.text))
        .filter((t: string) => !!t);
      return {
        qText: pq?.questionText ?? '',
        correctTexts,
        explanation: norm(pq?.explanation ?? '')
      };
    }
  }
  return null;
}

// Revert any element displaying a FET for a multi-answer question whose
// pristine-correct options aren't all currently selected on screen.
function enforceFetWatchdog(): void {
  try {
    // Timer-expiry bypass: Angular sets this flag when timer expires
    if ((window as any).__quizTimerExpired === true) return;

    const bodyHtml = document.body?.innerHTML ?? '';
    const fetMatches =
      bodyHtml.match(/[A-Z][^<>]{0,200}(are correct because|is correct because)[^<>]{0,300}/gi);
    if (fetMatches && fetMatches.length > 0) {        }
    const current = findQuestionTextFromPristine();
    if (!current) {
      if (fetMatches && fetMatches.length > 0) { }
      return;
    }
    if (current.correctTexts.length < 2) return;  // not multi-answer
    const selectedTexts = scrapeSelectedOptionTexts();
    const allSel = current.correctTexts.every(t => {
      for (const sel of selectedTexts) if (sel.includes(t)) return true;
      return false;
    });
    if (allSel) return;
    const all = document.querySelectorAll('*');
    let revertCount = 0;
    let candidateCount = 0;
    for (const h of Array.from(all) as any[]) {
      try {
        const tc = h?.textContent ?? '';
        const html = h?.innerHTML ?? '';
        if (!isFetLike(tc, current.explanation) && !isFetLike(html, current.explanation)) continue;
        candidateCount++;
        const childCount = h?.children?.length ?? 0;
        if (childCount > 3) continue;
        h.innerHTML = current.qText;
        revertCount++;
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

// ══════════════════════════════════════════════════════════════════════
// GLOBAL FET WATCHDOG. Installed before Angular bootstrap. Watches the
// entire document for any element that displays FET-like text. When it
// finds such text, it consults the bundled QUIZ_DATA (immune to any
// runtime mutation) and the current live selection state (scraped from
// the DOM itself — CSS classes on option rows). If any pristine-correct
// option isn't currently selected on screen, the offending element's
// innerHTML is reverted to the plain question text.
// ══════════════════════════════════════════════════════════════════════
export function installGlobalFetWatchdog(): void {
  try {
    const mo = new MutationObserver(() => enforceFetWatchdog());
    const start = () => {
      try {
        mo.observe(document.body, { childList: true, characterData: true, subtree: true });
      } catch { /* ignore */ }
    };
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
    document.addEventListener('click', () => setTimeout(enforceFetWatchdog, 50), true);
  } catch { }
}
