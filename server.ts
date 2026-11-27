import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import { z } from 'zod';
import { AgentInputItem, Runner, withTrace } from '@openai/agents';
import { guardrailsConfig, runAndApplyGuardrails, jeff, informer, startupScorer, startupScoreSchema, JEFF_MAX_OUTPUT_TOKENS } from './agent';
import { cacheUsageBreakdown, sumUsageDetail } from './usageMetrics';

dotenv.config();
dotenv.config({ path: '../.env', override: false });

const app = express();
const port = Number(process.env.SIDECAR_PORT || 3000);

app.use(cors());
app.use(express.json({ limit: '1mb' }));

type StreamEvent =
  | { type: 'token'; text: string }
  | { type: 'usage'; usage: Record<string, unknown> }
  | { type: 'error'; message: string };

const modeLabels: Record<string, string> = {
  general: 'General',
  investor: 'Investor',
  business_model: 'Business Model',
  customer: 'Customer',
  campaign_builder: 'Campaign Builder',
  financial: 'Financial',
};

function writeEvent(res: express.Response, event: StreamEvent) {
  res.write(`${JSON.stringify(event)}\n`);
}

function getMessageText(message: AgentInputItem | undefined): string {
  const content = (message as any)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'input_text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function applyModeContext(messages: AgentInputItem[], mode: string) {
  if (mode === 'general') return;
  const lastMessage = messages[messages.length - 1] as any;
  const modeLabel = modeLabels[mode] || mode;
  const campaignNote =
    mode === 'campaign_builder'
      ? 'The UI is sending Campaign Builder mode for campaign brief, launch messaging, channel plan, and content-outline help. Raj owns the platform-level agent instructions for this mode.'
      : '';

  if (!lastMessage || !Array.isArray(lastMessage.content)) return;
  const textPart = lastMessage.content.find((part: any) => part?.type === 'input_text' && typeof part.text === 'string');
  if (!textPart) return;

  textPart.text = [
    `[Mode Context: ${modeLabel}]`,
    campaignNote,
    `User Message: ${textPart.text}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function usageToWireValue(usage: any, rawResponses: any[], outputCapHit: boolean) {
  const inputTokens = usage?.inputTokens ?? usage?.input_tokens ?? 0;
  const outputTokens = usage?.outputTokens ?? usage?.output_tokens ?? 0;
  const rawTotalTokens = rawResponses.reduce((total, response) => {
    const tokens = response?.rawUsage?.total_tokens;
    return total + (Number.isSafeInteger(tokens) && tokens > 0 ? tokens : 0);
  }, 0);
  const totalTokens = Math.max(
    usage?.totalTokens ?? usage?.total_tokens ?? 0,
    inputTokens + outputTokens,
    rawTotalTokens,
  );
  const inputDetails = usage?.inputTokensDetails;
  const cacheUsage = cacheUsageBreakdown(inputTokens, inputDetails);
  return {
    requests: usage?.requests ?? 0,
    inputTokens,
    cachedInputTokens: cacheUsage.cachedInputTokens,
    cacheWriteTokens: cacheUsage.cacheWriteTokens,
    cacheUsageBreakdownInvalid: cacheUsage.invalid,
    outputTokens,
    totalTokens,
    usageAvailable: totalTokens > 0,
    outputCapHit,
  };
}

function responseHitOutputLimit(response: any, outputLimit: number): boolean {
  const providerResponse = response?.providerData;
  if (
    (providerResponse?.status === 'incomplete' &&
      providerResponse?.incomplete_details?.reason === 'max_output_tokens') ||
    providerResponse?.choices?.some((choice: any) => choice?.finish_reason === 'length') === true
  ) return true;

  const outputTokens = response?.usage?.outputTokens ?? response?.usage?.output_tokens;
  return Number.isFinite(outputTokens) && outputTokens >= outputLimit;
}

const startupScoreRequestSchema = z.object({
  correlationId: z.string().min(1).max(200),
  mode: z.enum(['general', 'investor', 'customer', 'business_model', 'campaign_builder', 'financial']),
  sessionId: z.string().min(1).max(200),
  firstMessageId: z.number().int().positive(),
  lastMessageId: z.number().int().positive(),
  founderMessages: z.array(z.string().min(1).max(12000)).length(3),
  priorScores: startupScoreSchema.shape.scores,
  priorStages: startupScoreSchema.shape.stages,
});

function usageTokenCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function scorerCostUsd(usage: Record<string, any>) {
  const rates = {
    input: Number(process.env.JEFF_SCORER_INPUT_USD_PER_MILLION),
    cached: Number(process.env.JEFF_SCORER_CACHED_INPUT_USD_PER_MILLION),
    cacheWrite: Number(process.env.JEFF_SCORER_CACHE_WRITE_USD_PER_MILLION),
    output: Number(process.env.JEFF_SCORER_OUTPUT_USD_PER_MILLION),
  };
  if (
    Object.values(rates).some((rate) => !Number.isFinite(rate) || rate < 0) ||
    usage.inputTokens === null || usage.outputTokens === null ||
    usage.cachedInputTokens === null || usage.cacheWriteTokens === null ||
    usage.cachedInputTokens + usage.cacheWriteTokens > usage.inputTokens
  ) return null;

  const uncachedInputTokens = Math.max(0, usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteTokens);
  return (
    uncachedInputTokens * rates.input +
    usage.cachedInputTokens * rates.cached +
    usage.cacheWriteTokens * rates.cacheWrite +
    usage.outputTokens * rates.output
  ) / 1_000_000;
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'jeff-node-sidecar' });
});

app.post('/score', async (req, res) => {
  if (!startupScorer) {
    return res.status(503).json({ error: 'Startup scorer model or system prompt is not configured.' });
  }
  const parsedRequest = startupScoreRequestSchema.safeParse(req.body);
  if (!parsedRequest.success) return res.status(422).json({ error: 'Invalid startup scoring request.' });

  const request = parsedRequest.data;
  try {
    const runner = new Runner();
    const result = await runner.run(startupScorer, [{
      role: 'user',
      content: [{ type: 'input_text', text: JSON.stringify({
        priorScores: request.priorScores,
        priorStages: request.priorStages,
        founderMessages: request.founderMessages,
      }) }],
    }]);
    const output = startupScoreSchema.parse(result.finalOutput);
    const sdkUsage = result.state.usage as any;
    const inputDetails = sdkUsage?.inputTokensDetails;
    const outputDetails = sdkUsage?.outputTokensDetails;
    const inputTokens = usageTokenCount(sdkUsage?.inputTokens);
    const cacheUsage = cacheUsageBreakdown(inputTokens, inputDetails);
    const usage = {
      requests: sdkUsage?.requests ?? 0,
      inputTokens,
      cachedInputTokens: cacheUsage.cachedInputTokens,
      cacheWriteTokens: cacheUsage.cacheWriteTokens,
      cacheUsageBreakdownInvalid: cacheUsage.invalid,
      outputTokens: usageTokenCount(sdkUsage?.outputTokens),
      reasoningTokens: sumUsageDetail(outputDetails, ['reasoning_tokens', 'reasoningTokens']),
    };
    const providerCostUsd = scorerCostUsd(usage);
    const responseUsage = { ...usage, providerCostUsd };
    if (usage.inputTokens === null || usage.outputTokens === null) {
      console.warn(JSON.stringify({
        event: 'startup_scorer_usage_missing',
        model: process.env.JEFF_SCORER_MODEL,
        correlationId: request.correlationId,
        mode: request.mode,
        firstMessageId: request.firstMessageId,
        lastMessageId: request.lastMessageId,
      }));
    }
    if (cacheUsage.invalid) {
      console.warn(JSON.stringify({
        event: 'startup_scorer_cache_usage_invalid',
        model: process.env.JEFF_SCORER_MODEL,
        correlationId: request.correlationId,
        inputTokens: usage.inputTokens,
      }));
    }

    console.info(JSON.stringify({
      event: 'startup_scorer_completed',
      model: process.env.JEFF_SCORER_MODEL,
      effort: process.env.JEFF_SCORER_REASONING_EFFORT || 'low',
      correlationId: request.correlationId,
      mode: request.mode,
      firstMessageId: request.firstMessageId,
      lastMessageId: request.lastMessageId,
      ...responseUsage,
    }));
    return res.json({ ...output, usage: responseUsage });
  } catch (error: any) {
    console.error(JSON.stringify({
      event: 'startup_scorer_failed',
      model: process.env.JEFF_SCORER_MODEL,
      correlationId: request.correlationId,
      mode: request.mode,
      firstMessageId: request.firstMessageId,
      lastMessageId: request.lastMessageId,
      error: error?.message || String(error),
    }));
    return res.status(502).json({ error: 'Startup scoring failed.' });
  }
});

app.post('/chat', async (req, res) => {
  const { messages, mode, startupContext } = req.body;
  let usageAvailable = false;
  let activeModel = 'unresolved';

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }
  if (!mode || !modeLabels[mode]) {
    return res.status(422).json({ error: `invalid mode: ${mode}` });
  }
  if (startupContext !== undefined && (typeof startupContext !== 'string' || startupContext.length > 2000)) {
    return res.status(422).json({ error: 'invalid startup context' });
  }

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');

  try {
    await withTrace('Jeff Flagship Suite', async () => {
      const runner = new Runner({
        traceMetadata: {
          __trace_source__: 'agent-builder',
          workflow_id: process.env.JEFF_WORKFLOW_ID || '',
        },
      });

      const conversation = messages as AgentInputItem[];
      const latestUserText = getMessageText(conversation[conversation.length - 1]);
      const workflow = { input_as_text: latestUserText };

      const { hasTripwire } = await runAndApplyGuardrails(
        latestUserText,
        guardrailsConfig,
        conversation,
        workflow,
      );

      const activeAgent = hasTripwire ? informer : jeff;
      activeModel = hasTripwire
        ? process.env.INFORMER_AGENT_MODEL || 'unconfigured'
        : process.env.JEFF_AGENT_MODEL || 'unconfigured';
      if (!hasTripwire && mode !== 'general') {
        applyModeContext(conversation, mode);
      }
      if (!hasTripwire && typeof startupContext === 'string' && startupContext.trim()) {
        const latest = conversation[conversation.length - 1] as any;
        const textPart = Array.isArray(latest?.content)
          ? latest.content.find((part: any) => part?.type === 'input_text' && typeof part.text === 'string')
          : null;
        if (textPart) textPart.text = `${startupContext.trim()}\n\n${textPart.text}`;
      }

      const streamedRun = await runner.run(activeAgent, conversation, { stream: true });
      const textStream = streamedRun.toTextStream({ compatibleWithNodeStreams: true });

      for await (const chunk of textStream) {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        if (text) writeEvent(res, { type: 'token', text });
      }

      await streamedRun.completed;
      const outputCapHit = activeAgent === jeff && streamedRun.rawResponses.some(
        (response: any) => responseHitOutputLimit(response, JEFF_MAX_OUTPUT_TOKENS),
      );
      const usage = usageToWireValue(streamedRun.state.usage, streamedRun.rawResponses, outputCapHit);
      usageAvailable = usage.usageAvailable;
      if (activeAgent === jeff) {
        console.info(JSON.stringify({
          event: 'jeff_response_completed',
          model: process.env.JEFF_AGENT_MODEL || 'unconfigured',
          mode,
          inputTokens: usage.inputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          cacheUsageBreakdownInvalid: usage.cacheUsageBreakdownInvalid,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          outputCapTokens: JEFF_MAX_OUTPUT_TOKENS,
          outputCapHit,
        }));
      }
      writeEvent(res, { type: 'usage', usage });
    });
  } catch (err: any) {
    const message = err?.message || String(err);
    console.error('Error in /chat:', err);
    if (!res.headersSent) {
      return res.status(500).json({ error: message });
    }
    writeEvent(res, { type: 'error', message });
  } finally {
    if (!usageAvailable) {
      console.warn(JSON.stringify({ event: 'agent_response_usage_missing', model: activeModel, mode }));
    }
    res.end();
  }
});

app.listen(port, '127.0.0.1', () => {
  console.log(`Node Agent Sidecar running on 127.0.0.1:${port}`);
});
