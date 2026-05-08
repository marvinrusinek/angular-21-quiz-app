import { Injectable, ViewContainerRef, ComponentRef, Type } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class DynamicComponentService {
  private cachedAnswerComponent: Type<any> | null = null;
  private loadingPromise: Promise<Type<any>> | null = null;

  constructor() {}

  private async importComponent(): Promise<Type<any>> {
    // Already cached → instant
    if (this.cachedAnswerComponent) return this.cachedAnswerComponent;

    // Already loading → wait for same promise
    if (this.loadingPromise) return this.loadingPromise;

    // First load (real one)
    this.loadingPromise =
      import('../../../components/question/answer/answer-component/answer.component').then(
        (module) => {
          if (!module?.AnswerComponent) {
            throw new Error(
              '[DynamicComponentService] AnswerComponent missing from module'
            );
          }

          this.cachedAnswerComponent = module.AnswerComponent;
          return module.AnswerComponent;
        }
      );

    return this.loadingPromise;
  }

  public async loadComponent<T>(
    container: ViewContainerRef,
    multipleAnswer: boolean,
    onOptionClicked: (event: any) => void
  ): Promise<ComponentRef<T>> {
    const AnswerComponent = await this.importComponent();

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