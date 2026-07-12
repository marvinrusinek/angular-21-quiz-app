import { Injectable } from '@angular/core';
import { Howl } from 'howler';

import { SelectedOption } from '../../models/SelectedOption.model';

import { isOptionCorrect } from '../../utils/is-option-correct';

@Injectable({ providedIn: 'root' })
export class SoundService {
  // ── properties ──────────────────────────────────────────────────
  private sounds: { [key: string]: Howl } = {};

  // ── constructor / lifecycle ─────────────────────────────────────
  constructor() {
    this.initializeSounds();
  }

  // ── public methods ──────────────────────────────────────────────
  initializeSounds(): void {
    const commonConfig = {
      html5: false,
      format: ['mp3'],
      preload: true
    };

    // Use jsDelivr CDN to serve proper MIME types (audio/mpeg) and CORS headers for GitHub files
    const baseUrl = 'https://cdn.jsdelivr.net/gh/marvinrusinek/angular-21-quiz-app@main/src/assets/sounds';

    this.sounds['correct'] = new Howl({
      src: [`${baseUrl}/correct.mp3`],
      ...commonConfig
    });

    this.sounds['incorrect'] = new Howl({
      src: [`${baseUrl}/incorrect.mp3`],
      ...commonConfig
    });
  }

  playOnceForOption(option: SelectedOption): void {
    if (!option.selected) return;

    const soundKey = isOptionCorrect(option) ? 'correct' : 'incorrect';
    
    this.play(soundKey);
  }

  play(soundName: string): void {
    const sound = this.sounds[soundName];
    if (sound) sound.play();
  }
}