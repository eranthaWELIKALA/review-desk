# Review Desk

A design-review site for GitHub Pages. People upload screenshots into **sections**. Reviewers open a link and leave feedback **on a section as a whole** or **pinned to an exact spot on a screenshot**. Reviewers don't need an account.

- **Try it:** anyone can start a private **demo space** (5 MB of storage, deleted after 24 hours) without signing up.
- **Get a space:** signed-in people **request a space**. When the site admin approves it, they become its **owner** and get an email.
- **Work as a team:** owners invite **editors** and other owners by email. Reviewers get the review link, by email or copied, and can comment with or without an account.

Sign-in is handled by [Clerk](https://clerk.com): Google, GitHub, Microsoft or an email link. Screenshots and comments are stored as files in a private GitHub repo, so they're versioned. Accounts, team members, invites and an audit log live in Cloudflare D1.

```
Browser ──► GitHub Pages site (docs/)  ──►  Cloudflare Worker  ──►  private GitHub repo
            static HTML/JS/CSS              verifies Clerk tokens    review-data: spaces, requests
            Clerk sign-in                   checks roles & codes     demo-data: demos (no history)
                                            sends email (Resend)
                                            hourly cleanup      ──►  D1: users, members, invites,
                                                                     email log, audit log
```

GitHub Pages can only serve static files and can't keep a secret, so a small **Cloudflare Worker** holds the GitHub token, checks who you are and makes every write.

## Who can do what

| | Reviewer (review link) | Editor | Owner | Site admin |
|---|---|---|---|---|
| View screenshots, comment, pin, reply | ✓ | ✓ | ✓ | ✓ every space |
| Create sections, upload, edit captions, resolve/delete comments | | ✓ | ✓ | ✓ |
| Share the review link, email it, issue a new review code | | ✓ | ✓ | ✓ |
| Invite editors and owners, change roles, remove members | | | ✓ | ✓ |
| Delete the space | | | demo only | ✓ |
| Approve/reject requests, create spaces, change storage, see the audit log | | | | ✓ |

- **Owners and editors** are accounts. A space always keeps at least one owner. Invites are **single-use**, expire after **7 days** and only work for the **email address they were sent to**: a forwarded invite is useless to anyone else.
- **Review code** (`ABCD-EFGH-JKMN`): anyone with the review link (`…/review-desk/?code=ABCD-EFGH-JKMN#/<space>`) can view and comment. They don't need an account. Signed-in reviewers comment under their account name, which gets a ✓ so it can't be impersonated.
- **Site admins** are accounts whose email is in `SITE_ADMIN_EMAILS`. With `ADMIN_REQUIRE_MFA=true` they must turn on **two-step verification** in Clerk, which needs Clerk's Pro plan. This deployment sets it to `false`, so admin access is only as strong as the admin email account: turn on that account's own two-step verification (e.g. Google 2-Step Verification), since every sign-in method, including email links and codes, goes through it.
- **Demos** stay account-free: the browser that started one holds its space key. Demos can't have editors or send email.
- **Spaces from before accounts** still have a **space key**. A signed-in key holder can claim the space once (**Make your account the owner**). The key then stops working. Set `LEGACY_SPACE_KEYS=false` when everyone has moved over.
- Keys and codes are derived from `SPACE_SECRET` (HMAC), so **no key or code is ever stored in the repo**. Issuing a new one invalidates the old one within a minute.

## Security controls

- **Sign-in tokens:** every API call carries a Clerk session token that lasts 60 seconds. The Worker checks its RS256 signature against Clerk's public key, its issuer (`CLERK_ISSUER`), its `azp` (the site origin, from `ALLOWED_ORIGINS`), expiry and status. The site never stores a password or long-lived key.
- **Rate limits per visitor (IP):** credential checks (20/min) and writes (30/min). Once a visitor runs out, every guess is refused, right or wrong. Known-good codes don't count.
- **Email limits:** at most `EMAIL_DAILY_LIMIT` emails a day in total (default 90; Resend's free plan allows 100), 5 per recipient and 30 per space. Only signed-in owners and editors can send, so every email says who sent it. If email is off, fails or hits a limit, the sender gets the link to share themselves. Names and titles in emails are escaped.
- **Audit log** (D1, kept a year, **Site admin → Activity**): approvals, space creation and deletion, key views and rotations, claims, invites (sent, accepted, cancelled, wrong account) and member changes, with the account, a keyed IP hash and the request ID.
- **Images** are fetched with a short-lived token (12–24 h) from `/me`, never the review code. A new review code also cuts off old image links.
- **Uploads** must really be PNG, JPG, GIF or WebP (checked by their first bytes). Request bodies are capped while they stream in.
- **Text** has control characters removed. Names and titles are kept to one line, and user text in git commit messages is shortened and sanitised.
- **Errors** show only a reference ID (`X-Request-Id`); the details go to the Worker log (`npx wrangler tail`).
- **Headers:** a Content-Security-Policy on the site (`docs/index.html`; keep its Worker and Clerk hosts in sync with `config.js`), `Referrer-Policy: no-referrer`, and `nosniff`, a strict CSP and HSTS on every API response. CORS allows only `ALLOWED_ORIGINS`.
- **Turnstile** (optional): an "are you human" check before starting a demo. Clerk has its own bot protection for sign-ups.
- **Not yet, needs a custom domain:**
  - Clerk production mode. A development instance allows 100 users and shows a banner.
  - Email to anyone. Without a verified domain, Resend only delivers to your own address.
  - Clickjacking protection (`frame-ancestors`).
  - Isolation from your other `<user>.github.io` Pages sites.

## Pages

| URL | What |
|---|---|
| `#/` | Home: your spaces and requests, start a demo, request a space, open a link |
| `#/<space>` | A space (sections, screenshots, comments) |
| `#/invite` | Accept an invite to own or edit a space |
| `#/admin` | Site admin console: requests, spaces, demos, activity |
| `#/r/<request>` | Status of a request made before accounts |
| `help/` | Help: illustrated tutorials for every feature (static page, no scripts) |

## Try it locally (2 minutes, no accounts)

Requires Node 22.5+ (for the built-in SQLite).

```bash
node dev/server.mjs
```

Open http://localhost:8787 and click **Sign in**: the dev server has a stand-in for Clerk that asks for any email address. Sign in as `admin@dev.local` and say yes to two-step verification to use the admin console at `#/admin`. Emails are printed in the terminal instead of being sent. The dev server runs the real Worker against a fake GitHub and a SQLite file in `dev/.data/`, and runs cleanup every minute.

## Set it up for real

### 1. Repos

- **Site repo** (public): this project. GitHub Pages serves its `docs/` folder.
- **Data repo** (**private**): screenshots, comments and space requests. It needs a `review-data` branch:

```bash
git clone https://github.com/<you>/<data-repo>.git && cd <data-repo>
git checkout --orphan review-data
git rm -rf . && git commit --allow-empty -m "Review data"
git push -u origin review-data
```

The Worker creates the `demo-data` branch itself.

### 2. GitHub token

GitHub → Settings → Developer settings → **Fine-grained personal access tokens**:

- Repository access: **Only select repositories** → the data repo
- Permissions → Repository → **Contents: Read and write** (GitHub adds Metadata: Read-only automatically)

### 3. Sign-in (Clerk)

1. Create an application at [clerk.com](https://clerk.com). Under **User & authentication**, turn on **Email** (with the **email link** or code), and under **SSO connections** turn on **Google**, **GitHub** and **Microsoft**. Development instances use Clerk's shared OAuth credentials, so there's nothing else to set up yet.
2. Optional, Clerk Pro plan only: turn on **Multi-factor** (authenticator app) and set `ADMIN_REQUIRE_MFA = "true"` so site admins must use two-step verification. On the free plan, leave it `false` and protect the admin email account with its own two-step verification.
3. **Sessions → Customize session token**, add these claims (the Worker needs the email address):
   ```json
   { "email": "{{user.primary_email_address}}", "name": "{{user.full_name}}" }
   ```
4. **Domains → Allowed origins:** your Pages origin, e.g. `https://<you>.github.io`.
5. From **API keys**, copy:
   - the **Publishable key** (`pk_test_…`, public) into `docs/config.js` as `clerkPublishableKey`;
   - the **Frontend API URL** (`https://<name>.clerk.accounts.dev`) into `worker/wrangler.toml` as `CLERK_ISSUER`.
6. In `docs/index.html`, the CSP already allows `*.clerk.accounts.dev`. With a production instance later, replace it with `clerk.<your domain>`.

### 4. Email (Resend, optional)

Create an account at [resend.com](https://resend.com) and an API key with **Sending access** only. Until you verify a domain there, Resend only delivers to your own account's address, so invites to anyone else fall back to a copyable link. Once a domain is verified, set `EMAIL_FROM` to an address on it.

### 5. Deploy the Worker

```bash
cd worker
npm install
npx wrangler login
npx wrangler d1 create review-desk          # paste the database_id into wrangler.toml
npx wrangler d1 migrations apply review-desk --remote
```

Edit `worker/wrangler.toml` (`GITHUB_OWNER`, `GITHUB_REPO`, `ALLOWED_ORIGINS`, `SITE_URL`, `CLERK_ISSUER`, `EMAIL_FROM`, demo limits), then:

```bash
npx wrangler secret put GITHUB_TOKEN        # the token from step 2
npx wrangler secret put SPACE_SECRET        # long random string: never share, never change casually
npx wrangler secret put SITE_ADMIN_EMAILS   # your email address (comma-separate several)
npx wrangler secret put RESEND_API_KEY      # optional, from step 4
npx wrangler secret put TURNSTILE_SECRET    # optional: Cloudflare → Turnstile → your widget's secret key
npx wrangler deploy
```

To generate a random string: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`

For Turnstile, also set `TURNSTILE_SITE_KEY` (public) in `wrangler.toml`. For local testing, Cloudflare's test keys always pass: site key `1x00000000000000000000AA`, secret `1x0000000000000000000000000000000AA`.

### 6. Publish the site

1. Put the Worker URL and the Clerk publishable key in `docs/config.js`.
2. Push to the site repo.
3. Repo → Settings → Pages → **Deploy from a branch** → `main`, folder **`/docs`**.

## How data is stored

```
review-data branch
  registry/spaces.json               approved spaces (title, owner name, email)
  registry/requests.json             requests (name, email, organization, purpose, status)
  spaces/<id>/index.json             title, section order, storage used/quota, key versions
  spaces/<id>/sections/<sid>.json    a section: its screenshots and comments
  spaces/<id>/images/<sid>/<file>    screenshots

demo-data branch                     same layout for demos, plus registry/demos.json
```

Every change in a space is a commit (`review: comment by Nimal`). When two people post at once, the Worker detects the conflict and retries.

**Deleting is real for demos and not for spaces.** When the hourly cleanup removes expired demos, it rewrites the `demo-data` branch as a single commit with no history, so those screenshots can't be reached in git anymore. GitHub garbage-collects the unreachable objects later. Deleting an approved space or a section removes the files from the branch, but they **stay in the `review-data` git history**. To purge them for good, rewrite that branch's history (e.g. `git filter-repo`) and force-push.

## Settings (`worker/wrangler.toml`)

| Name | Kind | Default | Purpose |
|---|---|---|---|
| `GITHUB_TOKEN` | secret | | Fine-grained token, Contents read/write on the data repo |
| `SPACE_SECRET` | secret | | Derives space keys, review codes, image tokens and IP/email hashes. Changing it invalidates all of them |
| `SITE_ADMIN_EMAILS` | secret | | Comma-separated admin emails (a secret so they aren't public in this repo) |
| `RESEND_API_KEY` | secret | | Optional. Without it, invites give a link to share yourself |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET` | var / secret | | Optional. Turnstile check before starting a demo |
| `DB` | D1 binding | | Users, members, invites, email log, audit log |
| `CLERK_ISSUER` | var | | Clerk Frontend API URL; tokens must come from it |
| `CLERK_JWT_KEY` | var | | Optional. Clerk's PEM public key, to skip fetching its JWKS |
| `SITE_URL` | var | | The site's address, for links in emails |
| `ADMIN_REQUIRE_MFA` | var | `true` (`false` in this repo's `wrangler.toml`) | Site admins need two-step verification in Clerk (Clerk Pro plan) |
| `LEGACY_SPACE_KEYS` | var | `true` | Space keys of pre-account spaces still allow editing |
| `EMAIL_FROM` / `EMAIL_DAILY_LIMIT` | var | `onboarding@resend.dev` / `90` | Sender and daily cap |
| `GITHUB_OWNER`, `GITHUB_REPO` | var | | The data repo |
| `GITHUB_BRANCH` / `DEMO_BRANCH` | var | `review-data` / `demo-data` | Branches for spaces and demos |
| `ALLOWED_ORIGINS` | var | none (deny) | Your Pages origin(s), comma-separated; also checked against the token's `azp`. `*` only for local dev |
| `AUTH_LIMIT` / `WRITE_LIMIT` | rate-limit binding | 20 / 30 per min | Per-IP limits. Without the bindings, an in-memory fallback uses `RATE_AUTH_PER_MIN` / `RATE_WRITES_PER_MIN` |
| `DEMO_ENABLED` | var | `true` | Turn demos off with `false` |
| `DEMO_QUOTA_MB` / `DEMO_HOURS` | var | `5` / `24` | Demo storage and lifetime |
| `DEMO_MAX_ACTIVE` | var | `30` | Demo spaces alive at once, across everyone |
| `DEMO_PER_IP_PER_DAY` | var | `3` | Demos one visitor can start per day |
| `SPACE_QUOTA_MB` | var | `200` | Default storage for approved spaces |
| `MAX_PENDING_REQUESTS` | var | `50` | Waiting requests before new ones are refused (max 3 per account) |

## Limits worth knowing

- **Images:** up to 15 MB each (PNG, JPG, GIF, WebP). They count toward the space's storage quota.
- **Sections:** up to 40 per space. Opening a space reads every section file, and the Workers free plan allows 50 GitHub calls per request.
- **GitHub API:** 5,000 requests/hour per token. Fine for a few dozen active reviewers, not for public traffic.
- **Cloudflare Workers free plan:** 100,000 requests/day.
- **Email:** Resend's free plan sends 100 a day. New requests don't email the admin; they show up in the console.
- **Names are self-declared.** Reviewers type their own name; the review code is what keeps outsiders out.
- **Abuse:** demos are anonymous. Rate limits use a salted hash of the visitor's IP, kept for one day. For stronger protection, add [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) to the demo button.

## Development

```bash
cd worker && npm test     # Worker tests against an in-memory fake GitHub (dev/fake-github.mjs)
node dev/server.mjs       # whole app locally
```
