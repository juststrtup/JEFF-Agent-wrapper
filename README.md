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

This system integrates with OpenAI API models configured via environment variables:
- **Core Agent Executions**: Configured to run on **`gpt-4o-mini`** (customizable via `JEFF_AGENT_MODEL` and `INFORMER_AGENT_MODEL` env vars).
- **Guardrails Moderation & Jailbreak Checks**: Configured to run on **`gpt-4.1-mini`** for high-performance classification. 

--- 

## Database

- PostgreSQL
- SQLAlchemy Async
- Alembic migrations

---

## Authentication

G2 authenticates protected API calls with a signed WordPress JWT.

- `REQUIRE_AUTH=true`: protected endpoints require `Authorization: Bearer <jwt>`.
- `REQUIRE_AUTH=false`: local development preserves the legacy behavior by allowing the request's user_id to be used when no JWT is supplied.
- `WP_JWT_SECRET`: shared secret used to verify WordPress JWT signatures.

Authenticated endpoints:

- `POST /chat`
- `POST /clear`
- `GET /history/{session_id}`
- `POST /export/xlsx`
- `POST /export/pdf`

Public endpoints:

- `GET /`
- `GET /health`

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

## Project Status

### What's Done
- **Dual-Process Daemon**: Setup `start.sh` and updated `render.yaml` to ensure both FastAPI and the Express sidecar launch automatically in production.
- **NDJSON Stream Piping**: Replaced simulated streaming with native `StreamedRunResult` token piping.
- **Quotas & Memory**: Implemented a rolling 24-hour token limit, 2-hour sliding session TTL, and persistent per-mode session tracking backed by PostgreSQL.
- **Export Pipeline**: Server-side Excel (`openpyxl`) and PDF (`reportlab`) file generation are fully active.
- **Campaign Builder Rename**: Updated the frontend and backend modes from `pitch_deck` to `campaign_builder`.
- **Database Migrations**: Introduced Alembic for version-controlled schema management and database migrations. 
- **PostgreSQL Persistence**: Replaced in-memory session history and token usage storage with PostgreSQL using SQLAlchemy Async.
- **Persistent Per-Mode Sessions**: Session IDs are persisted per interaction mode in the frontend and synchronized with PostgreSQL, allowing conversations to survive browser refreshes while maintaining independent histories for each Jeff mode.
- **JWT Authentication**: Feature-flagged WordPress JWT verification with authenticated user isolation, protected API endpoints, and local JWT generation utility for development.


### What's Pending & Known Limitations
- **Multi-instance scaling**: Future support for distributed caching (e.g. Redis) if horizontal scaling is required.
- **Concurrent quota synchronization**: Future support for transactional locking or equivalent concurrency control to ensure accurate quota enforcement under high concurrent load.
- **System Prompts**: OpenAI system prompts for Campaign Builder are managed on the OpenAI platform dashboard, not inside this repository.

### Known-Broken
- None. (All endpoints are fully operational).

### What We Tested & How
- **Health Checks**: Verified that `/health` resolves with both FastAPI and sidecar active.
- **Chat Endpoints**: Confirmed stream responses, CORS origin rules, and header returns locally and on the live Render environment.
- **Quota Enforcements**: Validated `429` status responses and header balance deductions.
- **File Exports**: Checked downloaded `.xlsx` and `.pdf` files locally to ensure columns and styles compile correctly.
- **Hosted Agent Tools**: Verified automatic hosted tool invocation (e.g., Web Search) using the configured production model.
- **Session Persistence**: Verified that browser refreshes preserve conversation history while maintaining isolated histories for each interaction mode.
