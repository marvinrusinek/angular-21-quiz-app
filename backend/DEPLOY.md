# Hosting the Interview API

Interview Mode is backend-driven: the browser never receives the answer key, so
the app cannot run an interview without a reachable API. Until this is hosted,
Interview Mode fails closed on GitHub Pages with *"Interview Mode is not
configured for this environment"* — by design, not a bug. Topic Quizzes and
Weak Areas Practice are unaffected; they stay local.

There are **two** frontend values to set afterwards, and setting only one leaves
every request blocked with no visible error. Step 3 covers both.

---

## 1. Deploy the API

The image is host-agnostic (`backend/Dockerfile`). Any platform that runs a
container with a persistent volume works.

### Render (blueprint included)

1. Push this branch to GitHub.
2. Render dashboard → **New → Blueprint** → pick the repo. It reads
   `render.yaml` and creates the service.
3. Deploy, then confirm:
   ```
   curl https://<your-service>.onrender.com/api/health
   → {"status":"ok","uptimeSeconds":…}
   ```

### Fly.io / Railway

Same image, same environment variables:

```
NODE_ENV=production
ALLOWED_ORIGINS=https://marvinrusinek.github.io
DATABASE_PATH=/data/sessions.db
```

Mount a volume at `/data` and let the platform inject `PORT`. On Fly:
`fly launch --dockerfile backend/Dockerfile` then `fly volumes create data`.

### Sessions are EPHEMERAL on the free tier — what that actually costs

The blueprint runs free, with the database in `/tmp`. `better-sqlite3` writes a
real file, and a free instance's filesystem is wiped on every redeploy and
after ~15 minutes idle. Concretely:

- **A submitted interview becomes unreachable after a restart.** Its Results
  page reports the service as unavailable.
- **The score is NOT lost.** Interview History is client-side and already
  sanitized, so the attempt, percentage and per-topic breakdown survive. Only
  the per-question review — which lives on the server by design — is gone.
- **An interview in progress is safe.** Answering sends traffic, and a service
  with traffic does not idle out. Assessments run 15 minutes anyway.
- **Cold starts.** The first request after an idle period takes roughly 30-60
  seconds. Starting an interview can feel slow, or time out into the retry
  state. Clicking Start again works once the service is warm.

Unrelated to hosting, but often confused with it: the session **reference**
(id + token) lives in `sessionStorage`, which is per-tab. Reloading a tab
resumes fine; a NEW tab cannot see the interview, though the original tab can
still finish it. That is deliberate — the token is kept out of `localStorage`
so it cannot outlive the tab.

**To make sessions durable:** set `plan: starter` in `render.yaml`, uncomment
the `disk:` block, and set `DATABASE_PATH=/data/sessions.db`. Nothing else
changes.

---

## 2. Environment variables

| Variable | Value | Why |
|---|---|---|
| `NODE_ENV` | `production` | Enables the strict origin checks below. |
| `ALLOWED_ORIGINS` | `https://marvinrusinek.github.io` | EXACT origins, comma-separated. A wildcard is rejected outright, and production requires https — the server refuses to start otherwise rather than starting insecure. |
| `DATABASE_PATH` | `/data/sessions.db` | Must point at the mounted volume. |
| `PORT` | injected by the host | Do not hard-code. |
| `QUIZ_DATA_PATH` | *(leave unset)* | Defaults to `./data/quiz.json`, baked into the image. |

Add your dev origin (`http://localhost:4200`) only if you want a local frontend
to talk to the hosted API. It is not needed for the deployed site.

---

## 3. Point the frontend at it — BOTH of these

Once you have the API URL, set it in **two** places. Missing either one leaves
Interview Mode broken, and the CSP failure is silent — the browser blocks the
request before it is sent, so there is nothing in the network tab and no error
in the app.

**a. `src/app/shared/tokens/api-base-url.token.ts`**

```ts
export const PROD_API_BASE_URL = 'https://<your-service>.onrender.com/api';
```

Note the `/api` suffix — every route is mounted under it.

**b. `src/index.html`** — add the origin (scheme + host only, no path) to
`connect-src`:

```
connect-src 'self' https://cdn.jsdelivr.net
            http://localhost:3000 http://127.0.0.1:3000
            https://<your-service>.onrender.com;
```

Then rebuild and redeploy the frontend.

---

## 4. Verify

```
# API reachable and healthy
curl https://<your-service>.onrender.com/api/health

# Metadata only — no options, no correct flags, no explanations
curl https://<your-service>.onrender.com/api/quizzes

# The quiz bank is NOT served as a file, from any path
curl -o /dev/null -w '%{http_code}\n' https://<your-service>.onrender.com/quiz.json
→ 404
```

Then on the live site: build an interview, answer, submit, refresh the Results
page. A refresh re-fetches the frozen result from the server — it is not
restored from browser storage, which is the whole point.

Watch for a CORS failure in the console on first use; it means
`ALLOWED_ORIGINS` does not exactly match the site origin (no trailing slash, no
path).
