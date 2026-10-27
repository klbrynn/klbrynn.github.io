# Portfolio AI harness

A chat assistant for klbrynn.github.io that answers recruiter questions about Kelsey's career, plus an inspector page that shows every step the harness takes.

## What's where

| File | What it does |
|---|---|
| `prompts/system-prompt.md` | How the assistant behaves: grounding, boundaries, style |
| `prompts/knowledge.md` | Everything the assistant knows. Edit this to change its answers |
| `src/worker.js` | The 8-stage pipeline that runs on every question |
| `src/guardrails.js` | Deterministic checks before and after the model call |
| `wrangler.toml` | Worker settings and limits (model, rate limit, message size) |
| `../js/chat-widget.js`, `../css/chat-widget.css` | The floating chat button on the homepage |
| `../js/chat-config.js` | The one line that points the site at your Worker |
| `../harness.html` | The inspector page for demos |

Folders starting with `_` are skipped by GitHub Pages, so `_harness/` is never served as part of the site. The repo itself is public, so treat the prompt and knowledge as public too.

## The pipeline

```
visitor question
  1 origin          only klbrynn.github.io may call the Worker
  2 rate_limit      20 questions per visitor per 10 minutes
  3 parse           well-formed request
  4 input_screen    length limits, role checks, flags injection phrasing
  5 assemble_prompt system prompt + knowledge (cacheable) + conversation
  6 model_call      Claude Haiku 5.5 via the Messages API
  7 output_check    blocks prompt echo, canary leak, compensation figures
  8 style           rewrites em dashes
reply to visitor (plus the full trace, if the debug token is present)
```

## Run it on your laptop (best for a demo)

You need Node.js 18+ and a Claude API key from https://platform.claude.com.

```bash
cd _harness
npm install
cp .dev.vars.example .dev.vars      # then open .dev.vars and paste your API key and a debug token
npm run dev                          # Worker at http://localhost:8787
```

In a second terminal, from the repo root:

```bash
python3 -m http.server 8000
```

Open http://localhost:8000/harness.html, enter `http://localhost:8787` and your debug token, and click Connect. The pills under the header should all be green.

## Deploy

```bash
cd _harness
npx wrangler login                          # opens Cloudflare in your browser
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put DEBUG_TOKEN
npx wrangler secret put CANARY              # optional: any random string
npm run deploy                              # prints https://kelsey-portfolio-ai.<you>.workers.dev
```

Paste that URL into `js/chat-config.js`, commit, and push. The chat button appears on the site once the URL no longer says YOUR-SUBDOMAIN.

Then set a monthly spend limit in the Claude Console. That limit is the real cost backstop.

## Watch it live

- `harness.html` on the live site with your debug token: full traces for your own questions.
- `npm run logs`: one line per real visitor question (outcome, tokens, first 200 characters of the question).
- Claude Console usage page: spend over time.

## Changing answers

Edit `prompts/knowledge.md` and redeploy (`npm run deploy`). No website change is needed. Keep it to facts you would be happy to see screenshotted.

## Honest limits

- The rate limiter lives in memory per Worker instance, so it slows abuse but cannot stop a determined script. The Console spend limit is the hard stop.
- The origin check stops other websites from embedding your bot. It does not stop someone calling the Worker from a script, which is why the rate and spend limits exist.
- The injection filter flags known phrasing; it does not block. The system prompt and output checks do the real work.
