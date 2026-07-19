import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA } from '@angular/material/dialog';

import {
  KeyboardShortcutsDialogComponent,
  KeyboardShortcutsDialogData
} from './keyboard-shortcuts-dialog.component';

/**
 * The dialog is shared by the topic quiz and Interview Mode; only `data.mode`
 * differs. These tests pin the contract that matters: each mode documents ONLY
 * the shortcuts that actually work on that surface.
 *
 * Interview Mode registers no global key handler (the topic quiz's
 * runOnGlobalKey is wired in QuizComponent only), so arrow keys do NOT change
 * question there — documenting them as "Previous/Next Question" would be wrong.
 * The `not.toContain` assertions guard against that regressing.
 */
describe('KeyboardShortcutsDialogComponent', () => {
  let fixture: ComponentFixture<KeyboardShortcutsDialogComponent>;

  async function setup(data: KeyboardShortcutsDialogData | null) {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [KeyboardShortcutsDialogComponent],
      providers: [{ provide: MAT_DIALOG_DATA, useValue: data }]
    }).compileComponents();

    fixture = TestBed.createComponent(KeyboardShortcutsDialogComponent);
    fixture.detectChanges();
  }

  const text = () => (fixture.nativeElement as HTMLElement).textContent!.replace(/\s+/g, ' ');
  const kbds = () =>
    Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('kbd')).map((k) =>
      k.textContent!.trim()
    );

  describe('topic quiz mode (default)', () => {
    it('defaults to quiz mode when no data is supplied', async () => {
      await setup(null);
      expect(fixture.componentInstance.mode).toBe('quiz');
      expect(fixture.componentInstance.isInterview).toBe(false);
    });

    it('documents the quiz shortcuts', async () => {
      await setup({ mode: 'quiz' });
      expect(text()).toContain('Select option 1');
      expect(text()).toContain('Previous Question');
      expect(text()).toContain('Next Question');
    });
  });

  describe('interview mode', () => {
    beforeEach(async () => {
      await setup({ mode: 'interview' });
    });

    it('uses the interview mode + title', () => {
      expect(fixture.componentInstance.isInterview).toBe(true);
      expect(text()).toContain('Assessment Keyboard Shortcuts');
    });

    it('documents only shortcuts that work in Interview Mode', () => {
      const t = text();
      expect(t).toContain('Tab');
      expect(t).toContain('Activate the focused button or control');
      expect(t).toContain('Exit Full Screen');
    });

    it('flags that leaving Full Screen records a focus change', () => {
      expect(text()).toContain('(Focus Change Recorded)');
    });

    it('does NOT document topic-quiz-only shortcuts', () => {
      const t = text();
      expect(t).not.toContain('Select option 1');
      expect(t).not.toContain('Check Answer');
      expect(t).not.toContain('Reveal Answer');
    });

    it('does NOT claim arrow keys change question (no interview key handler exists)', () => {
      const t = text();
      expect(t).not.toContain('Previous Question');
      expect(t).not.toContain('Next Question');
    });

    it('renders every shortcut with a semantic <kbd> element', () => {
      const keys = kbds();
      expect(keys).toContain('Tab');
      expect(keys).toContain('Shift');
      expect(keys).toContain('Enter');
      expect(keys).toContain('Esc');
      expect(keys.length).toBeGreaterThanOrEqual(6);
    });

    it('gives arrow keycaps screen-reader labels', () => {
      const labelled = Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll('kbd[aria-label]')
      ).map((k) => k.getAttribute('aria-label'));
      expect(labelled).toContain('Left arrow key');
      expect(labelled).toContain('Right arrow key');
      expect(labelled).toContain('Escape key');
    });

    it('exposes the ids the dialog config points aria-labelledby/describedby at', () => {
      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('#ksd-title')).toBeTruthy();
      expect(el.querySelector('#ksd-desc')).toBeTruthy();
    });
  });
});
