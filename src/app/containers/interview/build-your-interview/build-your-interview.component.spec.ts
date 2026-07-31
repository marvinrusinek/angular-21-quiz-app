import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { of } from 'rxjs';

import { Quiz, QuizDifficulty } from '../../../shared/models/Quiz.model';
import { setQuizDataCache } from '../../../shared/quiz-data-cache';

import { QuizDataService } from '../../../shared/services/data/quizdata.service';
import { InterviewSessionService } from '../../../shared/services/features/interview/interview-session.service';
import { QuizStartSpinnerService } from '../../../shared/services/ui/quiz-start-spinner.service';

import { BuildYourInterviewComponent } from './build-your-interview.component';

function makeQuiz(quizId: string, difficulty: QuizDifficulty, n: number): Quiz {
  const questions = Array.from({ length: n }, (_, i) => ({
    questionText: `${quizId}-q${i + 1}`,
    options: [
      { text: 'A', correct: true },
      { text: 'B' },
      { text: 'C' },
      { text: 'D' }
    ],
    explanation: 'e'
  }));
  return { quizId, milestone: quizId.toUpperCase(), summary: '', image: '', difficulty, questions };
}

const CATALOG: Quiz[] = [
  makeQuiz('ts', 'beginner', 10),
  makeQuiz('templates', 'beginner', 10),
  makeQuiz('router', 'intermediate', 8),
  makeQuiz('forms', 'intermediate', 3),
  makeQuiz('rxjs', 'advanced', 10)
];

describe('BuildYourInterviewComponent', () => {
  let fixture: ComponentFixture<BuildYourInterviewComponent>;
  let component: BuildYourInterviewComponent;
  let router: { navigate: jest.Mock };
  let spinner: { showForStart: jest.Mock };

  beforeEach(async () => {
    setQuizDataCache(CATALOG, []);
    router = { navigate: jest.fn().mockResolvedValue(true) };
    spinner = { showForStart: jest.fn().mockResolvedValue(undefined) };

    await TestBed.configureTestingModule({
      imports: [BuildYourInterviewComponent],
      providers: [
        { provide: QuizDataService, useValue: { quizzesSig: signal(CATALOG), ensureQuizzesLoaded: () => of(CATALOG) } },
        { provide: Router, useValue: router },
        { provide: QuizStartSpinnerService, useValue: spinner }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(BuildYourInterviewComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    setQuizDataCache([], []);
  });

  const setDifficulty = (d: string) => {
    component.setDifficulty(d as never);
    fixture.detectChanges();
  };

  // 1
  it('keeps topics unavailable before a difficulty is selected', () => {
    expect(component.topicsEnabled()).toBe(false);
    expect(component.availableTopics()).toEqual([]);
  });

  // 2
  it('shows only Beginner topics for Beginner', () => {
    setDifficulty('beginner');
    expect(component.availableTopics().map((t) => t.id).sort()).toEqual(['templates', 'ts']);
  });

  // 3
  it('shows only Intermediate topics for Intermediate', () => {
    setDifficulty('intermediate');
    expect(component.availableTopics().map((t) => t.id).sort()).toEqual(['forms', 'router']);
  });

  // 4
  it('shows only Advanced topics for Advanced', () => {
    setDifficulty('advanced');
    expect(component.availableTopics().map((t) => t.id)).toEqual(['rxjs']);
  });

  // 5
  it('shows all topics for Mixed', () => {
    setDifficulty('mixed');
    expect(component.availableTopics()).toHaveLength(5);
  });

  // ── grouped topics (presentation only) ───────────────────────────
  // groupedTopics is derived from availableTopics; it must never add, drop, or
  // reorder-away a topic, only bucket them into categories.

  it('groups topics into categories without dropping any topic', () => {
    setDifficulty('mixed');
    const flatIds = component.availableTopics().map((t) => t.id).sort();
    const groupedIds = component
      .groupedTopics()
      .flatMap((g) => g.topics.map((t) => t.id))
      .sort();
    expect(groupedIds).toEqual(flatIds);   // same set, nothing lost
  });

  it('places known ids under the right category, unknown ids under "Other"', () => {
    setDifficulty('mixed');
    const byTitle = new Map(component.groupedTopics().map((g) => [g.title, g.topics.map((t) => t.id)]));
    // templates/forms/router are Core Angular; rxjs is Reactive; 'ts' (not a real
    // quizId) falls through to Other.
    expect(byTitle.get('Core Angular')).toEqual(['templates', 'forms', 'router']);
    expect(byTitle.get('Reactive Angular')).toEqual(['rxjs']);
    expect(byTitle.get('Other')).toEqual(['ts']);
  });

  it('preserves category order and intra-category order', () => {
    setDifficulty('mixed');
    // Core Angular is defined before Reactive Angular; Other is always last.
    expect(component.groupedTopics().map((g) => g.title)).toEqual([
      'Core Angular',
      'Reactive Angular',
      'Other'
    ]);
  });

  it('omits categories that have no visible topic for the chosen difficulty', () => {
    setDifficulty('beginner');   // only ts + templates are eligible
    const titles = component.groupedTopics().map((g) => g.title);
    expect(titles).toContain('Core Angular');   // templates
    expect(titles).toContain('Other');          // ts
    expect(titles).not.toContain('Reactive Angular');
    expect(titles).not.toContain('Dependency Injection');
  });

  it('yields no groups before a difficulty is selected', () => {
    expect(component.groupedTopics()).toEqual([]);
  });

  // 6
  it('clears invalid topic selections when difficulty changes', () => {
    setDifficulty('beginner');
    component.toggleTopic('ts', true);
    component.toggleTopic('templates', true);
    expect(component.selectedTopicIds().length).toBe(2);

    setDifficulty('advanced');
    expect(component.selectedTopicIds().length).toBe(0);
  });

  // 7
  it('defaults to 20 questions', () => {
    expect(component.questionCount()).toBe(20);
  });

  // 8
  it('derives duration from the question count', () => {
    setDifficulty('mixed');
    component.selectAllTopics();
    component.setCount(10);
    expect(component.durationMinutes()).toBe(15);
    component.setCount(20);
    expect(component.durationMinutes()).toBe(30);
    component.setCount(30);
    expect(component.durationMinutes()).toBe(45);
  });

  // 9
  it('disables question counts that exceed the eligible pool', () => {
    setDifficulty('beginner');
    component.toggleTopic('ts', true);        // pool = 10
    expect(component.isCountDisabled(10)).toBe(false);
    expect(component.isCountDisabled(20)).toBe(true);
    expect(component.isCountDisabled(30)).toBe(true);
    // a disabled count cannot be selected
    component.setCount(30);
    expect(component.questionCount()).toBe(20);
  });

  // 10
  it('disables Start with no topics selected', () => {
    setDifficulty('mixed');
    expect(component.startDisabled()).toBe(true);
  });

  // 11
  it('disables Start when the pool is insufficient for the count', () => {
    setDifficulty('beginner');
    component.toggleTopic('ts', true);        // pool 10, default count 20
    expect(component.startDisabled()).toBe(true);
    expect(component.invalidReason()).toContain('Only 10 questions');
  });

  // 12
  it('updates the preview from the current selections', () => {
    setDifficulty('beginner');
    component.toggleTopic('ts', true);
    component.toggleTopic('templates', true);
    expect(component.eligiblePool().total).toBe(20);
    expect(component.selectedTopicNames().sort()).toEqual(['TEMPLATES', 'TS']);
    expect(component.startDisabled()).toBe(false);   // 20 available, count 20
  });

  // 13
  it('triggers assessment generation exactly once on Start', async () => {
    const session = TestBed.inject(InterviewSessionService);
    const startSpy = jest.spyOn(session, 'start');

    setDifficulty('beginner');
    component.toggleTopic('ts', true);
    component.toggleTopic('templates', true);   // pool 20, count 20 → valid

    await component.startInterview();

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledWith({
      difficulty: 'beginner',
      topicIds: ['ts', 'templates'],
      questionCount: 20
    });
    expect(spinner.showForStart).toHaveBeenCalledTimes(1);
    expect(router.navigate).toHaveBeenCalledWith(['/interview/session']);
  });
});
