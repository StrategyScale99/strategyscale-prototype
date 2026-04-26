import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import "dotenv/config";

import getInstantViewPrompt from "./prompts/instantView.js";
import getThinkingFramePrompt from "./prompts/thinkingFrame.js";
import getPressureTestPrompt from "./prompts/pressureTest.js";
import getFinalPrompt from "./prompts/final.js";

const app = express();
app.use(express.json({ limit: "1mb" }));
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
    decision: {
      type: "string",
      description:
        "The call, in the first 8 words. Then headline justification. Maximum 3 sentences. Open with a directive verb.",
    },
    rationale: {
      type: "string",
      description:
        "Why this is the right call given what was learned across the iterative diagnostic. Reference specific evidence from the answers. Maximum 3 sentences.",
    },
    tradeoffs: {
      type: "string",
      description:
        "What you give up by making this call. Name them plainly. Maximum 3 sentences.",
    },
    cost_of_inaction: {
      type: "string",
      description:
        "What waiting costs in concrete units (£, %, market share, months, customers, hires). Lead with the number. Maximum 3 sentences.",
    },
    plan_30_day: {
      type: "string",
      description:
        "Specific moves in the first 30 days. Names, numbers, decisions, deadlines. Maximum 3 sentences.",
    },
    plan_60_day: {
      type: "string",
      description:
        "Specific moves between days 30 and 60. Builds on the 30-day work. Maximum 3 sentences.",
    },
    plan_90_day: {
      type: "string",
      description:
        "Specific moves between days 60 and 90. By day 90 you should know whether this is working. Maximum 3 sentences.",
    },
    go_criteria: {
      type: "string",
      description:
        "Observable conditions that confirm the call is right and you should accelerate or commit further capital. Specific thresholds. Maximum 3 sentences.",
    },
    stop_criteria: {
      type: "string",
      description:
        "Observable conditions that should kill this decision before 90 days are out. Specific thresholds, not vibes. Maximum 3 sentences.",
    },
    what_would_change_the_decision: {
      type: "string",
      description:
        "The specific evidence that, if it surfaced, would force a reversal. Be concrete — name the data point, not the category. Maximum 3 sentences.",
    },
    memory_summary: {
      type: "object",
      description:
        "Lightweight retained context for the next StrategyScale session with this CEO. Useful as forward context, not a recap.",
      properties: {
        stated_goal: {
          type: "string",
          description: "What the CEO said they were trying to achieve, in their own framing. One sentence.",
        },
        business_context: {
          type: "string",
          description: "The business situation — sector, scale, market position, key facts. Maximum 2 sentences.",
        },
        key_constraints: {
          type: "string",
          description: "The binding constraints (capital, time, talent, regulatory, customer concentration). Maximum 2 sentences.",
        },
        evidence_gaps: {
          type: "string",
          description: "What we still don't know that next time we'd want to start by asking. Maximum 2 sentences.",
        },
        next_decision_gate: {
          type: "string",
          description: "The next decision moment that flows from this one. When it arrives and what triggers it. Maximum 2 sentences.",
        },
      },
      required: [
        "stated_goal",
        "business_context",
        "key_constraints",
        "evidence_gaps",
        "next_decision_gate",
      ],
      additionalProperties: false,
    },
  },
  required: [
    "decision",
    "rationale",
    "tradeoffs",
    "cost_of_inaction",
    "plan_30_day",
    "plan_60_day",
    "plan_90_day",
    "go_criteria",
    "stop_criteria",
    "what_would_change_the_decision",
    "memory_summary",
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`StrategyScale prototype running on http://localhost:${PORT}`);
});
