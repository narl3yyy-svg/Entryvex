// Cloudflare Worker entry point.
// Static files in ./public are served automatically by Workers Static Assets;
// this script only runs for paths that aren't a static file (e.g. /api/news).
import { onRequestGet as newsHandler } from "../functions/api/news.js";
import { onRequestGet as summaryHandler } from "../functions/api/summary.js";

const ROUTES = { "/api/news": newsHandler, "/api/summary": summaryHandler };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const handler = ROUTES[url.pathname];
    if (handler) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      return handler({ request, env, waitUntil: (p) => ctx.waitUntil(p) });
    }

    // Anything else that isn't a real file: hand back to the static assets (404 page).
    return env.ASSETS.fetch(request);
  },
};
