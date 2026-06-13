import { Injectable, ViewContainerRef, ComponentRef, Type } from '@angular/core';

import { AnswerComponent } from '../../../components/question/answer/answer-component/answer.component';

@Injectable({ providedIn: 'root' })
export class DynamicComponentService {
  // ── public methods ──────────────────────────────────────────────
  // AnswerComponent is imported STATICALLY (bundled into the main chunk)
  // rather than via a dynamic import(). The lazy import produced a separate
  // hashed chunk (answer.component-*.js) whose fetch could fail on a cold load
  // ("Failed to fetch dynamically imported module" — observed in StackBlitz's
  // WebContainer), and a failed import() is cached as a rejected promise, so
  // retries could never recover. Eager-loading removes the chunk entirely so
  // the answer component can always be created. Method stays async for callers.
  public async loadComponent<T>(
    container: ViewContainerRef,
    multipleAnswer: boolean,
    onOptionClicked: (event: any) => void
  ): Promise<ComponentRef<T>> {
    container.clear();

    const componentRef = container.createComponent(AnswerComponent as Type<T>);

    (componentRef.instance as any).isMultipleAnswer = multipleAnswer;

    const instance: any = componentRef.instance;

    if (instance.optionClicked) {
      instance.optionClicked.subscribe((event: any) => {
        onOptionClicked(event);
      });
    }

    return componentRef;
  }
}
