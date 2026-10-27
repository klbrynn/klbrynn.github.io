// Portfolio chat widget. No dependencies.
// - On the main site it mounts as a floating button (see index.html).
// - harness.html mounts it inline with a debug token and an onTrace callback.
(function () {
  "use strict";

  var CONFIG = window.KELSEY_CHAT_CONFIG || {};
  var DEFAULT_STARTERS = CONFIG.starters || [];

  function isConfigured(endpoint) {
    return Boolean(endpoint) && endpoint.indexOf("YOUR-SUBDOMAIN") === -1;
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function Chat(opts) {
    this.endpoint = (opts.endpoint || CONFIG.endpoint || "").replace(/\/$/, "");
    this.debugToken = opts.debugToken || "";
    this.onTrace = opts.onTrace || null;
    this.onSend = opts.onSend || null;
    this.starters = opts.starters || DEFAULT_STARTERS;
    this.messages = [];
    this.busy = false;
    this.root = this.build(opts.inline);
  }

  Chat.prototype.build = function (inline) {
    var self = this;
    var root = el("section", "kc-panel" + (inline ? " kc-inline" : ""));
    root.setAttribute("role", inline ? "region" : "dialog");
    root.setAttribute("aria-label", "Ask about Kelsey");

    var head = el("div", "kc-head");
    head.appendChild(el("span", "kc-dot kc-red"));
    head.appendChild(el("span", "kc-dot kc-yellow"));
    head.appendChild(el("span", "kc-dot kc-green"));
    head.appendChild(el("span", "kc-title", "ask_kelsey_ai.sh"));
    if (!inline) {
      var close = el("button", "kc-close", "✕");
      close.type = "button";
      close.setAttribute("aria-label", "Close chat");
      close.onclick = function () { self.close(); };
      head.appendChild(close);
    }
    root.appendChild(head);

    this.log = el("div", "kc-log");
    this.log.setAttribute("aria-live", "polite");
    root.appendChild(this.log);

    this.addBubble("assistant", "Hi. I'm an AI assistant that answers questions about Kelsey's career, using her work history as my only source. What would you like to know?");

    this.chips = el("div", "kc-chips");
    this.starters.forEach(function (s) {
      var b = el("button", "kc-chip", s);
      b.type = "button";
      b.onclick = function () { self.send(s); };
      self.chips.appendChild(b);
    });
    root.appendChild(this.chips);

    var form = el("form", "kc-form");
    this.input = el("textarea", "kc-input");
    this.input.rows = 1;
    this.input.maxLength = 800;
    this.input.placeholder = "Ask about Kelsey's experience...";
    this.input.setAttribute("aria-label", "Your question");
    this.input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
    });
    var go = el("button", "kc-send", "Send");
    go.type = "submit";
    form.appendChild(this.input);
    form.appendChild(go);
    form.onsubmit = function (e) {
      e.preventDefault();
      var v = self.input.value.trim();
      if (v) { self.input.value = ""; self.send(v); }
    };
    root.appendChild(form);

    root.appendChild(el("p", "kc-foot", "AI assistant. It can make mistakes, so confirm details with Kelsey. Questions may be logged to improve answers."));
    return root;
  };

  Chat.prototype.addBubble = function (role, text, extraCls) {
    var b = el("div", "kc-msg kc-" + role + (extraCls ? " " + extraCls : ""), text);
    this.log.appendChild(b);
    this.log.scrollTop = this.log.scrollHeight;
    return b;
  };

  Chat.prototype.send = function (text) {
    var self = this;
    if (this.busy || !text) return;
    if (!isConfigured(this.endpoint)) {
      this.addBubble("assistant", "The assistant endpoint isn't configured yet.", "kc-note");
      return;
    }
    this.busy = true;
    this.chips.style.display = "none";
    this.addBubble("user", text);
    this.messages.push({ role: "user", content: text });
    if (this.onSend) this.onSend(text);
    var typing = this.addBubble("assistant", "", "kc-typing");
    typing.appendChild(el("span"));
    typing.appendChild(el("span"));
    typing.appendChild(el("span"));

    var headers = { "Content-Type": "application/json" };
    if (this.debugToken) headers["X-Harness-Debug"] = this.debugToken;
    var started = performance.now();

    fetch(this.endpoint + "/chat", { method: "POST", headers: headers, body: JSON.stringify({ messages: this.messages }) })
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
      .then(function (res) {
        typing.remove();
        var d = res.data || {};
        var reply = d.reply || "Something went wrong. Email Kelsey at kblisenbe@gmail.com.";
        if (d.blocked || !d.reply) {
          // Don't keep blocked exchanges in the history the model sees next turn.
          self.messages.pop();
          self.addBubble("assistant", reply, "kc-note");
        } else {
          self.messages.push({ role: "assistant", content: reply });
          self.addBubble("assistant", reply);
        }
        if (self.onTrace) self.onTrace(d.trace || null, d, { status: res.status, clientMs: Math.round(performance.now() - started), question: text });
      })
      .catch(function (err) {
        typing.remove();
        self.messages.pop();
        self.addBubble("assistant", "I couldn't reach the assistant. Email Kelsey at kblisenbe@gmail.com.", "kc-note");
        if (self.onTrace) self.onTrace(null, { error: String(err) }, { status: 0, clientMs: Math.round(performance.now() - started), question: text });
      })
      .then(function () { self.busy = false; self.input.focus({ preventScroll: true }); });
  };

  Chat.prototype.open = function () {
    this.root.classList.add("kc-open");
    this.launcher.setAttribute("aria-expanded", "true");
    this.input.focus({ preventScroll: true });
  };
  Chat.prototype.close = function () {
    this.root.classList.remove("kc-open");
    this.launcher.setAttribute("aria-expanded", "false");
    this.launcher.focus();
  };

  function mountFloating() {
    var chat = new Chat({});
    if (!isConfigured(chat.endpoint)) return null; // stay hidden until deployed
    var launcher = el("button", "kc-launcher", "// ask_my_ai");
    launcher.type = "button";
    launcher.setAttribute("aria-expanded", "false");
    launcher.onclick = function () {
      chat.root.classList.contains("kc-open") ? chat.close() : chat.open();
    };
    chat.launcher = launcher;
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && chat.root.classList.contains("kc-open")) chat.close();
    });
    document.body.appendChild(chat.root);
    document.body.appendChild(launcher);
    return chat;
  }

  window.KelseyChat = {
    mountInline: function (container, opts) {
      var chat = new Chat(Object.assign({ inline: true }, opts || {}));
      container.innerHTML = "";
      container.appendChild(chat.root);
      return chat;
    },
    mountFloating: mountFloating
  };

  var me = document.currentScript;
  if (me && me.getAttribute("data-floating") === "true") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountFloating);
    else mountFloating();
  }
})();
