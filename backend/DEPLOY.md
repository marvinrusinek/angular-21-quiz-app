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

### Why a paid instance

`better-sqlite3` writes to a real file. A free tier with an **ephemeral**
filesystem loses the database on every redeploy and idle spin-down, and any
interview submitted beforehand becomes unreachable — the Results page would
show "Cannot reach the interview service" for an assessment the user completed.
Render's `starter` plan is the cheapest tier that keeps a disk.

If you accept that trade-off, drop the `disk:` block and set
`DATABASE_PATH=/tmp/sessions.db`. Sessions then survive only until the next
restart. Nothing else breaks: history is client-side and already sanitized.

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
