import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  OnInit,
  signal,
  Signal,
  ViewEncapsulation
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { toSignal, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import {
  AssessmentConfig,
  AssessmentQuestionCount,
  DURATION_SECONDS_BY_COUNT,
  InterviewDifficulty
} from '../../../shared/models/AssessmentConfig.model';

import { QuizDataService } from '../../../shared/services/data/quizdata.service';
import { AssessmentBuilderService } from '../../../shared/services/features/assessment/assessment-builder.service';
import { InterviewSessionService } from '../../../shared/services/features/interview/interview-session.service';
import { QuizStartSpinnerService } from '../../../shared/services/ui/quiz-start-spinner.service';
import { swallow } from '../../../shared/utils/error-logging';
import { isEligibleInterviewTopic } from '../../../shared/utils/interview-topics';
import {
  INTERVIEW_TOPIC_CATEGORIES,
  INTERVIEW_TOPIC_OTHER_CATEGORY
} from './interview-topic-categories';
import { InterviewCertificateCalloutComponent } from '../../../components/interview/interview-certificate-callout/interview-certificate-callout.component';

interface TopicOption {
  id: string;
  name: string;
  count: number;
}

interface TopicCategoryGroup {
  title: string;
  topics: TopicOption[];
}

interface DifficultyOption {
  value: InterviewDifficulty;
  label: string;
}

/**
 * "Build Your Interview" configuration page. Guides the user through
 * Difficulty → Topics → Question count → Preview → Start. Topics are conditional
 * on difficulty; validity is DERIVED from the configuration and the eligible
 * pool (no persisted canStartInterview flag). On Start it builds the assessment,
 * begins the session, shows the shared spinner, and navigates to the session.
 */
@Component({
  selector: 'codelab-build-your-interview',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, InterviewCertificateCalloutComponent],
  templateUrl: './build-your-interview.component.html',
  styleUrls: ['./build-your-interview.component.scss'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class BuildYourInterviewComponent implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly quizDataService = inject(QuizDataService);
  private readonly builder = inject(AssessmentBuilderService);
  private readonly session = inject(InterviewSessionService);
  private readonly spinner = inject(QuizStartSpinnerService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  private readonly quizzes = this.quizDataService.quizzesSig;

  readonly difficultyOptions: readonly DifficultyOption[] = [
    { value: 'beginner', label: 'Beginner' },
    { value: 'intermediate', label: 'Intermediate' },
    { value: 'advanced', label: 'Advanced' },
    { value: 'mixed', label: 'Mixed' }
  ];

  readonly countOptions: readonly AssessmentQuestionCount[] = [10, 20, 30];

  // Difficulty lives in a Reactive Form control (the project's form approach);
  // topics + count are signals so the dynamic multi-select and per-option
  // disabling stay simple and testable.
  readonly form = this.fb.group({
    difficulty: this.fb.control<InterviewDifficulty | null>(null)
  });

  readonly difficulty = toSignal(this.form.controls.difficulty.valueChanges, {
    initialValue: this.form.controls.difficulty.value
  }) as Signal<InterviewDifficulty | null>;

  readonly selectedTopicIds = signal<ReadonlySet<string>>(new Set());
  readonly questionCount = signal<AssessmentQuestionCount>(20);

  // Topics eligible for the chosen difficulty (Mixed = all). Empty until a
  // difficulty is chosen, which hides the topics fieldset.
  readonly availableTopics = computed<TopicOption[]>(() => {
    const difficulty = this.difficulty();
    if (!difficulty) return [];
    return this.quizzes()
      // Shared definition of an eligible Interview Mode topic (has questions) —
      // the same one the Readiness coverage denominator uses.
      .filter(isEligibleInterviewTopic)
      .filter((quiz) => difficulty === 'mixed' || quiz.difficulty === difficulty)
      .map((quiz) => ({
        id: quiz.quizId,
        name: quiz.milestone,
        count: quiz.questions?.length ?? 0
      }));
  });

  // PRESENTATION ONLY: groups availableTopics() into categories for display.
  // Derived from availableTopics (already difficulty-filtered), so categories
  // with no visible topic are omitted automatically and no topic is ever
  // dropped — anything not mapped to a category lands in "Other". Selection,
  // filtering, and validation continue to read availableTopics/selectedTopicIds.
  readonly groupedTopics = computed<TopicCategoryGroup[]>(() => {
    const available = this.availableTopics();
    const byId = new Map(available.map((topic) => [topic.id, topic]));
    const used = new Set<string>();
    const groups: TopicCategoryGroup[] = [];

    for (const category of INTERVIEW_TOPIC_CATEGORIES) {
      const topics: TopicOption[] = [];
      for (const id of category.quizIds) {
        const topic = byId.get(id);
        if (topic) {
          topics.push(topic);
          used.add(id);
        }
      }
      if (topics.length > 0) {
        groups.push({ title: category.title, topics });
      }
    }

    // Never hide a topic: anything not categorised above goes to "Other".
    const others = available.filter((topic) => !used.has(topic.id));
    if (others.length > 0) {
      groups.push({ title: INTERVIEW_TOPIC_OTHER_CATEGORY, topics: others });
    }

    return groups;
  });

  readonly topicsEnabled = computed(() => this.difficulty() !== null);

  readonly eligiblePool = computed(() =>
    this.builder.countEligible([...this.selectedTopicIds()])
  );

  readonly selectedTopicNames = computed(() =>
    this.availableTopics()
      .filter((topic) => this.selectedTopicIds().has(topic.id))
      .map((topic) => topic.name)
  );

  readonly durationMinutes = computed(
    () => DURATION_SECONDS_BY_COUNT[this.questionCount()] / 60
  );

  // Start is enabled only when a difficulty + at least one topic + a valid
  // count are chosen and the eligible pool can supply the requested count.
  readonly startDisabled = computed(() => {
    if (!this.difficulty()) return true;
    if (this.selectedTopicIds().size === 0) return true;
    return this.eligiblePool().total < this.questionCount();
  });

  // Pool-size messaging is shown ONLY to explain an invalid configuration.
  readonly invalidReason = computed(() => {
    if (!this.difficulty() || this.selectedTopicIds().size === 0) return '';
    const total = this.eligiblePool().total;
    if (total < this.questionCount()) {
      return `Only ${total} question${total === 1 ? '' : 's'} ${total === 1 ? 'is' : 'are'} available for this selection. ` +
        'Select another topic or choose a shorter interview.';
    }
    return '';
  });

  constructor() {
    // Changing difficulty must drop topic selections that are no longer valid —
    // never retain stale topic ids.
    this.form.controls.difficulty.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe((difficulty) => {
        const valid = new Set(
          difficulty ? this.builder.eligibleTopicIds(difficulty) : []
        );
        this.selectedTopicIds.update(
          (current) => new Set([...current].filter((id) => valid.has(id)))
        );
      });
  }

  ngOnInit(): void {
    // Ensure the quiz catalog is loaded so topics appear even on a direct load /
    // refresh of /interview (quizzesSig is otherwise only filled after visiting
    // the selection page). Returns cached quizzes immediately when available.
    this.quizDataService
      .ensureQuizzesLoaded()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  isTopicSelected(id: string): boolean {
    return this.selectedTopicIds().has(id);
  }

  toggleTopic(id: string, checked: boolean): void {
    this.selectedTopicIds.update((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }

  selectAllTopics(): void {
    this.selectedTopicIds.set(new Set(this.availableTopics().map((t) => t.id)));
  }

  clearTopics(): void {
    this.selectedTopicIds.set(new Set());
  }

  // A count option is disabled when the eligible pool can't supply it.
  isCountDisabled(count: AssessmentQuestionCount): boolean {
    return this.eligiblePool().total < count;
  }

  setCount(count: AssessmentQuestionCount): void {
    if (this.isCountDisabled(count)) return;
    this.questionCount.set(count);
  }

  private currentConfig(): AssessmentConfig {
    return {
      difficulty: this.difficulty()!,
      topicIds: [...this.selectedTopicIds()],
      questionCount: this.questionCount()
    };
  }

  async startInterview(): Promise<void> {
    if (this.startDisabled()) return;
    this.stashTimerOverride();
    this.session.start(this.currentConfig());
    await this.spinner.showForStart($localize`Preparing Interview…`);
    await this.router.navigate(['/interview/session']);
  }

  // Test-only hook: carry a `?interviewSeconds=` override into the session (via
  // sessionStorage) so Playwright can exercise timer expiry quickly. No effect
  // in normal use (the param is never present).
  private stashTimerOverride(): void {
    try {
      const raw = new URLSearchParams(window.location.search).get('interviewSeconds');
      if (raw && Number(raw) > 0) {
        sessionStorage.setItem('__interviewSeconds', raw);
      } else {
        sessionStorage.removeItem('__interviewSeconds');
      }
    } catch (err) {
      swallow('build-your-interview#stashTimerOverride', err);
    }
  }
}
