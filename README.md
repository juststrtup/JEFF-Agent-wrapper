# JEFF Agent Wrapper

The **JEFF Agent Wrapper** is a FastAPI gateway proxy designed to interface with a persistent Node.js agent execution sidecar. It manages cross-origin access (CORS), handles sliding-session memory, enforces rolling token caps, and parses structured data to generate downloadable PDF and Excel reports.

- **Production API Playground**: [https://jeff-agent-wrapper.onrender.com/](https://jeff-agent-wrapper.onrender.com/)

---

## Mechanism & Architecture

The application uses a **FastAPI Proxy + Node.js Sidecar** design pattern:
1. **Client Request**: The client sends a `POST /chat` request to the FastAPI app (Port 8000).
2. **FastAPI Layer**: FastAPI verifies the user's rolling 24-hour token quota and loads the conversation history from PostgreSQL using SQLAlchemy Async. It compiles the request and calls the internal Node.js sidecar (Port 3000) over local HTTP. 
3. **Node.js Sidecar**: The Express sidecar processes the user query using the `@openai/agents` SDK, first passing the prompt through `@openai/guardrails` to check for PII, NSFW, and prompt injection. If guardrails are triggered, it routes the message to the restricted Informer agent; otherwise, it queries the main Jeff agent.
4. **Streaming Response**: The sidecar streams NDJSON tokens to FastAPI, which forwards the streamed response to the client. Upon completion, the sidecar returns the final token usage statistics to update the quota ledger stored in PostgreSQL. Depending on the deployment platform, proxy buffering may affect how streaming is observed by the client.
---

## Model Configuration

Agent model IDs are configured through environment variables. The checked-in Render configuration sets:

- **Jeff**: `JEFF_AGENT_MODEL=gpt-6.1-terra`.
- **Informer**: `INFORMER_AGENT_MODEL=gpt-4o-mini`.
- **Guardrails moderation and jailbreak checks**: `gpt-4.1-mini`.

`agent.ts` still falls back to `gpt-3.5-turbo` if either Jeff or Informer model setting is missing. The Jeff agent applies `JEFF_AGENT_REASONING_EFFORT=medium` and `JEFF_MAX_OUTPUT_TOKENS=1500` by default; both values are configurable. Cap hits are identified from provider completion or truncation metadata and logged for Jeff replies. Startup scoring uses `JEFF_SCORER_MODEL`, `JEFF_SCORER_SYSTEM_PROMPT`, and `JEFF_SCORER_REASONING_EFFORT`; keep the prompt value in private runtime configuration. The scorer remains disabled when its model or prompt is unset.

--- 

## Database

- PostgreSQL
- SQLAlchemy Async
- Alembic migrations

The existing `sessions`, `messages`, and `token_usage` tables store per-mode chat history and the rolling customer quota. The startup-understanding foundation adds:

- `slot_states`: one row per user for the latest slot scores, vision stages, thinnest slot, and aggregate percentages.
- `understanding_history`: per-user, per-mode readings used to restore the latest 24 graph points.
- `scorer_usage`: per-call scorer token details and provider cost, kept outside customer quota accounting.

Migrations `0002_understanding_state` and `0003_async_scorer_usage` create the scoring state, checkpoints, graph history, and internal scorer usage records. Fixed slot and stage weights and percentage calculations live in `understanding.py`.

---

## Authentication

G2 authenticates protected API calls with a signed WordPress JWT.

- `REQUIRE_AUTH=true`: protected endpoints require `Authorization: Bearer <jwt>`.
- `REQUIRE_AUTH=false`: local development preserves the legacy behavior by allowing the request's user_id to be used when no JWT is supplied.
- `WP_JWT_SECRET`: shared secret used to verify WordPress JWT signatures.

Authenticated endpoints:

- `POST /chat`
- `GET /usage` — current user's used/remaining tokens and next reset time.
- `GET /quota` — legacy quota response retained for existing clients.
- `GET /understanding` — current user's startup scores, vision stages, thinnest slot, and latest 24 readings.
- `POST /clear`
- `GET /history/{session_id}`
- `POST /export/xlsx`
- `POST /export/pdf`
- `POST /export/campaign`
Public endpoints:

- `GET /`
- `GET /health`

The active plan uses `PRO_TOKEN_LIMIT=150000` and `PRO_TOKEN_WINDOW_SECONDS=86400`. The window setting defaults to 86,400 seconds (24 hours); the development UI refreshes `/usage` on load and after each completed chat stream.

Generate a local test token:

```bash
python scripts/generate_test_jwt.py 123
```

When `REQUIRE_AUTH=true`, quota, sessions, and messages are keyed by the authenticated WordPress user id, not by client-supplied `user_id`.

---

## Agent Capabilities

Jeff is configured with OpenAI hosted tools including:

- Web Search
- Code Interpreter

Tool availability depends on the configured model and OpenAI account permissions.

---

## Frontend Integration

`agent_chat_final.html` is a standalone design and behavior prototype. The production change targets the WordPress frontend served by `[jeff_pro]`; port the interface into that plugin and preserve JWT/API URL injection, silent refresh, authenticated history, and streamed replies. The prototype itself is not a direct replacement for this repository’s `jeff-ui.html`.

The UI maps six personas to backend modes: `orb` → `general`, `investor`, `customer`, `business` → `business_model`, `campaign` → `campaign_builder`, and `financial`. General uses Jeff’s base instructions and has an independent per-user history. Extract inline images into optimized WebP assets, preload the aurora and active persona, and lazy-load other personas. The first-load target is below 400 KB. The plugin that serves `[jeff_pro]` is maintained outside this repository.

## Startup Insights

Startup understanding is shared across a user’s modes and is based only on founder statements. The configured GPT-6 Luna scorer runs asynchronously after every three founder messages and must not delay a Jeff reply. Its instructions are supplied through `JEFF_SCORER_SYSTEM_PROMPT`; if the scorer model or prompt is unset, live scoring is disabled while Jeff replies continue. It carries prior scores forward, can lower scores and vision stages when evidence changes, and leaves prior readings intact on failure.

The scorer uses 11 fixed startup slots and the weighted rubric, and the vision metric uses the fixed seven-stage ladder. `slot_states` stores the latest per-user slot and stage state; `understanding_history` stores per-user, per-mode readings for graph history. The authenticated `GET /understanding` endpoint returns the latest state and up to 24 readings. The development UI displays slot scores, the vision ladder, score trends, and the thinnest startup area. Scorer token usage and cost are recorded separately from customer quota usage in `scorer_usage`.

---

## How to Test

### 1. Verification Commands

#### A. Health Check
```bash
curl -X GET https://jeff-agent-wrapper.onrender.com/health
```
*Expected Response:*
```json
{
  "status": "ok",
  "service": "Jeff AI Agent",
  "sidecar": "ok"
}
``` 

#### B. Conversation History (GET /history/{session_id})
```bash
curl -X GET https://jeff-agent-wrapper.onrender.com/history/<session_id> \
  -H "Authorization: Bearer <jwt>"
``` 
*Expected Response:*
```json
{
  "session_id": "...",
  "message_count": 4,
  "messages": [
    ...
  ]
}
``` 

#### C. Streaming Chat Request (POST /chat)
**Gold Input:** `"I want to launch a SaaS startup, give me a quick campaign hook."`
```bash
curl -X POST https://jeff-agent-wrapper.onrender.com/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <jwt>" \
  -d '{"message": "I want to launch a SaaS startup, give me a quick campaign hook.", "mode": "campaign_builder"}'
```
*Expected Behavior:* Response body streams markdown text chunk-by-chunk while returning `X-Tokens-Remaining` headers.

#### D. Spreadsheet Export (POST /export/xlsx)
```bash
curl -X POST https://jeff-agent-wrapper.onrender.com/export/xlsx \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <jwt>" \
  -d '{"payload": {"summary": "Q1 Financial Projection", "rows": [{"month": "Jan", "revenue": 10000, "burn": 4000}]}, "filename": "projection"}' \
  --output projection.xlsx
```

#### E. PDF Report Export (POST /export/pdf)
```bash
curl -X POST https://jeff-agent-wrapper.onrender.com/export/pdf \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <jwt>" \
  -d '{"payload": {"title": "Campaign Launch Plan", "sections": [{"header": "Audience", "text": "Tech builders."}]}, "filename": "plan"}' \
  --output plan.pdf
```

#### F. Direct GET Fallback Error Check
```bash
curl -X GET https://jeff-agent-wrapper.onrender.com/chat
```
*Expected Response:* Returns a helpful JSON body explaining the required `POST` JSON format.

--- 

#### G. Campaign Registration Export (POST /export/campaign)

```bash
curl -X POST https://jeff-agent-wrapper.onrender.com/export/campaign \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <jwt>" \
  -d '{
    "payload": {
      "short_description": "AI task planner for students.",
      "long_description": "An AI-powered productivity platform that helps students plan coursework and prepare for placements.",
      "narrative": "Students struggle to stay consistent. Our platform combines planning, coaching, and accountability into one experience.",
      "funding": {
        "min_funds": 500000,
        "funding_goal": 1000000,
        "max_funds": 2000000,
        "currency": "INR"
      },
      "tags": [
        "edtech",
        "student-productivity",
        "india"
      ]
    },
    "filename": "campaign"
  }' \
  --output campaign.json
```

#### H. Startup Insight Formula Checks

Run the focused weighted-formula tests:

```bash
.venv/bin/python -m unittest discover -s tests -p test_understanding.py -v
```

Check the applied schema revision in the configured test database:

```bash
.venv/bin/alembic current
```

#### I. Scorer Usage Metric Checks

Build the sidecar and run the focused cache-usage parser checks:

```bash
npm run build
node tests/usage-metrics.test.js
```

---

## Project Status

### What's Done
- **Dual-Process Daemon**: Setup `start.sh` and updated `render.yaml` to ensure both FastAPI and the Express sidecar launch automatically in production.
- **NDJSON Stream Piping**: Replaced simulated streaming with native `StreamedRunResult` token piping.
- **Quotas & Memory**: Implemented a configurable rolling token window (active setting: 24 hours), `/usage`, a live development token chip, a 2-hour sliding session TTL, and persistent per-mode session tracking backed by PostgreSQL.
- **Export Pipeline**: Server-side Excel (`openpyxl`) and PDF (`reportlab`) file generation are fully active.
- **Campaign Builder Rename**: Updated the frontend and backend modes from `pitch_deck` to `campaign_builder`.
- **Database Migrations**: Introduced Alembic for version-controlled schema management and database migrations. 
- **PostgreSQL Persistence**: Replaced in-memory session history and token usage storage with PostgreSQL using SQLAlchemy Async.
- **Persistent Per-Mode Sessions**: Session IDs are persisted per interaction mode in the frontend and synchronized with PostgreSQL, maintaining independent conversation histories for each Jeff mode.
- **JWT Authentication**: Feature-flagged WordPress JWT verification with authenticated user isolation, protected API endpoints, and local JWT generation utility for development.
- **Campaign Builder**: Added cross-mode context retrieval, uploaded input overrides, Campaign Registration JSON validation, and downloadable JSON export.
- **Frontend History Restoration**: Added history hydration during Jeff UI initialization, restoring persisted user and assistant messages from PostgreSQL after browser refreshes. Expired JWTs are refreshed and the history request retried when necessary, while new sessions continue to display the mode-specific welcome message.
- **Startup Insight Foundation**: Added per-user slot state and per-user/per-mode history models, Alembic migration `0002_understanding_state`, and the fixed weighted percentage helpers.
- **Project 3 Development UI and Offline Scoring**: Ported the new chat prototype into the development `jeff-ui.html`, extracted its avatar and scene assets, and added the General backend mode. Ran the 20 November synthetic conversation set through GPT-6 Luna offline to review cumulative startup-understanding and vision scores before live scorer integration.
- **Live Startup Understanding**: Added the configured scorer agent and sidecar endpoint. The FastAPI chat path schedules scoring asynchronously after three persisted founder messages; Jeff's reply and customer quota accounting do not wait for or include scorer usage. Successful results update per-user slot/stage state, weighted percentages, the thinnest slot, the latest 24 graph readings, and separate scorer usage records.
- **Development Stats Sidebar**: Connected `GET /understanding` to the development UI, including slot scores, the vision ladder, the thinnest-area hint, and per-user score-trend graphs. Empty accounts display 0% and “No readings yet.” Jeff receives the saved thinnest-area hint as follow-up context.

### What's Pending & Known Limitations
- **Multi-instance coordination**: The scorer currently serializes work per user within one FastAPI process. Add distributed coordination before running multiple FastAPI workers or instances to prevent duplicate scorer calls.
- **Concurrent quota synchronization**: Future support for transactional locking or equivalent concurrency control to ensure accurate quota enforcement under high concurrent load.
- **System Prompts**: Jeff, Informer, and scorer instructions are supplied through environment variables (JEFF_SYSTEM_PROMPT, INFORMER_SYSTEM_PROMPT, JEFF_SCORER_SYSTEM_PROMPT) and managed outside this repository.
- **Jeff Pro UI and Startup Scoring**: The development UI and live async scorer are implemented in this repository; the active WordPress shortcode asset has not been switched. Per-turn cached-input and cache-write counts are logged for Jeff and scorer requests; first-week cache/cost reporting remains pending. Jeff’s 1,500-token cap and cap-hit logging are implemented in the sidecar.

### Known-Broken
- None currently identified. Live scoring requires migration `0003_async_scorer_usage` and the scorer model and prompt to be configured in the deployed environment.

### What We Tested & How
- **Health Checks**: Verified that `/health` resolves with both FastAPI and sidecar active.
- **Chat Endpoints**: Confirmed stream responses, CORS origin rules, and header returns locally and on the live Render environment.
- **Quota Enforcements**: Validated `429` status responses and header balance deductions.
- **File Exports**: Checked downloaded `.xlsx` and `.pdf` files locally to ensure columns and styles compile correctly.
- **Hosted Agent Tools**: Verified automatic hosted tool invocation (e.g., Web Search) using the configured production model.
- **Session Persistence & History Restoration**: Verified that browser refreshes restore persisted conversation history while maintaining isolated histories for each interaction mode. Also verified that previously persisted conversations remain retrievable after logout/login.
- **Campaign Builder**: Verified cross-mode context retrieval, uploaded input overrides, Campaign Registration JSON validation, and downloadable `.json` export through the `/export/campaign` endpoint.
- **Startup Insight Foundation**: The focused weighted-formula tests passed. Alembic applied `0003_async_scorer_usage` to the configured test database. A local health check with the configured sidecar returned `sidecar: ok` on port 8011 because port 8010 was occupied.
- **Project 3 Development UI and Offline Scoring**: Exercised 20 synthetic founder chat turns across all six modes on ports 8013–8020 and confirmed the chat histories were persisted. GPT-6 Luna scored five cumulative founder-only snapshots for each of four profiles; the weighted percentages use the existing formula helpers. The prompts, replies, per-turn scores, and review are archived in [`testing/archives/nov-20/20-conversations.json`](testing/archives/nov-20/20-conversations.json) and [`testing/archives/nov-20/score-trend-review.md`](testing/archives/nov-20/score-trend-review.md). This offline review does not verify live scorer scheduling, contradiction handling, or repeat-scoring stability.
- **Live Scoring and Usage Metrics**: Used the Agent Browser with six short founder messages on port 8015. Two asynchronous scorer calls completed, and the sidebar restored two readings after refresh. Corrected scorer cache-write counts stayed within total input tokens; both scorer calls reported zero cached reads. A Terra turn reported cached reads, confirming cache telemetry is available for Jeff. The focused usage-metric checks passed. Scorer provider cost was unavailable in this local run, so this check does not establish average cost per conversation or a representative cache-hit rate.
