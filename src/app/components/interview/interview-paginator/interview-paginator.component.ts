import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  ViewEncapsulation
} from '@angular/core';

type PaginatorItem =
  | { kind: 'page'; index: number }
  | { kind: 'ellipsis'; key: string };

/**
 * Compact numeric pagination for Interview Mode — a windowed alternative to the
 * topic-quiz question dots (which would be excessive at 20–30 questions). Reuses
 * the shared navigation index (driven by the parent); it is purely
 * presentational. Desktop shows `Prev 1 … 6 7 8 9 10 … 20 Next`; a narrow
 * viewport collapses to `Prev  Question X of Y  Next` (CSS-toggled).
 *
 * Answered/unanswered is conveyed by an underline marker AND the accessible
 * label — never by color alone — and NEVER reveals correctness.
 */
@Component({
  selector: 'app-interview-paginator',
  standalone: true,
  imports: [],
  templateUrl: './interview-paginator.component.html',
  styleUrls: ['./interview-paginator.component.scss'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InterviewPaginatorComponent {
  readonly total = input.required<number>();
  readonly currentIndex = input.required<number>();          // 0-based
  readonly answered = input<ReadonlySet<number>>(new Set());  // 0-based indices

  // Emits the 0-based target index to navigate to.
  readonly select = output<number>();

  // First, last, and a ±2 window around the current question, with ellipses for
  // any omitted gaps. Example (Q8 of 20): 1 … 6 7 8 9 10 … 20.
  readonly items = computed<PaginatorItem[]>(() => {
    const total = this.total();
    const current = this.currentIndex();
    if (total <= 0) return [];

    const show = new Set<number>([0, total - 1]);
    for (let d = -2; d <= 2; d++) {
      const i = current + d;
      if (i >= 0 && i < total) show.add(i);
    }

    const sorted = [...show].sort((a, b) => a - b);
    const items: PaginatorItem[] = [];
    let prev = -1;
    for (const idx of sorted) {
      if (prev >= 0 && idx - prev > 1) {
        items.push({ kind: 'ellipsis', key: `e${prev}` });
      }
      items.push({ kind: 'page', index: idx });
      prev = idx;
    }
    return items;
  });

  readonly atStart = computed(() => this.currentIndex() <= 0);
  readonly atEnd = computed(() => this.currentIndex() >= this.total() - 1);

  isCurrent(index: number): boolean {
    return index === this.currentIndex();
  }

  isAnswered(index: number): boolean {
    return this.answered().has(index);
  }

  pageLabel(index: number): string {
    const answered = this.isAnswered(index) ? ', answered' : ', not answered';
    return `Go to question ${index + 1}${answered}`;
  }

  goPrevious(): void {
    if (!this.atStart()) this.select.emit(this.currentIndex() - 1);
  }

  goNext(): void {
    if (!this.atEnd()) this.select.emit(this.currentIndex() + 1);
  }
}
