// Local preview server (no dependencies): node dev-server.mjs
// Serves ./public and runs functions/api/news.js the same way Cloudflare Pages does.
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("./public/", import.meta.url));
const port = Number(process.env.PORT || 8788);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon" };

const api = {
  "/api/news": await import(pathToFileURL(fileURLToPath(new URL("./functions/api/news.js", import.meta.url))).href),
  "/api/summary": await import(pathToFileURL(fileURLToPath(new URL("./functions/api/summary.js", import.meta.url))).href),
  "/api/market": await import(pathToFileURL(fileURLToPath(new URL("./functions/api/market.js", import.meta.url))).href),
  "/api/briefing": await import(pathToFileURL(fileURLToPath(new URL("./functions/api/briefing.js", import.meta.url))).href),
  "/api/ask": await import(pathToFileURL(fileURLToPath(new URL("./functions/api/ask.js", import.meta.url))).href),
  "/api/bot": await import(pathToFileURL(fileURLToPath(new URL("./functions/api/bot.js", import.meta.url))).href),
  "/api/newsai": await import(pathToFileURL(fileURLToPath(new URL("./functions/api/newsai.js", import.meta.url))).href),
};

// Local stand-in for the Cloudflare KV store (a JSON file in the system temp folder, never in the repo).
const kvFile = join(tmpdir(), "entryvex-dev-kv.json");
const devKV = {
  async get(k, type) { try { const all = JSON.parse(await readFile(kvFile, "utf8")); const v = all[k]; return v == null ? null : type === "json" ? JSON.parse(v) : v; } catch { return null; } },
  async put(k, v) { let all = {}; try { all = JSON.parse(await readFile(kvFile, "utf8")); } catch {} all[k] = v; await writeFile(kvFile, JSON.stringify(all)); },
};
const env = { PUSH: devKV };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  try {
    if (api[url.pathname]) {
      const mod = api[url.pathname];
      let r;
      if (req.method === "POST" && mod.onRequestPost) {
        const chunks = []; for await (const ch of req) chunks.push(ch);
        r = await mod.onRequestPost({ request: new Request(url, { method: "POST", headers: req.headers, body: Buffer.concat(chunks) }), env, waitUntil: () => {} });
      } else if (mod.onRequestGet) {
        r = await mod.onRequestGet({ request: new Request(url), env, waitUntil: () => {} });
      } else { res.writeHead(405); res.end(); return; }
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    let p = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
    if (p === "" || p.endsWith("/") || p.endsWith("\\")) p += "index.html";
    const file = join(root, p);
    if (!file.startsWith(root)) throw Object.assign(new Error("forbidden"), { code: "ENOENT" });
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch (e) {
    res.writeHead(e.code === "ENOENT" ? 404 : 500, { "content-type": "text/plain" });
    res.end(e.code === "ENOENT" ? "Not found" : String(e));
  }
}).listen(port, () => console.log(`Entryvex preview: http://localhost:${port}`));
