// One place to point the site at the Worker.
// After `npx wrangler deploy`, paste the URL it prints here (no trailing slash).
// While this still says YOUR-SUBDOMAIN, the chat button stays hidden on the live site.
window.KELSEY_CHAT_CONFIG = {
  endpoint: "https://kelsey-portfolio-ai.YOUR-SUBDOMAIN.workers.dev",
  starters: [
    "What is Kelsey doing at NBCUniversal?",
    "How big are the teams she's led?",
    "Tell me about the AI tool she built at FOX",
    "Is she a fit for a VP of Engineering Operations role?"
  ]
};
