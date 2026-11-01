# Lumi v2 · runnable app

Node 20+, Express and the official `openai` package (pointed at any OpenAI-compatible base URL). Plain HTML and JavaScript in the browser, no build step. Data is stored in `data/db.json`. The merchant's products, reviews and post history are mocked in `data/merchant.json`.

## Start

```bash
npm install && cp .env.example .env   # 1
# 2. fill in LLM_API_KEY, LLM_BASE_URL, LLM_MODEL in .env
npm start                             # 3. http://localhost:3000
```

| Command | What it does |
| --- | --- |
| `npm start` | Runs the server |
| `npm test` | 19 end-to-end tests with a stub model (no key needed) |
| `npm run check-model` | Checks the model in `.env` can stream, call tools, take tool results back and return JSON. Run it after switching vendor |
| `npm run eval` | 28-case agent evaluation (4 multi-turn) against your configured model |
| `npm run reset` | Clears demo users, posts, clicks, orders and events |

## Models

| Platform | `LLM_BASE_URL` | `LLM_MODEL` | Get a key |
| --- | --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-flash` | https://platform.deepseek.com/api_keys |
| Kimi (Moonshot) | `https://api.moonshot.cn/v1` | `kimi-k2-0905-preview` | https://platform.moonshot.cn/console/api-keys |
| Zhipu GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` | https://open.bigmodel.cn/usercenter/apikeys |
| Qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | https://bailian.console.aliyun.com |

Optional: `LLM_MODEL_FREE` gives Free users a cheaper model, as in the pricing plan.

## Pages

| URL | What it is |
| --- | --- |
| `/` | Landing page. Captures `utm_*` and `ttclid`, then sign-up |
| `/app` | Home, Write (4 steps), Results, Plan, the assistant panel, paywall and simulated checkout. The dark Demo controls strip is for reviewers only |
| `/r/:code` | Tracked short link. Counts the click, then redirects to the store |
| `/shop` | Simulated merchant store where the "customer" orders, with or without the discount code |
| `/admin` | Internal metrics: the three monthly numbers, funnel by source, attribution check, Events API postbacks, event stream |

## How the agent works

The assistant opens from any page. `lib/agent.js` builds a system prompt from the shop, the product list (small enough to inline, so there is no product tool), plan and credits, a 30-day results snapshot and the page the merchant is on. It sends the conversation plus six tool definitions with `tool_choice: "auto"`. When the model returns tool calls, the server runs them, sends the results back, and repeats until the model answers in text (at most 6 steps). Nothing in the app routes by keywords. Text streams over server-sent events, and every tool call appears in the chat as a step with its arguments, result and a card.

Tools follow what the merchant is trying to do, not the tables underneath:

| Tool | Does | Credit |
| --- | --- | --- |
| `get_results_summary` | Orders, revenue and clicks vs the previous period, rankings by style, channel and product, top posts and precomputed findings. Free gets the latest post only, trimmed on the server | – |
| `get_post` | One post: caption, clicks, orders, revenue, vs the shop average, how its orders were matched | – |
| `find_reviews` | Up to 5 real review quotes for a product, optionally about a topic | – |
| `propose_post` | Suggests product, channel and style with a reason. Shows a card with a "Write 3 versions · 1 credit" button | – |
| `revise_post` | Rewrites one version on request | – |
| `create_tracked_link` | A tracked link and code for a bio, story, email or ad | – |

**Why a button and not a prompt rule.** Asking the model to "confirm before spending a credit" failed in testing: it read "write me a post" as consent. A first fix let the model call `generate_post` once the button had been pressed, which still charged twice in real use: two `generate_post` calls in one turn, or a pressed proposal left over from a failed turn that the model wrote on the next, unrelated message. Now writing is not a model tool at all. The button sends `proposal_id` with the chat message; the server accepts the proposal and runs `generate_post` itself in that request, then the model writes one sentence. One press spends at most one credit, a second press gets `already_written`, and a failed write puts the proposal back. The eval checks credits spent ≤ button presses on every case.

**No double charges.** The Write page sends a `request_id` with each write, so a double click or a retry after a dropped connection returns the same post. Only one assistant turn runs per user at a time; a second one gets 409.

**Billing.** `lib/billing.js` holds the rules: one open checkout per item, a payment is checked against the user's plan when it arrives (paying Pro while already Pro, or a top-up after leaving Pro, is refunded), cancel keeps Pro until the period ends and can be undone with Keep Pro, and every request syncs plan and subscription with the clock.

**Switching model vendor.** `lib/llm.js` absorbs the ways "OpenAI-compatible" APIs differ: tool-call names repeated in every streamed chunk, chunks without `index`, the whole call in one chunk, thinking models that need `reasoning_content` sent back, models that reject `temperature` or `tool_choice` (dropped and retried once), and JSON wrapped in `<think>` or code fences. The stub model in `test/` imitates each of these. Kimi and GLM were not called for real while building this (only DeepSeek was reachable), so run `npm run check-model` before switching.

**Platform rules.** Instagram and TikTok captions can't hold a tappable link, so captions there carry the discount code (which attributes the order) and say "link in bio"; the tracked link goes in the bio or a story sticker. Facebook and email captions include the link. A URL the model writes anyway is replaced on the server.

Error handling: one retry on timeouts, 429 and 5xx; clear messages for a bad key, a wrong model name or a rate limit, and the vendor's own words for a 400; invalid tool arguments are returned to the model so it can call again; a failed turn is removed from history so the next one is not broken; failed generations do not use a credit, and the proposal can be pressed again.

## Code map

```
server.js            routes: sign-up, home, chat (SSE, with the proposal button), generate, publish, results, tracked links, shop, billing, admin
lib/config.js        plans, prices and limits (one source of truth)
lib/agent.js         system prompt and agent loop
lib/proposals.js     proposals: proposed → accepted and written in one request (button) → used
lib/billing.js       checkouts, payment webhook, cancel at period end, resume
lib/tools.js         tool definitions and handlers
lib/generate.js      post writing and rewriting: reserve credit → model → validate → tracked link → commit or refund
lib/llm.js           OpenAI-compatible client: vendor differences, streaming tool calls, retries, error messages
lib/quota.js         server-side quota with reserve / commit / refund
lib/links.js         short links, discount codes, click de-duplication, order attribution
lib/performance.js   results summary, per-post results and the next-post suggestion (shared by Home, Results and the tools)
lib/metrics.js       numbers for /admin
lib/store.js         JSON storage and track()
test/                end-to-end tests and the stub model they use (with vendor quirk modes)
scripts/check-model.js  checks a model before switching to it
eval/                agent eval cases and runner
public/              landing, app, shop and admin pages
```

## Events

All events go through `store.track()`. Events about money, credits and attribution are written on the server. The browser can only send `landing_view`, `report_viewed` and `paywall_view`; any other name is rejected. The full tracking plan is in `docs/PRD.md` §6.
