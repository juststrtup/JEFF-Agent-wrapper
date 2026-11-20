# Nov 20 — 20-conversation Luna score review

## Dataset and method

- 20 synthetic, one-turn chats across four fictional startup profiles and all six modes; the same IndicForge test ID has two General turns.
- Four offline GPT-6 Luna calls at low reasoning effort scored five cumulative founder-only snapshots each. Jeff replies were excluded. Slot and vision percentages use the repository’s fixed weighted formula helpers.
- These are offline evaluation results, not live `/chat` scoring. No results were written to production understanding state.
- The founder scenarios and metrics are synthetic test inputs, not claims about Sarvam, Cloudflare, or actual startups. No Twitter/Reddit trend search was used.

## Cumulative scores

| Profile | Startup understood, turns 1 → 5 | Vision, turns 1 → 5 | Thinnest at turn 5 | Review |
|---|---|---|---|---|
| indicforge | 28.2% → 46.4% → 60.8% → 82.2% → 93.0% | 6.2% → 31.2% → 31.2% → 50.0% → 50.0% | moat | Scores rise with prototype usage, quantified serving costs, and two paid pilots. Moat remains thinnest; vision reaches first revenue but not repeatable GTM. |
| bharatcompute | 18.3% → 33.1% → 59.0% → 73.0% → 85.0% | 0.0% → 0.0% → 0.0% → 25.0% → 31.2% | moat | A paid reservation and benchmark move vision after turn 4. Moat remains the key gap; the founder’s utilization-based break-even claim needs reconciliation with fixed reserved-capacity revenue. |
| codeyatra | 32.9% → 68.2% → 73.0% → 80.7% → 90.3% | 0.0% → 25.0% → 25.0% → 31.2% → 31.2% | moat | Alpha usage, workflow tests, and pricing add evidence. Eleven waitlist teams and unsigned pilots do not establish revenue; moat remains the thinnest slot. |
| mrignet | 28.6% → 41.9% → 48.2% → 60.2% → 67.0% | 0.0% → 0.0% → 0.0% → 0.0% → 0.0% | business_model | Benchmark and customer evaluation details improve understanding, but the scorer leaves vision stages unticked. Business model/pricing and evidence of paying demand remain gaps. |

Luna usage across four requests: **8,750 input**, **0 cached input**, and **6,273 output** tokens (15,023 total).

## What this review shows

The weighted startup-understood score rises as founders provide concrete evidence. Vision moves more slowly and only when the evidence supports a stage. This is a directional review of one authored corpus, not scorer stability evidence. It does not test contradictory or retracted claims, repeated-score variance, async non-blocking behavior, or persistence through the planned endpoint.

Full prompts, replies, per-turn slot/stage scores, and evidence summaries are in [20-conversations.json](20-conversations.json).
