// Deterministic checks that run before and after the model call.
// The model is told how to behave in the system prompt; these checks are the
// backstop for when it (or a visitor) doesn't cooperate.

// Phrases that usually mean someone is trying to steer the bot off its job.
// A match is FLAGGED, not blocked: the message still goes to the model, which
// is instructed to decline. The flag shows up in the trace so you can watch it.
const INJECTION_PATTERNS = [
  { id: "ignore_instructions", re: /\b(ignore|disregard|forget)\b.{0,30}\b(previous|prior|above|earlier|all|your)\b.{0,20}\b(instructions?|prompts?|rules|guidelines)\b/i },
  { id: "prompt_extraction", re: /\b(reveal|show|print|repeat|output|tell me|what (is|are))\b.{0,40}\b(system prompt|your (instructions|prompt|rules)|initial prompt)\b/i },
  { id: "persona_swap", re: /\b(you are now|act as|pretend (to be|you are)|role-?play as|from now on you)\b/i },
  { id: "mode_switch", re: /\b(developer mode|debug mode|jailbreak|DAN mode|god mode)\b/i },
  { id: "fake_markup", re: /<\/?\s*(system|knowledge|instructions|boundaries)\s*>/i },
];

// Compensation figures like "$210K" or "$210,000". Ranges like "$1M to $5M" are fine.
const COMP_FIGURE = /\$\s?\d{2,3}(\s?[kK]\b|,\d{3}\b)/;

export function screenInput(rawMessages, limits) {
  const { maxChars, maxTurns, maxTotalChars } = limits;

  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return { status: "block", reason: "invalid_shape", detail: "messages must be a non-empty array" };
  }

  const messages = [];
  for (const m of rawMessages) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") {
      return { status: "block", reason: "invalid_shape", detail: "each message needs role user|assistant and string content" };
    }
    messages.push({ role: m.role, content: m.content.trim() });
  }

  const last = messages[messages.length - 1];
  if (last.role !== "user" || !last.content) {
    return { status: "block", reason: "invalid_shape", detail: "last message must be a non-empty user message" };
  }
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].role === messages[i - 1].role) {
      return { status: "block", reason: "invalid_shape", detail: "roles must alternate" };
    }
  }

  if (last.content.length > maxChars) {
    return {
      status: "block",
      reason: "too_long",
      detail: `message is ${last.content.length} chars, limit is ${maxChars}`,
      reply: `That message is a bit long for me. Could you trim it to the key requirements (under ${maxChars} characters)? For a full job description, emailing Kelsey at kblisenbe@gmail.com works best.`,
    };
  }

  // Keep only the most recent turns so cost per request stays bounded.
  let kept = messages.slice(-maxTurns);
  if (kept[0].role !== "user") kept = kept.slice(1);
  const trimmed = messages.length - kept.length;

  const total = kept.reduce((n, m) => n + m.content.length, 0);
  if (total > maxTotalChars) {
    return {
      status: "block",
      reason: "conversation_too_long",
      detail: `conversation is ${total} chars, limit is ${maxTotalChars}`,
      reply: "This conversation has gotten long. Refresh to start a new one, or email Kelsey at kblisenbe@gmail.com to keep going.",
    };
  }

  const flags = INJECTION_PATTERNS.filter((p) => p.re.test(last.content)).map((p) => p.id);

  return {
    status: flags.length ? "flag" : "pass",
    reason: flags.length ? "possible_injection" : "ok",
    detail: flags.length
      ? `matched: ${flags.join(", ")}. Sent to model anyway; the prompt tells it to decline.`
      : `${kept.length} message(s) accepted${trimmed ? `, ${trimmed} older trimmed` : ""}`,
    flags,
    messages: kept,
  };
}

export function checkOutput(text, canary, systemPrompt = "") {
  // A leak doesn't always include the canary (the model may stop early), so also
  // look for any full line of the system prompt appearing verbatim in the reply.
  const echoed = systemPrompt
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length >= 50)
    .find((l) => text.includes(l));
  if (echoed) {
    return {
      status: "block",
      reason: "prompt_echo",
      detail: `reply repeated a line of the system prompt verbatim ("${echoed.slice(0, 60)}..."). Reply replaced.`,
      text: "I can't share how I'm set up, but I'm glad to answer questions about Kelsey's experience.",
    };
  }
  if (canary && text.includes(canary)) {
    return {
      status: "block",
      reason: "canary_leak",
      detail: "reply contained the hidden canary marker, so the model was echoing its prompt. Reply replaced.",
      text: "I can't share how I'm set up, but I'm glad to answer questions about Kelsey's experience.",
    };
  }
  if (COMP_FIGURE.test(text)) {
    return {
      status: "block",
      reason: "comp_figure",
      detail: "reply contained a compensation-style dollar figure. Reply replaced.",
      text: "Kelsey prefers to discuss compensation directly. You can reach her at kblisenbe@gmail.com.",
    };
  }
  return { status: "pass", reason: "ok", detail: "no prompt echo, no canary, no compensation figures", text };
}

// House style: no em dashes, ever. Fix them deterministically instead of hoping.
export function enforceStyle(text) {
  let fixes = 0;
  let out = text.replace(/\s*—\s*/g, () => { fixes++; return ", "; });
  out = out.replace(/(\S)–(\S)/g, (_, a, b) => { fixes++; return `${a}-${b}`; });
  out = out.replace(/\s*–\s*/g, () => { fixes++; return ", "; });
  return {
    status: fixes ? "flag" : "pass",
    reason: fixes ? "dashes_rewritten" : "ok",
    detail: fixes ? `rewrote ${fixes} em/en dash(es)` : "no style fixes needed",
    text: out,
  };
}
