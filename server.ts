import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import { AgentInputItem, Runner, withTrace } from '@openai/agents';
import { guardrailsConfig, runAndApplyGuardrails, jeff, informer, JEFF_MAX_OUTPUT_TOKENS } from './agent';

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
  return {
    requests: usage?.requests ?? 0,
    inputTokens,
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

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'jeff-node-sidecar' });
});

app.post('/chat', async (req, res) => {
  const { messages, mode } = req.body;
  let usageAvailable = false;
  let activeModel = 'unresolved';

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }
  if (!mode || !modeLabels[mode]) {
    return res.status(422).json({ error: `invalid mode: ${mode}` });
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
