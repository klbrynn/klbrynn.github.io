// Portfolio AI harness: a Cloudflare Worker that sits between the website and the Claude API.
//
//   browser ──POST /chat──▶ [1 origin] [2 rate limit] [3 parse] [4 input screen]
//                           [5 assemble prompt] [6 Claude] [7 output check] [8 style] ──▶ reply
//
// Every stage writes to a trace. Visitors only get the reply. A request carrying the
// X-Harness-Debug header (matching the DEBUG_TOKEN secret) also gets the full trace,
// which is what harness.html displays.

import SYSTEM_PROMPT from "../prompts/system-prompt.md";
import KNOWLEDGE from "../prompts/knowledge.md";
import { screenInput, checkOutput, enforceStyle } from "./guardrails.js";

const ANTHROPIC_VERSION = "2023-06-01";

// Best-effort, per-isolate rate limiter. Cloudflare may run several isolates, so this
// is a speed bump, not a wall. The real backstop is the monthly spend limit you set in
// the Claude Console.
const hits = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) hits.clear();
  return { allowed: recent.length <= limit, count: recent.length };
}

class Trace {
  constructor() {
    this.t0 = Date.now();
    this.stages = [];
  }
  add(name, result, startedAt, extra = {}) {
    this.stages.push({
      name,
      status: result.status,
      reason: result.reason,
      detail: result.detail,
      ms: Date.now() - startedAt,
      ...extra,
    });
  }
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function cfg(env) {
  const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== "" ? Number(v) : d);
  return {
    model: env.MODEL || "claude-haiku-5-5",
    maxTokens: num(env.MAX_OUTPUT_TOKENS, 500),
    maxChars: num(env.MAX_MESSAGE_CHARS, 800),
    maxTurns: num(env.MAX_TURNS, 12),
    maxTotalChars: num(env.MAX_CONVERSATION_CHARS, 8000),
    rateLimit: num(env.RATE_LIMIT_PER_10_MIN, 20),
    canary: env.CANARY || "KL-CANARY-7f3a9c",
    baseUrl: (env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, ""),
    priceIn: num(env.PRICE_INPUT_PER_MTOK, 0.1),
    priceOut: num(env.PRICE_OUTPUT_PER_MTOK, 0.5),
    origins: (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
  };
}

function estimateCost(usage, c) {
  if (!usage) return null;
  const input =
    (usage.input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0) * 1.25 +
    (usage.cache_read_input_tokens || 0) * 0.1;
  return (input * c.priceIn + (usage.output_tokens || 0) * c.priceOut) / 1e6;
}

export default {
  async fetch(request, env) {
    const c = cfg(env);
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const originAllowed = c.origins.includes(origin);
    const cors = originAllowed
      ? {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Harness-Debug",
          "Access-Control-Max-Age": "86400",
          Vary: "Origin",
        }
      : { Vary: "Origin" };

    if (request.method === "OPTIONS") return new Response(null, { status: originAllowed ? 204 : 403, headers: cors });

    const debug = Boolean(env.DEBUG_TOKEN) && request.headers.get("X-Harness-Debug") === env.DEBUG_TOKEN;

    if (url.pathname === "/health") {
      return json(
        {
          ok: true,
          model: c.model,
          api_key_set: Boolean(env.ANTHROPIC_API_KEY),
          debug_token_valid: debug,
          origin_allowed: originAllowed,
        },
        200,
        cors,
      );
    }
    if (url.pathname !== "/chat" || request.method !== "POST") return json({ error: "not_found" }, 404, cors);

    const trace = new Trace();
    const respond = (body, status = 200) => {
      const payload = { ...body };
      if (debug) payload.trace = { ...trace, total_ms: Date.now() - trace.t0, ...(body._trace || {}) };
      delete payload._trace;
      return json(payload, status, cors);
    };
    const log = (outcome, extra = {}) =>
      console.log(JSON.stringify({ outcome, ms: Date.now() - trace.t0, debug, ...extra }));

    // 1. Origin: only the portfolio site (and localhost during development) may call this.
    let t = Date.now();
    if (!originAllowed && !debug) {
      trace.add("origin", { status: "block", reason: "origin_not_allowed", detail: `origin "${origin || "none"}" is not in ALLOWED_ORIGINS` }, t);
      log("blocked_origin", { origin });
      return respond({ error: "forbidden" }, 403);
    }
    trace.add("origin", { status: "pass", reason: "ok", detail: originAllowed ? `${origin} allowed` : "debug token bypass" }, t);

    // 2. Rate limit per visitor IP.
    t = Date.now();
    const ip = request.headers.get("CF-Connecting-IP") || "local";
    const rl = rateLimit(ip, c.rateLimit, 10 * 60 * 1000);
    if (!rl.allowed) {
      trace.add("rate_limit", { status: "block", reason: "too_many_requests", detail: `${rl.count} requests in 10 min, limit ${c.rateLimit}` }, t);
      log("blocked_rate");
      return respond({ reply: "You've asked a lot of questions in a short time. Give it a few minutes, or email Kelsey at kblisenbe@gmail.com.", blocked: true }, 429);
    }
    trace.add("rate_limit", { status: "pass", reason: "ok", detail: `${rl.count} of ${c.rateLimit} requests used in this 10 min window` }, t);

    // 3. Parse.
    t = Date.now();
    let body;
    try {
      body = await request.json();
    } catch {
      trace.add("parse", { status: "block", reason: "bad_json", detail: "request body was not valid JSON" }, t);
      return respond({ error: "bad_request" }, 400);
    }
    trace.add("parse", { status: "pass", reason: "ok", detail: "valid JSON" }, t);

    // 4. Input screen: shape, length, turn limits, prompt-injection patterns.
    t = Date.now();
    const screen = screenInput(body.messages, c);
    trace.add("input_screen", screen, t, screen.flags ? { flags: screen.flags } : {});
    if (screen.status === "block") {
      log("blocked_input", { reason: screen.reason });
      return respond({ reply: screen.reply || "Something was off with that request. Try rephrasing your question.", blocked: true });
    }

    // 5. Assemble the prompt. The knowledge block is marked cacheable so repeat
    //    questions reuse it (once it is long enough to qualify for caching).
    t = Date.now();
    if (!env.ANTHROPIC_API_KEY) {
      trace.add("assemble_prompt", { status: "block", reason: "missing_key", detail: "ANTHROPIC_API_KEY secret is not set" }, t);
      return respond({ reply: "The assistant isn't configured yet. Email Kelsey at kblisenbe@gmail.com.", blocked: true }, 503);
    }
    const system = [
      { type: "text", text: SYSTEM_PROMPT.replaceAll("{{CANARY}}", c.canary) },
      { type: "text", text: `<knowledge>\n${KNOWLEDGE}\n</knowledge>`, cache_control: { type: "ephemeral" } },
    ];
    const claudeRequest = { model: c.model, max_tokens: c.maxTokens, system, messages: screen.messages };
    trace.add(
      "assemble_prompt",
      { status: "pass", reason: "ok", detail: `system prompt ${system[0].text.length} chars + knowledge ${KNOWLEDGE.length} chars + ${screen.messages.length} message(s)` },
      t,
    );

    // 6. Call Claude.
    t = Date.now();
    let res, data;
    try {
      res = await fetch(`${c.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(claudeRequest),
      });
      data = await res.json();
    } catch (err) {
      trace.add("model_call", { status: "block", reason: "network_error", detail: String(err) }, t);
      log("model_error", { error: String(err) });
      return respond({ reply: "I couldn't reach my model just now. Try again in a moment, or email Kelsey at kblisenbe@gmail.com.", blocked: true, _trace: { request: claudeRequest } }, 502);
    }
    if (!res.ok) {
      trace.add("model_call", { status: "block", reason: `http_${res.status}`, detail: data?.error?.message || "Claude API error" }, t);
      log("model_error", { status: res.status, type: data?.error?.type });
      return respond({ reply: "I couldn't reach my model just now. Try again in a moment, or email Kelsey at kblisenbe@gmail.com.", blocked: true, _trace: { request: claudeRequest, response: data } }, 502);
    }
    const raw = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    trace.add(
      "model_call",
      { status: "pass", reason: data.stop_reason, detail: `${c.model}: ${data.usage?.input_tokens ?? "?"} in, ${data.usage?.output_tokens ?? "?"} out, stop_reason ${data.stop_reason}` },
      t,
      { usage: data.usage },
    );

    // 7. Output check: did the model echo its prompt, leak the canary, or state a pay number?
    t = Date.now();
    const out = checkOutput(raw, c.canary, system[0].text);
    trace.add("output_check", out, t);

    // 8. Style: rewrite em dashes deterministically.
    t = Date.now();
    const styled = enforceStyle(out.text);
    trace.add("style", styled, t);

    const finalBlocked = out.status === "block";
    log(finalBlocked ? "blocked_output" : "ok", {
      reason: out.reason,
      flags: screen.flags,
      question: screen.messages[screen.messages.length - 1].content.slice(0, 200),
      usage: data.usage,
    });

    return respond({
      reply: styled.text,
      blocked: finalBlocked || undefined,
      _trace: {
        model: c.model,
        prompt: { system_prompt: system[0].text, knowledge: KNOWLEDGE, canary: c.canary },
        request: { ...claudeRequest, system: "[see Prompt tab]" },
        response: data,
        raw_reply: raw,
        usage: data.usage,
        est_cost_usd: estimateCost(data.usage, c),
      },
    });
  },
};
