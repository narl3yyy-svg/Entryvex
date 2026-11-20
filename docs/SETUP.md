# Putting Entryvex online

Once this is done, you open **https://entryvex.trade** from any computer or phone. Nothing runs on your PC. Every time new code is pushed to GitHub, the site updates itself within about a minute.

**What you'll use:** [Cloudflare](https://www.cloudflare.com), for both the domain and the hosting.

- Hosting on Cloudflare Workers is **free**: unlimited visitors, plus 100,000 news requests per day on the free plan, far more than you need.
- The domain **entryvex.trade** is registered with Cloudflare Registrar (bought 2026-11-20).

---

## Step 1: Cloudflare account ✅ done

Make sure two-factor login is on: profile icon (top right) → **My Profile** → **Authentication** → **Two-Factor Authentication**. Your domain lives here, so protect it.

## Step 2: Domain ✅ done (entryvex.trade)

Check that **auto-renew** is ON: **Domain Registration** → **Manage Domains** → entryvex.trade → **Auto-renew**. That way you never lose the domain.

## Step 3: Connect the GitHub repo to Cloudflare Workers (5 min)

Entryvex deploys as a **Cloudflare Worker with static assets** (Cloudflare's default for new projects). The settings live in `wrangler.toml`, so there's nothing to build.

1. Left menu → **Workers & Pages** → **Create application** → **Import a repository** (Continue with GitHub).
2. On GitHub's permission screen, choose **Only select repositories** → **narl3yyy-svg/Entryvex** → **Install & Authorize**.
3. Select **narl3yyy-svg/Entryvex**. On **Set up your application**, use:

   | Setting | Value |
   |---|---|
   | Project name | `entryvex` (must match `name` in wrangler.toml) |
   | Build command | *(leave empty)* |
   | Deploy command | `npx wrangler deploy` (the default) |
   | Preview command | `npx wrangler versions upload` (or leave the default) |
   | Builds for non-production branches | on (optional: gives preview links) |

4. Click **Deploy**. It takes about a minute.
5. When it finishes, you get a free link like **https://entryvex.<your-subdomain>.workers.dev**. Open it: you should see live prices, the chart and news.

## Step 4: Attach your domain (2 min)

1. **Workers & Pages** → **entryvex** → **Settings** → **Domains & Routes** → **+ Add** → **Custom domain**.
2. Type `entryvex.trade` → **Add domain**. Because the domain is already in Cloudflare, it creates the DNS record and HTTPS certificate for you.
3. Repeat for `www.entryvex.trade`.
4. Wait about 5–15 minutes, then open **https://entryvex.trade**. 🎉

## Step 5 (optional but recommended): make it private

Right now anyone who finds the URL can use the site. To restrict it to just you (and anyone you invite):

1. Left menu → **Zero Trust** (free for up to 50 users; pick the **Free** plan when asked, no card charge).
2. **Access** → **Applications** → **Add an application** → **Self-hosted**.
3. Application domain: `entryvex.trade` (add `www.entryvex.trade` too). Also turn off the workers.dev link: Workers & Pages → entryvex → Settings → Domains & Routes → workers.dev → Disable.
4. Add a policy: **Action: Allow**, **Include → Emails →** your email address.
5. Save. Visiting the site now asks for your email and sends you a one-time login code.

---

## How updates work from now on

```
code pushed to GitHub (main)  →  Cloudflare rebuilds automatically  →  entryvex.trade updated (~1 min)
```

You can watch each deploy under **Workers & Pages → entryvex → Deployments**, and roll back to any earlier version with one click.

## Troubleshooting

| Problem | Fix |
|---|---|
| Status dot stays yellow / red, no prices | Binance.US only serves the US. Check you're not on a VPN set to another country. Some ad blockers block WebSockets, so try allowing the site. |
| News panel says "unavailable" | Check **Deployments** for a failed build. Make sure the build output directory is `public` (Step 3). |
| Domain shows an error page | Give DNS 15 minutes. Then check **Custom domains** shows "Active". |
| Want to see the site before it updates | Every push also gets its own preview link under **Deployments**. |
