// Cloudflare Worker entry point.
// Static files in ./public are served automatically by Workers Static Assets;
// this script only runs for the /api/* routes and the 5-minute alert check.
import { onRequestGet as newsHandler } from "../functions/api/news.js";
import { onRequestGet as summaryHandler } from "../functions/api/summary.js";
import { onRequestPost as askHandler } from "../functions/api/ask.js";
import { onRequestPost as briefingHandler } from "../functions/api/briefing.js";
import { onRequestGet as marketHandler } from "../functions/api/market.js";
import { onRequest as pushHandler, runAlerts } from "../functions/api/push.js";
import { onRequestGet as newsAiHandler, cronNews } from "../functions/api/newsai.js";

const GET = { "/api/news": newsHandler, "/api/summary": summaryHandler, "/api/market": marketHandler, "/api/newsai": newsAiHandler };
const POST = { "/api/ask": askHandler, "/api/briefing": briefingHandler };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const context = { request, env, waitUntil: (p) => ctx.waitUntil(p) };
    if (url.pathname.startsWith("/api/push/")) return pushHandler(context);
    const handler = (request.method === "POST" ? POST : request.method === "GET" || request.method === "HEAD" ? GET : {})[url.pathname];
    if (handler) return handler(context);
    if (GET[url.pathname] || POST[url.pathname]) return new Response("Method not allowed", { status: 405 });
    // Anything else that isn't a real file: hand back to the static assets (404 page).
    return env.ASSETS.fetch(request);
  },

  // Every 5 minutes: check everyone's closed-app alerts and send notifications, and let the AI read
  // the news for one tracked market (each one about once an hour) to build its measured record.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAlerts(env, event.scheduledTime));
    ctx.waitUntil(cronNews(env, event.scheduledTime));
  },
};
