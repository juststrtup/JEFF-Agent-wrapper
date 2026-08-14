import asyncio
import io
import json
import os
import re
import subprocess
import time
from datetime import datetime, timezone
from typing import Any
import httpx
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from openpyxl import Workbook
from pydantic import BaseModel, Field
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from auth import CurrentUser, get_current_user
from db.database import AsyncSessionLocal
from db.models import Message, Session as ChatSession, TokenUsage

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(BASE_DIR, ".env"))
load_dotenv(os.path.join(os.path.dirname(BASE_DIR), ".env"), override=False)

VALID_MODES = {"investor", "business_model", "customer", "campaign_builder", "financial"}
TOKEN_LIMIT = int(os.getenv("PRO_TOKEN_LIMIT", "150000"))
TOKEN_WINDOW_SECONDS = 24 * 60 * 60
SESSION_TTL_SECONDS = 2 * 60 * 60  # 2-hour session expiry
SIDECAR_URL = os.getenv("NODE_SIDECAR_URL", "http://127.0.0.1:3000")

app = FastAPI(
    title="Jeff AI Agent API",
    description="FastAPI endpoint wrapping the persistent TypeScript Jeff agent sidecar.",
    version="1.0.0",
)

cors_origins = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ORIGINS",
        "https://juststrtup.com,http://juststrtup.com,https://www.juststrtup.com,https://juststartup.com,http://juststartup.com,https://www.juststartup.com,http://localhost:8080,http://localhost:8000,http://127.0.0.1:8080,http://127.0.0.1:8000,http://localhost:8888,http://127.0.0.1:8888",
    ).split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=[
        "X-Session-Id",
        "X-Tokens-Limit",
        "X-Tokens-Remaining",
        "X-Tokens-Reset",
        "Retry-After",
    ],
)

node_process: subprocess.Popen | None = None


class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1)
    mode: str
    session_id: str = "default_session"
    user_id: str | None = None
    campaign_inputs: dict[str, str] | None = None


class ExportRequest(BaseModel):
    payload: Any | None = None
    content: Any | None = None
    filename: str = "jeff-export"
    title: str | None = None


CAMPAIGN_CONTEXT_SOURCES = {
    "business_model": "Business Model",
    "customer": "Customer",
    "financial": "Financial",
}

CAMPAIGN_INPUT_FIELDS = {
    "business_model": "Business Model",
    "target_users": "Target Users",
    "demographics": "Demographics",
    "financial_plan": "Financial Plan",
}


async def _sidecar_is_ready() -> bool:
    try:
        async with httpx.AsyncClient(timeout=1.0) as client:
            response = await client.get(f"{SIDECAR_URL}/health")
        return response.status_code == 200
    except Exception:
        return False


async def _wait_for_sidecar(timeout_seconds: int = 30) -> None:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        if await _sidecar_is_ready():
            return
        if node_process and node_process.poll() is not None:
            raise RuntimeError(f"Node sidecar exited early with code {node_process.returncode}")
        await asyncio.sleep(0.5)
    raise RuntimeError(f"Node sidecar did not become healthy at {SIDECAR_URL}")


@app.on_event("startup")
async def startup_event() -> None:
    global node_process

    if os.getenv("START_NODE_SIDECAR", "true").lower() == "false":
        return
    if await _sidecar_is_ready():
        return

    node_cmd = "node.exe" if os.name == "nt" else "node"
    compiled_server = os.path.join(BASE_DIR, "dist", "server.js")

    if not os.path.exists(compiled_server):
        raise RuntimeError(
            f"Compiled sidecar not found at {compiled_server}. "
            "Run 'npm run build' before starting the server."
        )

    node_process = subprocess.Popen([node_cmd, compiled_server], cwd=BASE_DIR)
    await _wait_for_sidecar()


@app.on_event("shutdown")
def shutdown_event() -> None:
    if node_process and node_process.poll() is None:
        node_process.terminate()


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


async def get_session_history(
    db: AsyncSession,
    user_id: str,
    mode: str,
    session_id: str,
) -> list[Message]:
    now = utc_now()
    chat_session = await db.get(ChatSession, {"user_id": user_id, "mode": mode})
    expired = (
        chat_session is not None
        and (now - chat_session.last_active_at).total_seconds() > SESSION_TTL_SECONDS
    )
    session_changed = chat_session is not None and chat_session.session_id != session_id

    if expired:
        await db.delete(chat_session)
        await db.flush()
        chat_session = None

    if chat_session is None:
        db.add(
            ChatSession(
                user_id=user_id,
                mode=mode,
                session_id=session_id,
                last_active_at=now,
            )
        )
    else:
        if session_changed:
           chat_session.session_id = session_id

        chat_session.last_active_at = now

    await db.commit()
    result = await db.execute(
        select(Message)
        .where(Message.user_id == user_id, Message.mode == mode)
        .order_by(Message.created_at, Message.id)
    )
    return list(result.scalars())


async def get_active_mode_history(db: AsyncSession, user_id: str, mode: str) -> list[Message]:
    now = utc_now()
    chat_session = await db.get(ChatSession, {"user_id": user_id, "mode": mode})
    if (
        chat_session is None
        or (now - chat_session.last_active_at).total_seconds() > SESSION_TTL_SECONDS
    ):
        return []

    result = await db.execute(
        select(Message)
        .where(Message.user_id == user_id, Message.mode == mode)
        .order_by(Message.created_at, Message.id)
    )
    return list(result.scalars())


def messages_as_text(messages: list[Message]) -> str:
    return "\n".join(f"{msg.role}: {msg.content}" for msg in messages if msg.content.strip())


def clean_campaign_inputs(campaign_inputs: dict[str, str] | None) -> dict[str, str]:
    if not isinstance(campaign_inputs, dict):
        return {}
    return {
        key: str(campaign_inputs.get(key, "")).strip()
        for key in CAMPAIGN_INPUT_FIELDS
        if str(campaign_inputs.get(key, "")).strip()
    }


async def campaign_builder_context(db: AsyncSession, user_id: str, campaign_inputs: dict[str, str] | None) -> str:
    uploaded = clean_campaign_inputs(campaign_inputs)
    histories = {
        mode: messages_as_text(await get_active_mode_history(db, user_id, mode))
        for mode in CAMPAIGN_CONTEXT_SOURCES
    }

    sections = [
        "[CAMPAIGN_BUILDER_CONTEXT]",
        "Use retrieved context as background. Uploaded inputs are authoritative and override retrieved context for the same field.",
    ]

    field_sources = [
        ("business_model", "business_model"),
        ("target_users", "customer"),
        ("demographics", "customer"),
        ("financial_plan", "financial"),
    ]
    for field, source_mode in field_sources:
        label = CAMPAIGN_INPUT_FIELDS[field]
        value = uploaded.get(field) or histories.get(source_mode)
        source = "uploaded" if uploaded.get(field) else f"retrieved:{CAMPAIGN_CONTEXT_SOURCES[source_mode]}"
        if value:
            sections.append(f"{label} ({source}):\n{value}")

    if not any(section.startswith(tuple(CAMPAIGN_INPUT_FIELDS.values())) for section in sections):
        sections.append("No prior campaign source context was found.")

    sections.append("[/CAMPAIGN_BUILDER_CONTEXT]")
    return "\n\n".join(sections)


def quota_key_for(request: ChatRequest, current_user: CurrentUser) -> str:
    if current_user.user_id:
        return current_user.user_id
    return request.user_id or request.session_id


async def load_token_events(
    db: AsyncSession,
    key: str,
    now: float | None = None,
) -> list[tuple[float, int]]:
    now = now or time.time()
    cutoff = datetime.fromtimestamp(now - TOKEN_WINDOW_SECONDS, timezone.utc)
    result = await db.execute(
        select(TokenUsage.created_at, TokenUsage.tokens)
        .where(TokenUsage.user_id == key, TokenUsage.created_at > cutoff)
        .order_by(TokenUsage.created_at)
    )
    return [(created_at.timestamp(), tokens) for created_at, tokens in result.all()]


async def quota_state(db: AsyncSession, key: str) -> dict[str, int]:
    now = time.time()
    events = await load_token_events(db, key, now)
    used = sum(tokens for _, tokens in events)
    reset_at = int((events[0][0] + TOKEN_WINDOW_SECONDS) if events else (now + TOKEN_WINDOW_SECONDS))
    remaining = max(0, TOKEN_LIMIT - used)
    return {"used": used, "remaining": remaining, "reset_at": reset_at}


async def record_token_usage(db: AsyncSession, key: str, input_tokens: int, output_tokens: int) -> None:
    total = max(0, int(input_tokens or 0)) + max(0, int(output_tokens or 0))
    if total <= 0:
        return
    db.add(TokenUsage(user_id=key, tokens=total, created_at=utc_now()))


async def quota_headers(db: AsyncSession, session_id: str, key: str) -> dict[str, str]:
    state = await quota_state(db, key)
    return {
        "X-Session-Id": session_id,
        "X-Tokens-Limit": str(TOKEN_LIMIT),
        "X-Tokens-Remaining": str(state["remaining"]),
        "X-Tokens-Reset": str(state["reset_at"]),
    }


def agent_history_from_session(chat_history: list[Message]) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    for msg in chat_history:
        if msg.role == "user":
            messages.append({"role": "user", "content": [{"type": "input_text", "text": msg.content}]})
        elif msg.role == "assistant":
            messages.append({"role": "assistant", "content": [{"type": "output_text", "text": msg.content}]})
    return messages


async def record_chat_messages(db: AsyncSession, user_id: str, mode: str, user_text: str, assistant_text: str) -> None:
    db.add(Message(user_id=user_id, mode=mode, role="user", content=user_text, created_at=utc_now()))
    db.add(Message(user_id=user_id, mode=mode, role="assistant", content=assistant_text, created_at=utc_now()))


async def get_history_by_session_id(db: AsyncSession, session_id: str, user_id: str | None = None) -> list[Message]:
    query = select(ChatSession).where(ChatSession.session_id == session_id)
    if user_id:
        query = query.where(ChatSession.user_id == user_id)
    result = await db.execute(
        query.order_by(ChatSession.last_active_at.desc()).limit(1)
    )
    chat_session = result.scalar_one_or_none()
    if chat_session is None:
        return []

    chat_session.last_active_at = utc_now()
    await db.commit()

    messages = await db.execute(
        select(Message)
        .where(Message.user_id == chat_session.user_id, Message.mode == chat_session.mode)
        .order_by(Message.created_at, Message.id)
    )
    return list(messages.scalars())


def safe_filename(filename: str, extension: str) -> str:
    base = re.sub(r"[^A-Za-z0-9_.-]+", "-", filename).strip(".-") or "jeff-export"
    if not base.lower().endswith(f".{extension}"):
        base = f"{base}.{extension}"
    return base


def export_payload(request: ExportRequest) -> Any:
    payload = request.payload if request.payload is not None else request.content
    if payload is None:
        raise HTTPException(status_code=422, detail="Either payload or content is required.")
    return payload


def strip_markdown_fences(text: str) -> str:
    stripped = text.strip()
    fence = re.fullmatch(r"```(?:json)?\s*([\s\S]*?)\s*```", stripped, re.IGNORECASE)
    return fence.group(1).strip() if fence else stripped


def repair_simple_json(text: str) -> str:
    repaired = text.replace("“", '"').replace("”", '"').replace("‘", "'").replace("’", "'")
    return re.sub(r",\s*([}\]])", r"\1", repaired)


def parse_campaign_json(payload: Any) -> Any:
    if isinstance(payload, (dict, list)):
        return payload
    if not isinstance(payload, str):
        raise HTTPException(status_code=502, detail="Campaign response was not valid JSON.")

    text = strip_markdown_fences(payload)
    decoder = json.JSONDecoder()
    last_error: json.JSONDecodeError | None = None

    for index, char in enumerate(text):
        if char not in "{[":
            continue
        try:
            parsed, _ = decoder.raw_decode(text[index:])
            if isinstance(parsed, str):
                parsed = parse_campaign_json(parsed)
            return parsed
        except json.JSONDecodeError as exc:
            last_error = exc
        try:
            parsed, _ = decoder.raw_decode(repair_simple_json(text[index:]))
            if isinstance(parsed, str):
                parsed = parse_campaign_json(parsed)
            return parsed
        except json.JSONDecodeError as exc:
            last_error = exc

    try:
        parsed = json.loads(text)
        if isinstance(parsed, str):
            return parse_campaign_json(parsed)
        return parsed
    except json.JSONDecodeError as exc:
        last_error = exc
    try:
        parsed = json.loads(repair_simple_json(text))
        if isinstance(parsed, str):
            return parse_campaign_json(parsed)
        return parsed
    except json.JSONDecodeError as exc:
        last_error = exc

    detail = "Campaign response was not valid JSON."
    if last_error:
        detail = f"{detail} {last_error.msg}"
    raise HTTPException(status_code=502, detail=detail)


def validate_campaign_registration(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise HTTPException(status_code=502, detail="Campaign JSON must be an object.")

    required_fields = ["short_description", "long_description", "narrative", "funding", "tags"]
    missing = [field for field in required_fields if field not in payload]
    if missing:
        raise HTTPException(status_code=502, detail=f"Campaign JSON is missing required fields: {', '.join(missing)}.")

    funding = payload["funding"]
    if not isinstance(funding, dict):
        raise HTTPException(status_code=502, detail="Campaign JSON field 'funding' must be an object.")

    funding_fields = ["min_funds", "funding_goal", "max_funds", "currency"]
    missing_funding = [field for field in funding_fields if field not in funding]
    if missing_funding:
        raise HTTPException(status_code=502, detail=f"Campaign JSON funding is missing required fields: {', '.join(missing_funding)}.")

    for field in ["min_funds", "funding_goal", "max_funds"]:
        if not isinstance(funding[field], (int, float)) or isinstance(funding[field], bool):
            raise HTTPException(status_code=502, detail=f"Campaign JSON funding field '{field}' must be numeric.")

    if funding["currency"] != "INR":
        raise HTTPException(status_code=502, detail="Campaign JSON funding currency must be INR.")

    if not funding["min_funds"] < funding["funding_goal"] < funding["max_funds"]:
        raise HTTPException(status_code=502, detail="Campaign JSON funding must satisfy min_funds < funding_goal < max_funds.")

    tags = payload["tags"]
    if not isinstance(tags, list):
        raise HTTPException(status_code=502, detail="Campaign JSON field 'tags' must be an array.")
    if not 3 <= len(tags) <= 7:
        raise HTTPException(status_code=502, detail="Campaign JSON must contain between 3 and 7 tags.")

    tag_pattern = re.compile(r"^[a-z]+(?:-[a-z]+)*$")
    for tag in tags:
        if not isinstance(tag, str):
            raise HTTPException(status_code=502, detail="Campaign JSON tags must all be strings.")
        if tag != tag.lower() or not tag_pattern.fullmatch(tag):
            raise HTTPException(status_code=502, detail="Campaign JSON tags must be lowercase kebab-case strings.")

    return payload


def scalar(value: Any) -> bool:
    return value is None or isinstance(value, (str, int, float, bool))


def write_table(ws, rows: list[Any], start_row: int) -> int:
    if not rows:
        return start_row
    if all(isinstance(row, dict) for row in rows):
        headers = sorted({key for row in rows for key in row.keys()})
        for col, header in enumerate(headers, 1):
            ws.cell(start_row, col, header)
        for row_index, row in enumerate(rows, start_row + 1):
            for col, header in enumerate(headers, 1):
                value = row.get(header)
                ws.cell(row_index, col, value if scalar(value) else json.dumps(value, ensure_ascii=False))
        return start_row + len(rows) + 2
    if all(isinstance(row, list) for row in rows):
        for row_index, row in enumerate(rows, start_row):
            for col, value in enumerate(row, 1):
                ws.cell(row_index, col, value if scalar(value) else json.dumps(value, ensure_ascii=False))
        return start_row + len(rows) + 1
    for offset, value in enumerate(rows):
        ws.cell(start_row + offset, 1, value if scalar(value) else json.dumps(value, ensure_ascii=False))
    return start_row + len(rows) + 1


def populate_workbook(ws, payload: Any) -> None:
    if isinstance(payload, list):
        write_table(ws, payload, 1)
        return
    if isinstance(payload, dict):
        row = 1
        for key, value in payload.items():
            ws.cell(row, 1, key)
            if isinstance(value, list):
                row += 1
                row = write_table(ws, value, row)
            elif isinstance(value, dict):
                ws.cell(row, 2, json.dumps(value, ensure_ascii=False, indent=2))
                row += 1
            else:
                ws.cell(row, 2, value)
                row += 1
        return
    for row, line in enumerate(str(payload).splitlines() or [str(payload)], 1):
        ws.cell(row, 1, line)


def pdf_elements(payload: Any, title: str) -> list[Any]:
    styles = getSampleStyleSheet()
    elements: list[Any] = [Paragraph(title, styles["Title"]), Spacer(1, 12)]

    if isinstance(payload, list) and payload and all(isinstance(row, dict) for row in payload):
        headers = sorted({key for row in payload for key in row.keys()})
        data = [headers] + [[str(row.get(header, "")) for header in headers] for row in payload]
        table = Table(data, repeatRows=1)
        table.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eeeeee")),
                    ("GRID", (0, 0), (-1, -1), 0.25, colors.grey),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ]
            )
        )
        elements.append(table)
        return elements

    text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False, indent=2)
    for line in str(text).splitlines() or [str(text)]:
        elements.append(Paragraph(line.replace(" ", "&nbsp;"), styles["BodyText"]))
    return elements


@app.get("/chat")
@app.get("/chat/")
async def chat_get():
    raise HTTPException(
        status_code=405,
        detail="Method Not Allowed. The /chat endpoint requires a POST request with a JSON payload (e.g., {'message': '...', 'mode': '...', 'session_id': '...'})."
    )


@app.post("/chat")
@app.post("/chat/")
async def chat(request: ChatRequest, current_user: CurrentUser = Depends(get_current_user)):
    if request.mode not in VALID_MODES:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid mode '{request.mode}'. Must be one of: {', '.join(sorted(VALID_MODES))}",
        )

    quota_key = quota_key_for(request, current_user)
    async with AsyncSessionLocal() as db:
        current_quota = await quota_state(db, quota_key)
    if current_quota["remaining"] <= 0:
        retry_after = max(1, current_quota["reset_at"] - int(time.time()))
        raise HTTPException(
            status_code=429,
            detail="Token limit exceeded for the last 24 hours.",
            headers={
                "Retry-After": str(retry_after),
                "X-Tokens-Limit": str(TOKEN_LIMIT),
                "X-Tokens-Remaining": "0",
                "X-Tokens-Reset": str(current_quota["reset_at"]),
            },
        )

    campaign_context = ""
    async with AsyncSessionLocal() as db:
        chat_history = await get_session_history(db, quota_key, request.mode, request.session_id)
        if request.mode == "campaign_builder":
            campaign_context = await campaign_builder_context(db, quota_key, request.campaign_inputs)
    messages = agent_history_from_session(chat_history)
    if campaign_context:
        messages.append({"role": "user", "content": [{"type": "input_text", "text": campaign_context}]})
    messages.append({"role": "user", "content": [{"type": "input_text", "text": request.message}]})

    payload = {"messages": messages, "mode": request.mode}

    async def stream_response():
        full_response = ""
        input_tokens = 0
        output_tokens = 0
        try:
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream("POST", f"{SIDECAR_URL}/chat", json=payload) as sidecar_response:
                    if sidecar_response.status_code != 200:
                        error_text = await sidecar_response.aread()
                        yield f"Jeff is unavailable right now. Sidecar returned {sidecar_response.status_code}: {error_text.decode(errors='replace')}"
                        return

                    async for line in sidecar_response.aiter_lines():
                        if not line:
                            continue
                        try:
                            event = json.loads(line)
                        except json.JSONDecodeError:
                            continue

                        event_type = event.get("type")
                        if event_type == "token":
                            text = event.get("text", "")
                            full_response += text
                            yield text
                        elif event_type == "usage":
                            usage = event.get("usage") or {}
                            input_tokens = int(usage.get("inputTokens") or usage.get("input_tokens") or 0)
                            output_tokens = int(usage.get("outputTokens") or usage.get("output_tokens") or 0)
                        elif event_type == "error":
                            yield event.get("message", "Jeff hit an internal error.")

            if full_response:
                async with AsyncSessionLocal() as db:
                    await record_chat_messages(db, quota_key, request.mode, request.message, full_response)
                    await record_token_usage(db, quota_key, input_tokens, output_tokens)
                    await db.commit()
            else:
                async with AsyncSessionLocal() as db:
                    await record_token_usage(db, quota_key, input_tokens, output_tokens)
                    await db.commit()
        except Exception as exc:
            yield f"Stream failed: {exc}"

    async with AsyncSessionLocal() as db:
        token_headers = await quota_headers(db, request.session_id, quota_key)
    headers = {
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        **token_headers,
    }
    return StreamingResponse(stream_response(), media_type="text/plain", headers=headers)


@app.get("/export/xlsx")
@app.get("/export/xlsx/")
async def export_xlsx_get():
    raise HTTPException(
        status_code=405,
        detail="Method Not Allowed. The /export/xlsx endpoint requires a POST request with a JSON payload (e.g., {'payload': ..., 'filename': '...'})."
    )


@app.post("/export/xlsx")
@app.post("/export/xlsx/")
async def export_xlsx(request: ExportRequest, current_user: CurrentUser = Depends(get_current_user)):
    payload = export_payload(request)
    wb = Workbook()
    ws = wb.active
    ws.title = "Jeff Export"
    populate_workbook(ws, payload)

    output = io.BytesIO()
    wb.save(output)
    output.seek(0)

    filename = safe_filename(request.filename, "xlsx")
    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/export/pdf")
@app.get("/export/pdf/")
async def export_pdf_get():
    raise HTTPException(
        status_code=405,
        detail="Method Not Allowed. The /export/pdf endpoint requires a POST request with a JSON payload (e.g., {'payload': ..., 'filename': '...'})."
    )


@app.post("/export/pdf")
@app.post("/export/pdf/")
async def export_pdf(request: ExportRequest, current_user: CurrentUser = Depends(get_current_user)):
    payload = export_payload(request)
    output = io.BytesIO()
    title = request.title or request.filename or "Jeff Export"
    document = SimpleDocTemplate(output, pagesize=letter, title=title)
    document.build(pdf_elements(payload, title))
    output.seek(0)

    filename = safe_filename(request.filename, "pdf")
    return StreamingResponse(
        output,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/export/campaign")
@app.get("/export/campaign/")
async def export_campaign_get():
    raise HTTPException(
        status_code=405,
        detail="Method Not Allowed. The /export/campaign endpoint requires a POST request with a JSON payload (e.g., {'payload': ..., 'filename': '...'})."
    )


@app.post("/export/campaign")
@app.post("/export/campaign/")
async def export_campaign(request: ExportRequest, current_user: CurrentUser = Depends(get_current_user)):
    payload = validate_campaign_registration(parse_campaign_json(export_payload(request)))
    output = io.BytesIO(json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8"))
    filename = safe_filename(request.filename or "campaign", "json")
    return StreamingResponse(
        output,
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/clear")
@app.post("/clear/")
async def clear_session(request: Request, current_user: CurrentUser = Depends(get_current_user)):
    data = await request.json()
    user_id = current_user.user_id or data.get("user_id")
    mode = data.get("mode")

    async with AsyncSessionLocal() as db:
        await db.execute(
            delete(ChatSession).where(
                ChatSession.user_id == user_id,
                ChatSession.mode == mode,
            )
        )
        await db.commit()

    return {
        "status": "cleared",
        "user_id": user_id,
        "mode": mode,
    }

@app.get("/history/{session_id}")
@app.get("/history/{session_id}/")
async def get_history(session_id: str, current_user: CurrentUser = Depends(get_current_user)):
    """Return the conversation history for a session."""
    async with AsyncSessionLocal() as db:
        chat_history = await get_history_by_session_id(db, session_id, current_user.user_id or None)
    messages = []

    for msg in chat_history:
        if msg.role == "user":
            messages.append({"role": "user", "content": msg.content})
        elif msg.role == "assistant":
            messages.append({"role": "assistant", "content": msg.content})

    return {
        "session_id": session_id,
        "message_count": len(messages),
        "messages": messages,
    }

@app.get("/quota")
@app.get("/quota/")
async def get_quota(current_user: CurrentUser = Depends(get_current_user), user_id: str | None = None):
    quota_key = current_user.user_id or user_id

    if not quota_key:
        raise HTTPException(
            status_code=400,
            detail="Missing user_id."
        )

    async with AsyncSessionLocal() as db:
        headers = await quota_headers(db, "", quota_key)

    return {
        "limit": int(headers["X-Tokens-Limit"]),
        "remaining": int(headers["X-Tokens-Remaining"]),
        "reset": int(headers["X-Tokens-Reset"])
    }

@app.get("/health")
@app.get("/health/")
async def health_check():
    sidecar_ready = await _sidecar_is_ready()
    return {"status": "ok", "service": "Jeff AI Agent", "sidecar": "ok" if sidecar_ready else "unavailable"}


@app.get("/")
async def serve_frontend():
    ui_path = os.path.join(BASE_DIR, "jeff-ui.html")
    if os.path.exists(ui_path):
        return FileResponse(ui_path)
    return {"message": "Jeff AI Agent API is running."}
