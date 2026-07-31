import { computed, effect, Service, signal } from '@angular/core';
import { swallow } from '../../utils/error-logging';

export type Theme = 'light' | 'dark';

@Service()
export class ThemeService {
  // ── signals ─────────────────────────────────────────────────────
  readonly theme = signal<Theme>(this.loadInitialTheme());

  // ── computed ────────────────────────────────────────────────────
  readonly isDark = computed(() => this.theme() === 'dark');
  readonly icon = computed(() => this.isDark() ? 'light_mode' : 'dark_mode');
  readonly tooltip = computed(() => this.isDark() ? 'Switch to light mode' : 'Switch to dark mode');

  // ── properties ──────────────────────────────────────────────────
  private static readonly STORAGE_KEY = 'quiz-app-theme';

  // ── constructor / lifecycle ─────────────────────────────────────
  constructor() {
    effect(() => {
      const t = this.theme();
      document.documentElement.setAttribute('data-theme', t);
      try {
        localStorage.setItem(ThemeService.STORAGE_KEY, t);
      } catch (err: unknown) { swallow('theme.service.ts', err); }
    });
  }

  // ── public methods ──────────────────────────────────────────────
  toggle(): void {
    this.theme.update(t => t === 'light' ? 'dark' : 'light');
  }

  // ── private methods ─────────────────────────────────────────────
  private loadInitialTheme(): Theme {
    try {
      const stored = localStorage.getItem(ThemeService.STORAGE_KEY);
      if (stored === 'dark' || stored === 'light') return stored;
    } catch (err: unknown) { swallow('theme.service.ts', err); }
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
    return 'light';
  }
}