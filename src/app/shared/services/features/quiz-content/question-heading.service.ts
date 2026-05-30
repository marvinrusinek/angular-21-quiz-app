import { Injectable, signal } from '@angular/core';

/**
 * Single owner of the question heading's HTML content.
 * Services that need to update the H3 heading must call setHtml() —
 * never reach into the DOM via document.querySelector or
 * renderer.setProperty. The CodelabQuizContentComponent subscribes
 * to htmlSig via an effect and is the only writer of the actual DOM.
 */
@Injectable({ providedIn: 'root' })
export class QuestionHeadingService {
  readonly htmlSig = signal<string>('');

  setHtml(html: string): void {
    const safe = html ?? '';
    if (this.htmlSig() === safe) return;
    this.htmlSig.set(safe);
  }

  get(): string {
    return this.htmlSig();
  }
}
