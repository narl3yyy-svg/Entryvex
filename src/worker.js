// Cloudflare Worker entry point.
// Static files in ./public are served automatically by Workers Static Assets;
// this script only runs for paths that aren't a static file (the /api/* routes).
import { onRequestGet as newsHandler } from "../functions/api/news.js";
import { onRequestGet as summaryHandler } from "../functions/api/summary.js";
import { onRequestPost as askHandler } from "../functions/api/ask.js";

const GET = { "/api/news": newsHandler, "/api/summary": summaryHandler };
const POST = { "/api/ask": askHandler };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const handler = (request.method === "POST" ? POST : request.method === "GET" || request.method === "HEAD" ? GET : {})[url.pathname];
    if (handler) return handler({ request, env, waitUntil: (p) => ctx.waitUntil(p) });
    if (GET[url.pathname] || POST[url.pathname]) {
      return new Response("Method not allowed", { status: 405 });
    }
    // Anything else that isn't a real file: hand back to the static assets (404 page).
    return env.ASSETS.fetch(request);
  },
};
