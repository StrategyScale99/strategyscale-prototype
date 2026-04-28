import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import "dotenv/config";

import getInstantViewPrompt from "./prompts/instantView.js";
import getThinkingFramePrompt from "./prompts/thinkingFrame.js";
import getPressureTestPrompt from "./prompts/pressureTest.js";
import getFinalPrompt from "./prompts/final.js";

// __dirname doesn't exist in ES modules — derive it from import.meta.url.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "1mb" }));

// Explicit handler for / so the index.html path is unambiguous (especially
// behind Vercel's catch-all routing). Mirrors the no-store cache header
// applied to the rest of /public/* below.
app.get("/", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Disable caching during prototype iteration so refactored client code
// can't be served by a stale browser tab against a refactored server.
app.use(express.static("public", {
  setHeaders: (res) => res.setHeader("Cache-Control", "no-store"),
}));

const client = new Anthropic();
const MODEL = "claude-opus-4-7";

const MAX_BATCHES = 3;

const DECISION_MODES = [
  "market_entry",
  "pricing_strategy",
  "product_market_fit",
  "growth_constraint",
  "hiring_team",
  "fundraising_capital_allocation",
  "exit_succession",
  "other",
];

// System prompts live in /prompts. The shared voice/discipline rules live in
// prompts/shared.js and are imported by each prompt module.

// ─────────────────────────────────────────────────────────────────────────────
// STAGE 1 · Instant View
// ─────────────────────────────────────────────────────────────────────────────

const INSTANT_SCHEMA = {
  type: "object",
  properties: {
    provisional_position: {
      type: "string",
      description:
        "Your provisional call, stated in the first 8 words. Then 1-2 sentences of justification. Maximum 3 sentences. Open with a directive verb (Do it. Don't do it. Wait. Buy. Walk away.) — not 'It looks like' or 'My initial sense'.",
    },
    dominant_constraint: {
      type: "string",
      description:
        "The single thing that decides this. Maximum 3 sentences. Lead with the constraint itself; do not preface. Name it specifically — capital, runway, customer concentration, regulatory window, talent depth, board appetite.",
    },
    assumption_to_test: {
      type: "string",
      description:
        "The assumption they are almost certainly making that may be wrong. Address them in the second person. Format: 'You are assuming [X]. Test it before you commit, because [Y].' Maximum 3 sentences.",
    },
    immediate_next_move: {
      type: "string",
      description:
        "One specific thing they can do in the next 7 days that gets them to a better decision faster — a call to make, a number to pull, a question to put to a specific person, a small bet to run. Maximum 3 sentences. Time-bound and concrete.",
    },
    detected_mode: {
      type: "string",
      enum: DECISION_MODES,
      description:
        "The decision category this actually is. Confirm the user's selection or override based on the actual brief. Use 'other' only if it genuinely doesn't fit any of the seven specific modes.",
    },
  },
  required: [
    "provisional_position",
    "dominant_constraint",
    "assumption_to_test",
    "immediate_next_move",
    "detected_mode",
  ],
  additionalProperties: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// STAGES 2 & 3 (start) · Thinking Frame + Batch 1 of pressure test
// ─────────────────────────────────────────────────────────────────────────────

const DIAGNOSTIC_START_SCHEMA = {
  type: "object",
  properties: {
    problem_type: {
      type: "string",
      description:
        "Plain-English label for what kind of decision this actually is — sharper than the user's framing where needed. Maximum 2 sentences.",
    },
    framework_selected: {
      type: "string",
      description:
        "The specific lens you are applying. Named, specific to the decision. NOT a generic MBA framework like SWOT or Porter's Five Forces. One sentence.",
    },
    why_framework_fits: {
      type: "string",
      description:
        "Why this lens is the right one for this specific decision. Reference the brief. Maximum 2 sentences.",
    },
    key_tension: {
      type: "string",
      description:
        "The single tension this decision turns on. Two opposing forces. Name both. Maximum 2 sentences.",
    },
    critical_unknown: {
      type: "string",
      description:
        "The one piece of information that, if known, would most move the recommendation. Specific, not 'more market data'. Maximum 2 sentences.",
    },
    why_these_questions_matter: {
      type: "string",
      description:
        "Why answering the specific questions you are about to ask will move the recommendation. Not generic. Maximum 2 sentences.",
    },
    pressure_test_questions: {
      type: "array",
      description:
        "The OPENING batch — three to five questions, never more than five. Each tied to a specific decision lever, tailored to this decision.",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description:
              "The question itself. One sentence. Force a number, name, or date where possible. Do not stack with 'and'.",
          },
          decision_lever: {
            type: "string",
            description:
              "The specific lever this question informs. 1-4 words. Examples: 'pricing floor', 'CAC payback', 'CTO bandwidth', 'renewal risk', 'integration cost'.",
          },
        },
        required: ["question", "decision_lever"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "problem_type",
    "framework_selected",
    "why_framework_fits",
    "key_tension",
    "critical_unknown",
    "why_these_questions_matter",
    "pressure_test_questions",
  ],
  additionalProperties: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// STAGE 4 (iterate) · Update + decision to continue or finalise
// ─────────────────────────────────────────────────────────────────────────────

const DIAGNOSTIC_ITERATE_SCHEMA = {
  type: "object",
  properties: {
    what_we_now_know: {
      type: "string",
      description:
        "What this batch's answers (combined with what was already known) clarified. Lead with the headline finding. Maximum 3 sentences.",
    },
    still_uncertain: {
      type: "string",
      description:
        "The single biggest unknown that still blocks a confident final call. Be specific — name the data point. Maximum 2 sentences. If nothing meaningful remains uncertain, state that plainly.",
    },
    framing_status: {
      type: "string",
      enum: ["unchanged", "narrowed", "pivoted"],
      description:
        "Whether the problem framing has changed based on these answers. 'pivoted' is the 'we are solving the wrong problem' signal — use it when warranted, do not avoid it.",
    },
    framing_change_explanation: {
      type: "string",
      description:
        "If framing_status is 'narrowed' or 'pivoted', explain what changed and why. If 'unchanged', state briefly why the framing still holds. Maximum 2 sentences.",
    },
    decision: {
      type: "string",
      enum: ["continue", "finalise"],
      description:
        "Whether to ask another batch or proceed to the final recommendation. On iteration 3 (the user message will tell you), this MUST be 'finalise'.",
    },
    reason: {
      type: "string",
      description:
        "One-line justification for the continue/finalise decision. Specific. Not 'we have enough now' — say what specifically tipped it. Maximum 2 sentences.",
    },
    next_questions: {
      type: "array",
      description:
        "If decision = 'continue', the next batch (3-4 questions, max 5, sharper and narrower than the last). If decision = 'finalise', empty array.",
      minItems: 0,
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          decision_lever: { type: "string" },
        },
        required: ["question", "decision_lever"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "what_we_now_know",
    "still_uncertain",
    "framing_status",
    "framing_change_explanation",
    "decision",
    "reason",
    "next_questions",
  ],
  additionalProperties: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// STAGE 5 · Final Recommendation + Memory Summary
// ─────────────────────────────────────────────────────────────────────────────

const FINAL_SCHEMA = {
  type: "object",
  properties: {
    the_call: {
      type: "string",
      description:
        "The dominant section of the response. The FIRST SENTENCE is no more than 25 words and stands on its own as a boardroom recommendation. It must open with a directive form: Proceed, Do not proceed, Proceed only if, Pause and test, Counter with, Reframe the decision, Sign, Do not sign, Walk, Hold, Kill. It must NOT open with 'Consider', 'It depends', 'You may want to', 'We recommend', 'Explore'. Where the call has linked parts, follow the first sentence with three labelled blocks separated by blank lines, using these EXACT labels in upper case on their own line: 'CORE CALL:' then the core decision; 'ONLY PROCEED IF:' then the conditions; 'COUNTER WITH:' then the immediate counter-move. The renderer keys on these exact strings — no variants. Use the labelled structure only when there are genuinely linked decisions. Maximum 5 lines total. No long paragraphs.",
    },
    why_this_is_true: {
      type: "array",
      description:
        "1-3 bullets, never more than 3. Each bullet is one sentence. Each bullet must connect directly to specific evidence from the chief executive's answers in the diagnostic — quote a number, name a stated fact, or reference a concrete answer.",
      minItems: 1,
      items: { type: "string" },
    },
    what_this_breaks: {
      type: "object",
      description:
        "Memorable, uncomfortable trade-off — not administrative consequences. The uncomfortable_tradeoff field MUST OPEN with the exact phrase 'This breaks the idea that…' as its very first sentence (not buried inside).",
      properties: {
        deprioritised: {
          type: "string",
          description:
            "What specific initiative, programme, hire, or product line gets deprioritised or delayed by this call. Name it specifically. Maximum 2 sentences.",
        },
        resistance: {
          type: "string",
          description:
            "Who internally will resist and why. Name the role (chief financial officer, chief technology officer, head of sales, the founders, the audit committee). Maximum 2 sentences.",
        },
        uncomfortable_tradeoff: {
          type: "string",
          description:
            "The specific uncomfortable or politically costly trade-off being accepted: firing a senior, killing a sacred-cow product, walking from a relationship, missing a quarter, eating a write-down. MUST OPEN with the exact phrase 'This breaks the idea that…' as the very first sentence of this field. After that opening sentence, name the specific painful trade-off concretely. Vague trade-offs are forbidden. Maximum 2 sentences total.",
        },
      },
      required: ["deprioritised", "resistance", "uncomfortable_tradeoff"],
      additionalProperties: false,
    },
    proof_test: {
      type: "object",
      description:
        "A single time-bound, falsifiable experiment that will validate or refute THE CALL. Prefer 'prove or kill' framing over premature terminal verdicts. Where the test depends on a counterparty accepting protection, use the broader vocabulary of hard economic protection (financial penalties, take-or-pay minimums, margin floor, tooling contribution, escrow, automatic loss of exclusivity, shorter exclusivity window, distributor-funded launch cost, payment discipline triggers); do not make one mechanism the only acceptable route if equivalent economic protections could achieve the same purpose.",
      properties: {
        what: {
          type: "string",
          description: "What is being tested. One sentence.",
        },
        deadline: {
          type: "string",
          description:
            "Time horizon: typically 7, 14, 30, 60, or 90 days. Pick the shortest that yields meaningful signal. State as 'within X days' or a calendar date.",
        },
        pass_threshold: {
          type: "string",
          description:
            "The specific numeric or named-event threshold that confirms the call. One sentence. Must be observable. Where economic protection is the test, name two or three equivalent acceptable mechanisms rather than only one.",
        },
        fail_threshold: {
          type: "string",
          description:
            "The specific numeric or named-event threshold that signals abandon-or-pivot. One sentence. Must be observable.",
        },
      },
      required: ["what", "deadline", "pass_threshold", "fail_threshold"],
      additionalProperties: false,
    },
    action_plan: {
      type: "object",
      description:
        "Short, owner-led, executable. Only actions that directly support THE CALL. Where actions must be cut, prioritise actions that change the decision over actions that merely support implementation.",
      properties: {
        first_7_days: {
          type: "string",
          description:
            "MAXIMUM 3 actions, written as a numbered list with a newline (\\n) between items in the format '1. [Owner] [verb] [object].'. Each action is one sentence. Each action starts with an accountable owner where possible (chief executive, chief financial officer, chief operating officer, commercial director, chief technology officer, head of sales, legal, the board). Do not combine multiple actions with 'and'.",
        },
        first_30_days: {
          type: "string",
          description:
            "MAXIMUM 3 actions, same numbered-list format and owner-led discipline as first_7_days. Builds on week one.",
        },
        first_60_to_90_days: {
          type: "string",
          description:
            "MAXIMUM 3 actions, same numbered-list format and owner-led discipline. By this window the chief executive should know whether this is working.",
        },
        deliberate_delay: {
          type: "string",
          description:
            "Exactly one thing the chief executive must NOT do yet, with the specific signal, threshold, or date that unlocks it. The discipline of waiting is part of the plan. Maximum 2 sentences.",
        },
      },
      required: ["first_7_days", "first_30_days", "first_60_to_90_days", "deliberate_delay"],
      additionalProperties: false,
    },
    watch_signals: {
      type: "object",
      description:
        "Three branches the chief executive monitors. Designed to be readable alongside THE CALL. Each column MAXIMUM 4 signals, written as a numbered list with newline (\\n) between items: '1. [signal].'. Every signal must be specific to this decision — name the metric, counterparty, threshold, deadline, or named event. Banned generic phrases: 'monitor performance', 'track key performance indicators', 'review progress', 'watch the market', 'keep an eye on', 'regular check-ins'.",
      properties: {
        continue_if: {
          type: "string",
          description:
            "Maximum 4 numbered, decision-specific signals confirming staying the course. Numeric thresholds, dates, named events.",
        },
        stop_or_pivot_if: {
          type: "string",
          description:
            "Maximum 4 numbered, decision-specific signals that abandon or redirect the call. Specific thresholds.",
        },
        reconsider_if: {
          type: "string",
          description:
            "Maximum 4 numbered, decision-specific signals that don't kill the call but should force re-examination of framing or proof test.",
        },
      },
      required: ["continue_if", "stop_or_pivot_if", "reconsider_if"],
      additionalProperties: false,
    },
    memory_for_next_time: {
      type: "object",
      description:
        "Compact retained context for the next StrategyScale session. Forward context, not a recap.",
      properties: {
        memory_summary: {
          type: "string",
          description:
            "The top-line synthesis a future StrategyScale session would actually want surfaced. MUST begin with the exact phrase 'Saved for next decision: '. Two to three sentences. State the underlying lesson plus the lens future expansion or capital decisions should be tested against. Worked example: 'Saved for next decision: Growth is attractive, but capacity and margin protection are the governing constraints. Future expansion decisions should be tested against customer exposure, effective capacity, and channel-control risk.'",
        },
        user_goal: {
          type: "string",
          description:
            "What the chief executive is ultimately trying to achieve. One sentence, in their own framing.",
        },
        key_constraint: {
          type: "string",
          description:
            "The single binding constraint that shaped this decision. One sentence.",
        },
        current_decision_gate: {
          type: "string",
          description:
            "The next decision moment that flows from this one. When and what triggers it. One sentence.",
        },
        evidence_gap: {
          type: "string",
          description:
            "What we still don't know that next time we'd want to start by asking. One sentence.",
        },
      },
      required: ["memory_summary", "user_goal", "key_constraint", "current_decision_gate", "evidence_gap"],
      additionalProperties: false,
    },
  },
  required: [
    "the_call",
    "why_this_is_true",
    "what_this_breaks",
    "proof_test",
    "action_plan",
    "watch_signals",
    "memory_for_next_time",
  ],
  additionalProperties: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function callClaude({ system, schema, messages, maxTokens = 2500 }) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    output_config: { format: { type: "json_schema", schema } },
    messages,
  });
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("Empty response from model");
  return JSON.parse(textBlock.text);
}

function sendApiError(res, err) {
  if (err instanceof Anthropic.APIError) {
    console.error(`Anthropic API error ${err.status}:`, err.message);
    return res.status(502).json({ error: `Model error: ${err.message}` });
  }
  console.error(err);
  res.status(500).json({ error: "Unexpected server error." });
}

function buildJourneyPreamble({ question, mode }) {
  const safeMode = DECISION_MODES.includes(mode) ? mode : "other";
  return `User-selected decision mode: ${safeMode}\n\nDecision brief:\n${question.trim()}`;
}

function formatBatchAnswers(batch) {
  return batch.questions
    .map((q, i) => {
      const a = (batch.answers?.[i] ?? "").trim();
      return `Q (lever: ${q.decision_lever}): ${q.question}\nA: ${a || "[no answer given — note this absence]"}`;
    })
    .join("\n\n");
}

// Reconstruct the full multi-turn diagnostic conversation from current state.
// Includes only batches with a non-null `update` (i.e., already iterated past).
// Trailing message is added by the caller.
function buildDiagnosticHistory({ question, mode, instantView, thinkingFrame, batches }) {
  const messages = [
    { role: "user", content: buildJourneyPreamble({ question, mode }) },
    { role: "assistant", content: JSON.stringify(instantView) },
    {
      role: "user",
      content:
        "The CEO has accepted the instant view as provisional and wants to go deeper. Produce the Thinking Frame and the FIRST batch of 3-5 pressure-test questions.",
    },
  ];

  if (!thinkingFrame || batches.length === 0) return messages;

  // The /api/diagnostic/start response was: thinkingFrame + batches[0].questions
  const firstResponse = {
    ...thinkingFrame,
    pressure_test_questions: batches[0].questions,
  };
  messages.push({ role: "assistant", content: JSON.stringify(firstResponse) });

  // For each completed batch (i.e., one with an `update`):
  // user submitted answers, assistant returned update + maybe next questions.
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    if (!batch.update) continue;

    messages.push({
      role: "user",
      content: `CEO's answers to batch ${i + 1}:\n\n${formatBatchAnswers(batch)}`,
    });
    const next = batches[i + 1];
    const iterateResponse = {
      ...batch.update,
      next_questions: next ? next.questions : [],
    };
    messages.push({ role: "assistant", content: JSON.stringify(iterateResponse) });
  }

  return messages;
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

app.post("/api/instant-view", async (req, res) => {
  const { question, mode } = req.body ?? {};
  if (typeof question !== "string" || question.trim().length < 10) {
    return res
      .status(400)
      .json({ error: "Please describe the decision in at least a sentence." });
  }
  try {
    const result = await callClaude({
      system: getInstantViewPrompt(),
      schema: INSTANT_SCHEMA,
      messages: [{ role: "user", content: buildJourneyPreamble({ question, mode }) }],
      maxTokens: 1500,
    });
    res.json(result);
  } catch (err) {
    sendApiError(res, err);
  }
});

app.post("/api/diagnostic/start", async (req, res) => {
  const { question, mode, instantView } = req.body ?? {};
  if (!question || !instantView) {
    return res.status(400).json({ error: "Missing question or instantView." });
  }
  try {
    const messages = [
      { role: "user", content: buildJourneyPreamble({ question, mode }) },
      { role: "assistant", content: JSON.stringify(instantView) },
      {
        role: "user",
        content:
          "The CEO has accepted the instant view as provisional and wants to go deeper. Produce the Thinking Frame and the FIRST batch of 3-5 pressure-test questions.",
      },
    ];
    const result = await callClaude({
      system: getThinkingFramePrompt({ maxBatches: MAX_BATCHES }),
      schema: DIAGNOSTIC_START_SCHEMA,
      messages,
      maxTokens: 2000,
    });
    res.json(result);
  } catch (err) {
    sendApiError(res, err);
  }
});

app.post("/api/diagnostic/iterate", async (req, res) => {
  const { question, mode, instantView, thinkingFrame, batches } = req.body ?? {};
  if (
    !question ||
    !instantView ||
    !thinkingFrame ||
    !Array.isArray(batches) ||
    batches.length === 0
  ) {
    return res.status(400).json({ error: "Missing required fields." });
  }
  const lastBatch = batches[batches.length - 1];
  if (!Array.isArray(lastBatch.answers)) {
    return res.status(400).json({ error: "Last batch must include answers." });
  }
  const iterationNumber = batches.length; // we are producing the update for batch N
  const isFinalIteration = iterationNumber >= MAX_BATCHES;

  try {
    // History includes only batches with completed updates — i.e., everything
    // before the current one. The current batch's answers go in the trailing message.
    const historyBatches = batches.slice(0, -1);
    const messages = buildDiagnosticHistory({
      question,
      mode,
      instantView,
      thinkingFrame,
      batches: [...historyBatches, ...batches.slice(0, 0)], // alias for clarity
    });

    const trailing =
      `CEO's answers to batch ${iterationNumber}:\n\n${formatBatchAnswers(lastBatch)}\n\n` +
      `This is iteration ${iterationNumber} of a maximum of ${MAX_BATCHES}. ` +
      (isFinalIteration
        ? `You have reached the maximum number of batches. Decision MUST be 'finalise'. Set next_questions to an empty array.`
        : `Now: produce the iteration update. Decide whether to continue with a sharper, narrower next batch (3-4 questions targeting the still-uncertain item) or to finalise.`);

    messages.push({ role: "user", content: trailing });

    const result = await callClaude({
      system: getPressureTestPrompt({ maxBatches: MAX_BATCHES }),
      schema: DIAGNOSTIC_ITERATE_SCHEMA,
      messages,
      maxTokens: 2000,
    });

    // Server-side enforcement: cap at MAX_BATCHES.
    if (isFinalIteration) {
      result.decision = "finalise";
      result.next_questions = [];
      if (!result.reason) result.reason = "Maximum batch count reached.";
    }
    if (result.decision === "finalise") {
      result.next_questions = [];
    }
    // Defensive: if model returned >5 questions in next batch, truncate.
    if (Array.isArray(result.next_questions) && result.next_questions.length > 5) {
      result.next_questions = result.next_questions.slice(0, 5);
    }

    res.json(result);
  } catch (err) {
    sendApiError(res, err);
  }
});

app.post("/api/final", async (req, res) => {
  const { question, mode, instantView, thinkingFrame, batches } = req.body ?? {};
  if (
    !question ||
    !instantView ||
    !thinkingFrame ||
    !Array.isArray(batches) ||
    batches.length === 0
  ) {
    return res.status(400).json({ error: "Missing required fields." });
  }

  const lastBatch = batches[batches.length - 1];
  // Two cases:
  // (a) Last batch already has an `update` with decision='finalise' → diagnostic
  //     ran to completion. History reconstructs everything; trailing just asks
  //     for the final.
  // (b) Last batch has answers but no update → user clicked Wrap up before
  //     iterating past it. Include its answers in trailing.
  let messages;
  let trailing;
  if (lastBatch.update) {
    messages = buildDiagnosticHistory({ question, mode, instantView, thinkingFrame, batches });
    trailing =
      "Now produce the final recommendation, including the memory summary. Reference specific evidence from across the diagnostic; do not produce a generic answer.";
  } else {
    const historyBatches = batches.slice(0, -1);
    messages = buildDiagnosticHistory({
      question,
      mode,
      instantView,
      thinkingFrame,
      batches: historyBatches,
    });
    trailing =
      `CEO's answers to batch ${batches.length}:\n\n${formatBatchAnswers(lastBatch)}\n\n` +
      "The CEO has called wrap-up before the iterate cycle completed. Produce the final recommendation now using everything learned across the diagnostic, including these final answers. Reference specific evidence; do not produce a generic answer.";
  }
  messages.push({ role: "user", content: trailing });

  try {
    const result = await callClaude({
      system: getFinalPrompt(),
      schema: FINAL_SCHEMA,
      messages,
      maxTokens: 3500,
    });
    res.json(result);
  } catch (err) {
    sendApiError(res, err);
  }
});

// Serverless platforms (Vercel) import `app` and manage the listener themselves.
// Only bind a port for local dev.
export default app;

if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`StrategyScale prototype running on http://localhost:${PORT}`);
  });
}
