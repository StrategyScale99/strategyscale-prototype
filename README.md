# StrategyScale (prototype)

AI strategic decision partner for CEOs. Single-page web app: paste a decision, get a structured CEO-level response.

## Run

1. `npm install`
2. Copy `.env.example` to `.env` and add your `ANTHROPIC_API_KEY`
3. `npm start`
4. Open http://localhost:3000

## How it works

- `server.js` — Express server with one endpoint (`POST /api/decide`) that calls Claude Opus 4.7 with a strict system prompt and a JSON schema (`output_config.format`) so the response always has the six required fields.
- `public/index.html` — single-page UI: input box, submit, response area. No build step, no framework.
- `package.json` — only deps are `express`, `@anthropic-ai/sdk`, `dotenv`.

## What you get back

For each decision: initial point of view, key constraint, key risk, recommendation, financial implication, and one targeted follow-up question. UK English, no consulting jargon, takes a position rather than hedging.
