<h1 align="center">🚀 Angular Quiz App</h1>

<p align="center">
A feature-rich quiz platform built with <strong>Angular 21</strong> that demonstrates modern frontend engineering through <strong>Angular Signals</strong> and <strong>RxJS</strong> for reactive state management, together with a modular service-oriented architecture.
</p>

<p align="center">
<img src="https://img.shields.io/badge/Angular-21-red">
<img src="https://img.shields.io/badge/TypeScript-Enabled-blue">
<img src="https://img.shields.io/badge/RxJS-Reactive-purple">
<img src="https://img.shields.io/badge/Signals-Integrated-orange">
<img src="https://img.shields.io/badge/Status-Active%20Development-brightgreen">
</p>

<p align="center">
<a href="https://marvinrusinek.github.io/angular-21-quiz-app" target="_blank">
▶ Launch Live Demo
</a>
</p>

<hr>

<h2>📸 Screenshot</h2>

<p align="center">
<img src="screenshots/ss01.jpg" alt="Dependency Injection Quiz — Question 1 of 6" width="420">
</p>

<hr>

<h2>🎯 Goal / Purpose</h2>

<p>
This project demonstrates modern Angular application architecture through a feature-rich quiz platform built with
<strong>Angular 21</strong>, <strong>Signals</strong>, <strong>RxJS</strong>, and a
<strong>modular service-oriented architecture</strong>.
</p>

<p>
It showcases scalable frontend engineering practices including reactive state management, dynamic UI rendering,
component decoupling, performance optimization, and maintainable application design.
</p>

<p>
The application has undergone extensive refactoring to reduce component complexity, improve separation of concerns,
increase testability, and organize quiz behavior into focused services and reusable UI layers.
</p>

<hr>

<h2>🏆 Engineering Highlights</h2>

<ul>
<li>Built with <strong>Angular 21</strong>, <strong>TypeScript</strong>, <strong>RxJS</strong>, and <strong>Angular Signals</strong></li>
<li>Architected using a <strong>modular service-oriented design</strong> with standalone components and clear separation of concerns</li>
<li>Combines <strong>Signals</strong> for reactive UI state with <strong>RxJS</strong> for asynchronous and event-driven workflows</li>
<li>Supports <strong>single-answer</strong> and <strong>multiple-answer</strong> quiz modes with distinct interaction, scoring, and feedback logic</li>
<li>Implements question timing, answer validation, score analysis, explanation rendering, and quiz progress tracking</li>
<li>Includes comprehensive <strong>unit</strong> and <strong>end-to-end testing</strong> to improve reliability and reduce regressions</li>
</ul>

<hr>

<h2>✨ Core Features</h2>

<h3>🧠 Multiple Question Types</h3>
<p>
Supports both <strong>single-answer</strong> and <strong>multiple-answer</strong> questions,
each with its own selection rules, validation, scoring, and feedback behavior.
</p>

<h3>💡 Immediate Feedback & Explanations</h3>
<p>
Provides real-time answer feedback with detailed explanation text to reinforce learning
and improve quiz engagement.
</p>

<h3>⏱️ Timer-Based Quiz Flow</h3>
<p>
Supports timed questions with automatic timeout handling, progress updates,
and consistent navigation behavior.
</p>

<h3>🔀 Question & Answer Shuffling</h3>
<p>
Randomizes both question order and answer choices while preserving correct scoring,
feedback, quiz review, and results.
</p>

<h3>📊 Quiz Review & Score Analysis</h3>
<p>
Includes a detailed post-quiz review with score analysis, correct answers,
user selections, and performance summaries.
</p>

<h3>📈 Live Progress Tracking</h3>
<p>
Tracks score and quiz progress throughout each session, giving users continuous
feedback as they advance.
</p>

<h3>🧪 Robust Testing</h3>

<p>
Comprehensive unit and end-to-end tests help ensure application reliability
and prevent regressions as new features are added.
</p>

<hr>

<h2>🧭 Architecture Overview</h2>

<p>
The application follows a modular Angular architecture in which container components orchestrate application flow,
specialized services encapsulate business logic, and reactive state keeps the UI synchronized with user interactions.
</p>

<p>
It combines <strong>Angular Signals</strong> for fine-grained reactive UI state with <strong>RxJS</strong> for asynchronous data flows,
event coordination, and cross-component communication.
</p>

<h3>High-Level Flow</h3>

<pre><code>
[User Interaction]
        ↓
[Container Components]
Introduction / Quiz / Results
        ↓
[Question & Answer Components]
        ↓
[Service Layer]
 ├── QuizService
 ├── QuizStateService
 ├── SelectedOptionService
 ├── ExplanationTextService
 ├── TimerService
 └── SelectionMessageService
        ↓
[Signals + RxJS]
        ↓
[Reactive UI]
Score • Feedback • Quiz Review • Results
</code></pre>

<hr>

<h2>🛠️ Technology Stack</h2>

<ul>
<li><strong>Framework:</strong> Angular 21</li>
<li><strong>Language:</strong> TypeScript</li>
<li><strong>State Management:</strong> Angular Signals, RxJS</li>
<li><strong>UI:</strong> Angular Material, SCSS</li>
<li><strong>Forms:</strong> Reactive Forms</li>
<li><strong>Testing:</strong> Unit Testing, End-to-End Testing</li>
<li><strong>Platform:</strong> Progressive Web App (PWA)</li>
</ul>

<hr>

<h2>📁 Project Structure</h2>
<p>The project is organized into reusable UI components, feature containers, and focused service layers to promote separation of concerns, maintainability, and scalability.</p>
<pre><code>
src/
├── app/
│   ├── components/     # Reusable UI components
│   ├── containers/     # Feature containers and page orchestration
│   ├── shared/
│   │   ├── services/   # Business logic and application state
│   │   ├── models/     # Shared TypeScript models and interfaces
│   │   └── utils/      # Utility functions and helpers
│   ├── pipes/          # Custom Angular pipes
│   ├── directives/     # Custom Angular directives
│   └── animations/     # Reusable animations
</code></pre>

<pre><code>
shared/
├── services/
│   ├── quiz/
│   ├── answer/
│   ├── feedback/
│   ├── navigation/
│   └── timer/
</code></pre>

<hr>

<h2>⭐ Support</h2>

<p> If you enjoyed exploring this project or found it helpful, a ⭐ on GitHub is greatly appreciated - it helps support its on-going development. </p>

<hr>

<h2>⚙️ Getting Started</h2>

<h3>Prerequisites</h3>

<ul>
<li>Node.js 18 or later</li>
<li>Angular CLI 20 or later</li>
</ul>

<h3>Installation</h3>

<pre><code>git clone https://github.com/marvinrusinek/angular-21-quiz-app.git
cd angular-21-quiz-app
npm install
</code></pre>

<h3>Run the Development Server</h3>

<pre><code>ng serve</code></pre>

<p>Open your browser and navigate to:</p>

<pre><code>http://localhost:4200</code></pre>

<p>The application will automatically reload when source files are modified.</p>

<hr>

<h2>🚀 Upcoming Features</h2>

<ul>
<li>Expand quiz coverage with additional Angular topics, including <strong>RxJS</strong> and <strong>Signals</strong></li>
<li>Add enhanced quiz review capabilities, including advanced filtering and sorting</li>
<li>Introduce difficulty-based quiz organization and learning progression</li>
<li>Continue refining Angular Signals usage and modern Angular patterns throughout the application</li>
<li>Further simplify complex feature areas through ongoing architectural refactoring</li>
<li>Enhance accessibility, responsive design, and touch interactions</li>
<li>Expand performance insights and post-quiz analytics</li>
</ul>

<hr>

<h2>📄 License</h2>

<p> Distributed under the <strong>MIT License</strong>. See the <a href="./LICENSE">LICENSE</a> file for more information. </p>
