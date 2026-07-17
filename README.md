# JEFF Agent Wrapper

The **JEFF Agent Wrapper** is a FastAPI gateway proxy designed to interface with a persistent Node.js agent execution sidecar. It manages cross-origin access (CORS), handles sliding-session memory, enforces rolling token caps, and parses structured data to generate downloadable PDF and Excel reports.

- **Production API Playground**: [https://jeff-agent-wrapper.onrender.com/](https://jeff-agent-wrapper.onrender.com/)

---

## Mechanism & Architecture

The application uses a **FastAPI Proxy + Node.js Sidecar** design pattern:
1. **Client Request**: The client sends a `POST /chat` request to the FastAPI app (Port 8000).
2. **FastAPI Layer**: FastAPI verifies the user's rolling 24-hour token quota and loads the conversation history from memory. It compiles the request and calls the internal Node.js sidecar (Port 3000) over local HTTP.
3. **Node.js Sidecar**: The Express sidecar processes the user query using the `@openai/agents` SDK, first passing the prompt through `@openai/guardrails` to check for PII, NSFW, and prompt injection. If guardrails are triggered, it routes the message to the restricted Informer agent; otherwise, it queries the main Jeff agent.
4. **Streaming Response**: The sidecar streams NDJSON tokens to FastAPI, which forwards the streamed response to the client. Upon completion, the sidecar returns the final token usage statistics to update the quota ledger. Depending on the deployment platform, proxy buffering may affect how streaming is observed by the client.
---

## Model Configuration

This system integrates with OpenAI API models configured via environment variables:
- **Core Agent Executions**: Configured to run on **`gpt-4o-mini`** (customizable via `JEFF_AGENT_MODEL` and `INFORMER_AGENT_MODEL` env vars).
- **Guardrails Moderation & Jailbreak Checks**: Configured to run on **`gpt-4.1-mini`** for high-performance classification. 

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
curl -X GET https://jeff-agent-wrapper.onrender.com/history/<session_id> 
``` 
*Expected Response:*
```json
{
  "session_id": "...",
  "message_count": 4,
  "message": [
    ...
  ]
}
``` 

#### C. Streaming Chat Request (POST /chat)
**Gold Input:** `"I want to launch a SaaS startup, give me a quick campaign hook."`
```bash
curl -X POST https://jeff-agent-wrapper.onrender.com/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "I want to launch a SaaS startup, give me a quick campaign hook.", "mode": "campaign_builder"}'
```
*Expected Behavior:* Response body streams markdown text chunk-by-chunk while returning `X-Tokens-Remaining` headers.

#### D. Spreadsheet Export (POST /export/xlsx)
```bash
curl -X POST https://jeff-agent-wrapper.onrender.com/export/xlsx \
  -H "Content-Type: application/json" \
  -d '{"payload": {"summary": "Q1 Financial Projection", "rows": [{"month": "Jan", "revenue": 10000, "burn": 4000}]}, "filename": "projection"}' \
  --output projection.xlsx
```

#### E. PDF Report Export (POST /export/pdf)
```bash
curl -X POST https://jeff-agent-wrapper.onrender.com/export/pdf \
  -H "Content-Type: application/json" \
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
- **Quotas & Memory**: Implemented a rolling 24-hour limit of 150,000 tokens per user and a 2-hour inactivity sliding TTL for session histories.
- **Export Pipeline**: Server-side Excel (`openpyxl`) and PDF (`reportlab`) file generation are fully active.
- **Campaign Builder Rename**: Updated the frontend and backend modes from `pitch_deck` to `campaign_builder`.

### What's Pending & Known Limitations
- **Scaling Persistence**: Quota ledger and session history are currently stored in-memory. **Needs Redis** for multi-instance production environments.
- **System Prompts**: OpenAI system prompts for Campaign Builder are managed on the OpenAI platform dashboard, not inside this repository.

### Known-Broken
- None. (All endpoints are fully operational).

### What We Tested & How
- **Health Checks**: Verified that `/health` resolves with both FastAPI and sidecar active.
- **Chat Endpoints**: Confirmed stream responses, CORS origin rules, and header returns locally and on the live Render environment.
- **Quota Enforcements**: Validated `429` status responses and header balance deductions.
- **File Exports**: Checked downloaded `.xlsx` and `.pdf` files locally to ensure columns and styles compile correctly.
- **Hosted Agent Tools**: Verified automatic hosted tool invocation (e.g., Web Search) using the configured production model.
