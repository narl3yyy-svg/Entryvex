# Putting Entryvex online

Once this is done, you open **https://entryvex.com** (or whichever domain you buy) from any computer or phone. Nothing runs on your PC. Every time new code is pushed to GitHub, the site updates itself within about a minute.

**What you'll use:** [Cloudflare](https://www.cloudflare.com), for both the domain and the hosting.

- Hosting on Cloudflare Pages is **free**: unlimited visitors, plus 100,000 news requests per day on the free plan, far more than you need.
- Domains are sold **at cost** with no markup and free privacy protection. Check the exact price at checkout. Roughly:
  - **.com** about $10–11/year (recommended: it's what people type by default)
  - **.xyz** about $10–15/year
  - **.io** about $50–60/year

Total cost: **about $10–11 a year** for a .com. Everything else is free.

> Before buying, it's worth running the name through the official [USPTO trademark search](https://tmsearch.uspto.gov/) one more time.

---

## Step 1: Create a Cloudflare account (5 min)

1. Go to **https://dash.cloudflare.com/sign-up** and sign up with your email.
2. Verify your email.
3. Turn on two-factor login: profile icon (top right) → **My Profile** → **Authentication** → **Two-Factor Authentication**. Your domain lives here, so protect it.

## Step 2: Buy the domain (5 min)

1. In the Cloudflare dashboard's left menu, open **Domain Registration** → **Register Domains**.
2. Search for `entryvex`.
3. Pick **entryvex.com**. Optionally also grab `.io` / `.xyz` so nobody else can take them; they can just point to the same site.
4. Turn **auto-renew** ON so you never lose it.
5. Fill in the contact details and pay. Cloudflare keeps your personal details private in the public WHOIS lookup.

The domain shows up under **Websites** (or **Domains**) in the dashboard after a few minutes.

## Step 3: Connect the GitHub repo to Cloudflare Pages (5 min)

1. Left menu → **Workers & Pages** → **Create application**.
2. Choose the **Pages** option, then **Import an existing Git repository** (labeled "Connect to Git" on some screens).
   - If you only see Workers options, look for the link **"Looking to deploy Pages? Get started"** at the bottom.
3. Click **Connect GitHub**. On GitHub's permission screen, choose **Only select repositories** → **narl3yyy-svg/Entryvex** → **Install & Authorize**.
4. Back in Cloudflare, select **Entryvex** → **Begin setup**.
5. Fill in the build settings exactly like this:

   | Setting | Value |
   |---|---|
   | Project name | `entryvex` |
   | Production branch | `main` |
   | Framework preset | **None** |
   | Build command | *(leave empty)* |
   | Build output directory | `public` |

6. Click **Save and Deploy**. It takes about a minute.
7. When it finishes, you get a free link like **https://entryvex.pages.dev**. Open it: you should see live prices, the chart and news.

## Step 4: Attach your domain (2 min)

1. In **Workers & Pages** → **entryvex** → the **Custom domains** tab → **Set up a custom domain**.
2. Type `entryvex.com` → **Continue** → **Activate domain**. Because the domain is already in Cloudflare, it sets up the DNS and the HTTPS certificate for you.
3. Repeat for `www.entryvex.com`.
4. Wait about 5–15 minutes, then open **https://entryvex.com**. 🎉

If you bought .io or .xyz too, add them the same way.

## Step 5 (optional but recommended): make it private

Right now anyone who finds the URL can use the site. To restrict it to just you (and anyone you invite):

1. Left menu → **Zero Trust** (free for up to 50 users; pick the **Free** plan when asked, no card charge).
2. **Access** → **Applications** → **Add an application** → **Self-hosted**.
3. Application domain: `entryvex.com` (add `www.entryvex.com` and `entryvex.pages.dev` too).
4. Add a policy: **Action: Allow**, **Include → Emails →** your email address.
5. Save. Visiting the site now asks for your email and sends you a one-time login code.

---

## How updates work from now on

```
code pushed to GitHub (main)  →  Cloudflare rebuilds automatically  →  entryvex.com updated (~1 min)
```

You can watch each deploy under **Workers & Pages → entryvex → Deployments**, and roll back to any earlier version with one click.

## Troubleshooting

| Problem | Fix |
|---|---|
| Status dot stays yellow / red, no prices | Binance.US only serves the US. Check you're not on a VPN set to another country. Some ad blockers block WebSockets, so try allowing the site. |
| News panel says "unavailable" | Check **Deployments** for a failed build. Make sure the build output directory is `public` (Step 3). |
| Domain shows an error page | Give DNS 15 minutes. Then check **Custom domains** shows "Active". |
| Want to see the site before it updates | Every push also gets its own preview link under **Deployments**. |
