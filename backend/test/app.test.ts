import request from 'supertest';
import type { Express } from 'express';

import { createApp } from '../src/app';
import { loadConfig, type AppConfig } from '../src/config';
import { fixtureDependencies } from './helpers/fixtures';

const ALLOWED = 'http://localhost:4200';
const DISALLOWED = 'https://evil.example.com';

/** Uses a FIXTURE repository — these tests never touch the real data file. */
function app(overrides: Record<string, string> = {}): Express {
  const config: AppConfig = loadConfig({
    NODE_ENV: 'test',
    ALLOWED_ORIGINS: ALLOWED,
    ...overrides
  } as NodeJS.ProcessEnv);
  return createApp(config, fixtureDependencies());
}

describe('startup', () => {
  it('builds an app without binding a port', () => {
    expect(() => app()).not.toThrow();
  });

  it('serves the health endpoint', async () => {
    const res = await request(app()).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.uptimeSeconds).toBe('number');
  });

  it('health leaks NO configuration — no origins, paths, versions or env', async () => {
    const res = await request(app()).get('/api/health');
    const serialized = JSON.stringify(res.body);
    for (const leak of ['origin', 'path', 'quiz', 'database', 'env', 'version', '4200']) {
      expect(serialized.toLowerCase()).not.toContain(leak);
    }
    expect(Object.keys(res.body).sort()).toEqual(['status', 'uptimeSeconds']);
  });

  it('does not advertise the stack', async () => {
    const res = await request(app()).get('/api/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('sets the hardening headers, including no-store', async () => {
    const res = await request(app()).get('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('CORS', () => {
  it('allows a configured origin', async () => {
    const res = await request(app()).get('/api/health').set('Origin', ALLOWED);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
  });

  it('does NOT grant CORS headers to an unlisted origin', async () => {
    const res = await request(app()).get('/api/health').set('Origin', DISALLOWED);
    // The request still completes (CORS is browser-enforced) but carries no grant.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('never answers with a wildcard', async () => {
    for (const origin of [ALLOWED, DISALLOWED]) {
      const res = await request(app()).get('/api/health').set('Origin', origin);
      expect(res.headers['access-control-allow-origin']).not.toBe('*');
    }
  });

  it('never enables credentials — the token rides in Authorization, not a cookie', async () => {
    const res = await request(app()).get('/api/health').set('Origin', ALLOWED);
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('permits the Authorization header on preflight for an allowed origin', async () => {
    const res = await request(app())
      .options('/api/health')
      .set('Origin', ALLOWED)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type');

    expect(res.headers['access-control-allow-headers']?.toLowerCase())
      .toContain('authorization');
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
  });

  it('withholds the preflight grant from an unlisted origin', async () => {
    const res = await request(app())
      .options('/api/health')
      .set('Origin', DISALLOWED)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('serves a request with NO Origin header (curl / same-origin)', async () => {
    const res = await request(app()).get('/api/health');
    expect(res.status).toBe(200);
  });
});

describe('error handling', () => {
  it('returns the standard body shape for an unknown route', async () => {
    const res = await request(app()).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'Resource not found' }
    });
  });

  it('uses the same shape for a non-/api path', async () => {
    const res = await request(app()).get('/');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('reports malformed JSON as a 400, not a 500', async () => {
    const res = await request(app())
      .post('/api/health')
      .set('Content-Type', 'application/json')
      .send('{ not json');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('rejects an oversized body with 413', async () => {
    const res = await request(app())
      .post('/api/health')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ padding: 'x'.repeat(64 * 1024) }));

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('error bodies expose only code and message — no stack, path or internals', async () => {
    const res = await request(app()).get('/api/nope');
    expect(Object.keys(res.body)).toEqual(['error']);
    expect(Object.keys(res.body.error).sort()).toEqual(['code', 'message']);
    const serialized = JSON.stringify(res.body);
    for (const leak of ['stack', 'at ', 'node_modules', 'quiz.json', 'C:\\', '/srv']) {
      expect(serialized).not.toContain(leak);
    }
  });
});

describe('no raw quiz file is reachable', () => {
  it.each([
    '/api/quiz.json',
    '/data/quiz.json',
    '/quiz.json',
    '/assets/data/quiz.json'
  ])('404s %s — nothing static is served', async (path) => {
    const res = await request(app()).get(path);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('correct');
  });

  it('/api/quizzes is metadata ONLY — it is not a question dump', async () => {
    const res = await request(app()).get('/api/quizzes');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('questionText');
    expect(res.text).not.toContain('PRIVATE-EXPLANATION');
  });
});
