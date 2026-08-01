import { webSearchTool, codeInterpreterTool, imageGenerationTool, Agent, AgentInputItem, Runner, withTrace } from "@openai/agents";
import { OpenAI } from "openai";
import { runGuardrails } from "@openai/guardrails";
import dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: "../.env", override: false });

const rawOpenAiKey = process.env.OPENAI_API_KEY?.trim();
if (rawOpenAiKey) {
  const duplicatedKeyStart = rawOpenAiKey.indexOf("sk-", 3);
  process.env.OPENAI_API_KEY = duplicatedKeyStart > 0
    ? rawOpenAiKey.slice(0, duplicatedKeyStart)
    : rawOpenAiKey;
}

// Tool definitions
const webSearchPreview = webSearchTool({
  searchContextSize: "medium",
  userLocation: {
    type: "approximate"
  }
})
const codeInterpreter = codeInterpreterTool({
  container: {
    type: "auto",
    file_ids: []
  }
})
const imageGeneration = imageGenerationTool({
  background: "auto",
  model: "gpt-image-1",
  moderation: "auto",
  outputFormat: "png",
  partialImages: 0,
  quality: "auto",
  size: "auto"
})

// Shared client for guardrails and file search
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Guardrails definitions
export const guardrailsConfig = {
  guardrails: [
    { name: "Jailbreak", config: { model: "gpt-4.1-mini", confidence_threshold: 0.7 } },
    { name: "NSFW Text", config: { model: "gpt-4.1-mini", confidence_threshold: 0.7 } },
    { name: "Contains PII", config: { block: false, detect_encoded_pii: true, entities: ["CREDIT_CARD", "IBAN_CODE", "IN_AADHAAR", "IN_PAN", "IN_PASSPORT", "IN_VEHICLE_REGISTRATION", "IN_VOTER", "IP_ADDRESS", "PHONE_NUMBER", "US_BANK_NUMBER", "US_PASSPORT", "US_SSN"] } },
    { name: "Custom Prompt Check", config: { system_prompt_details: "[REDACTED]", model: "gpt-4.1-mini", confidence_threshold: 0.7 } },
    { name: "Moderation", config: { categories: ["sexual", "sexual/minors", "hate", "hate/threatening", "harassment/threatening", "self-harm/instructions", "violence/graphic", "illicit/violent"] } }
  ]
};
export const context = { guardrailLlm: client };

function guardrailsHasTripwire(results: any[]): boolean {
    return (results ?? []).some((r) => r?.tripwireTriggered === true);
}

function getGuardrailSafeText(results: any[], fallbackText: string): string {
    for (const r of results ?? []) {
        if (r?.info && ("checked_text" in r.info)) {
            return r.info.checked_text ?? fallbackText;
        }
    }
    const pii = (results ?? []).find((r) => r?.info && "anonymized_text" in r.info);
    return pii?.info?.anonymized_text ?? fallbackText;
}

async function scrubConversationHistory(history: any[], piiOnly: any): Promise<void> {
    for (const msg of history ?? []) {
        const content = Array.isArray(msg?.content) ? msg.content : [];
        for (const part of content) {
            if (part && typeof part === "object" && part.type === "input_text" && typeof part.text === "string") {
                const res = await runGuardrails(part.text, piiOnly, context, true);
                part.text = getGuardrailSafeText(res, part.text);
            }
        }
    }
}

async function scrubWorkflowInput(workflow: any, inputKey: string, piiOnly: any): Promise<void> {
    if (!workflow || typeof workflow !== "object") return;
    const value = workflow?.[inputKey];
    if (typeof value !== "string") return;
    const res = await runGuardrails(value, piiOnly, context, true);
    workflow[inputKey] = getGuardrailSafeText(res, value);
}

export async function runAndApplyGuardrails(inputText: string, config: any, history: any[], workflow: any) {
    const guardrails = Array.isArray(config?.guardrails) ? config.guardrails : [];
    const results = await runGuardrails(inputText, config, context, true);
    const shouldMaskPII = guardrails.find((g) => (g?.name === "Contains PII") && g?.config && g.config.block === false);
    if (shouldMaskPII) {
        const piiOnly = { guardrails: [shouldMaskPII] };
        await scrubConversationHistory(history, piiOnly);
        await scrubWorkflowInput(workflow, "input_as_text", piiOnly);
        await scrubWorkflowInput(workflow, "input_text", piiOnly);
    }
    const hasTripwire = guardrailsHasTripwire(results);
    const safeText = getGuardrailSafeText(results, inputText) ?? inputText;
    return { results, hasTripwire, safeText, failOutput: buildGuardrailFailOutput(results ?? []), passOutput: { safe_text: safeText } };
}

function buildGuardrailFailOutput(results: any[]) {
    const get = (name: string) => (results ?? []).find((r: any) => ((r?.info?.guardrail_name ?? r?.info?.guardrailName) === name));
    const pii = get("Contains PII"), mod = get("Moderation"), jb = get("Jailbreak"), hal = get("Hallucination Detection"), nsfw = get("NSFW Text"), url = get("URL Filter"), custom = get("Custom Prompt Check"), pid = get("Prompt Injection Detection"), piiCounts = Object.entries(pii?.info?.detected_entities ?? {}).filter(([, v]) => Array.isArray(v)).map(([k, v]) => k + ":" + (v as any[]).length), conf = jb?.info?.confidence;
    return {
        pii: { failed: (piiCounts.length > 0) || pii?.tripwireTriggered === true, detected_counts: piiCounts },
        moderation: { failed: mod?.tripwireTriggered === true || ((mod?.info?.flagged_categories ?? []).length > 0), flagged_categories: mod?.info?.flagged_categories },
        jailbreak: { failed: jb?.tripwireTriggered === true },
        hallucination: { failed: hal?.tripwireTriggered === true, reasoning: hal?.info?.reasoning, hallucination_type: hal?.info?.hallucination_type, hallucinated_statements: hal?.info?.hallucinated_statements, verified_statements: hal?.info?.verified_statements },
        nsfw: { failed: nsfw?.tripwireTriggered === true },
        url_filter: { failed: url?.tripwireTriggered === true },
        custom_prompt_check: { failed: custom?.tripwireTriggered === true },
        prompt_injection: { failed: pid?.tripwireTriggered === true },
    };
}

// ─────────────────────────────────────────────
// AGENT DEFINITIONS
// System prompts are redacted for IP protection.
// Riswan: build the FastAPI wrapper around the
// runWorkflow() function below. Do not modify
// the agent definitions — they are configured
// separately by Raj on the OpenAI platform.
// ─────────────────────────────────────────────

export const jeff = new Agent({
  name: "Jeff",
  instructions: "[process.env.JEFF_SYSTEM_PROMPT]",
  model: process.env.JEFF_AGENT_MODEL || "gpt-3.5-turbo",
  tools: [
    webSearchPreview,
    codeInterpreter
  ],
  modelSettings: {
    store: true
  }
});

export const informer = new Agent({
  name: "Informer",
  instructions: "[process.env.INFORMER_SYSTEM_PROMPT]",
  model: process.env.INFORMER_AGENT_MODEL || "gpt-3.5-turbo",
  
  modelSettings: {
    temperature: 1,
    topP: 1,
    maxTokens: 2048,
    store: true
  }
});

type WorkflowInput = { input_as_text: string };


// ─────────────────────────────────────────────
// MAIN WORKFLOW
// Input:  { input_as_text: string }
// Output: { output_text: string }
//
// Flow:
//   User message
//     → Guardrails check
//       ├── PASS → Jeff Agent → output_text
//       └── FAIL → Informer Agent → output_text
//
// Your FastAPI /chat endpoint should:
//   1. Accept { message, mode } from WordPress
//   2. Map it to { input_as_text: message }
//   3. Call runWorkflow()
//   4. Stream output_text back to WordPress
// ─────────────────────────────────────────────

export const runWorkflow = async (workflow: WorkflowInput) => {
  return await withTrace("Jeff Flagship Suite", async () => {
    const state = {
      request_category: null
    };
    const conversationHistory: AgentInputItem[] = [
      { role: "user", content: [{ type: "input_text", text: workflow.input_as_text }] }
    ];
    const runner = new Runner({
      traceMetadata: {
        __trace_source__: "agent-builder",
        workflow_id: process.env.JEFF_WORKFLOW_ID
      }
    });
    const guardrailsInputText = workflow.input_as_text;
    const { hasTripwire: guardrailsHasTripwire, safeText: guardrailsAnonymizedText, failOutput: guardrailsFailOutput, passOutput: guardrailsPassOutput } = await runAndApplyGuardrails(guardrailsInputText, guardrailsConfig, conversationHistory, workflow);
    const guardrailsOutput = (guardrailsHasTripwire ? guardrailsFailOutput : guardrailsPassOutput);
    if (guardrailsHasTripwire) {
      const informerResultTemp = await runner.run(
        informer,
        [
          ...conversationHistory
        ]
      );
      conversationHistory.push(...informerResultTemp.newItems.map((item) => item.rawItem));

      if (!informerResultTemp.finalOutput) {
          throw new Error("Agent result is undefined");
      }

      const informerResult = {
        output_text: informerResultTemp.finalOutput ?? ""
      };
      return informerResult;
    } else {
      const jeffResultTemp = await runner.run(
        jeff,
        [
          ...conversationHistory
        ]
      );
      conversationHistory.push(...jeffResultTemp.newItems.map((item) => item.rawItem));

      if (!jeffResultTemp.finalOutput) {
          throw new Error("Agent result is undefined");
      }

      const jeffResult = {
        output_text: jeffResultTemp.finalOutput ?? ""
      };
      return jeffResult;
    }
  });
}
