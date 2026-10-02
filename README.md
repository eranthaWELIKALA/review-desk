# Review Desk

A design-review site for GitHub Pages. People upload screenshots into **sections**. Reviewers open a link and leave feedback **on a section as a whole** or **pinned to an exact spot on a screenshot**. Reviewers don't need an account.

- **Try it:** anyone can start a private **demo space** (5 MB of storage, deleted after 24 hours) without signing up.
- **Get a space:** people who want to keep using it **request a space**. The site admin approves the request and the owner gets a **space key**.

Everything is stored as files in a private GitHub repo, so it's versioned and you can see who said what in the git history.

```
Browser ──► GitHub Pages site (docs/)  ──►  Cloudflare Worker  ──►  private GitHub repo
            static HTML/JS/CSS              holds the token          review-data branch: spaces, requests
                                            checks keys & codes      demo-data branch: demos (no history)
                                            hourly demo cleanup
```

GitHub Pages can only serve static files and can't keep a secret, so a small free **Cloudflare Worker** holds the GitHub token and makes every write.

## Who can do what

| | Reviewer (review code) | Space owner (space key) | Site admin (admin key) |
|---|---|---|---|
| View screenshots, comment, pin, reply | ✓ | ✓ | ✓ every space |
| Create sections, upload, edit captions, resolve/delete comments | | ✓ | ✓ every space |
| Share the reviewer link, issue a new review code | | ✓ | ✓ |
| Delete the space | | demo only | ✓ |
| Approve/reject requests, create spaces, change storage, issue new space keys | | | ✓ |

- **Space key** (`sk-<space>-…`): the owner's password for one space. It's shown once when the space is created: on the requester's status page and in the admin's "Space keys" dialog.
- **Review code** (`ABCD-EFGH-JKMN`, 12 characters): lets people view and comment. The reviewer link has it built in: `…/review-desk/?code=ABCD-EFGH-JKMN#/<space>`. Spaces created before 12-character codes keep their 8-character code until the owner issues a new one.
- Both are derived from `SPACE_SECRET` (HMAC), so **no key or code is ever stored in the repo**. Issuing a new one invalidates the old one within a minute.
- **Admin sign-in:** the admin key is sent once and exchanged for a **one-hour session** kept only in that browser tab. With `ADMIN_TOTP_SECRET` set, sign-in also needs a code from an authenticator app.

## Security controls

- **Rate limits per visitor (IP):** credential checks (20/min) and writes (30/min). Once a visitor runs out, every guess is refused, right or wrong. Known-good codes don't count.
- **Images** are fetched with a short-lived token (12–24 h) from `/me`, never the review code, so codes don't end up in logs, history or caches. A new review code also cuts off old image links.
- **Uploads** must really be PNG, JPG, GIF or WebP (checked by their first bytes, not the file name). Request bodies are capped while they stream in.
- **Text** has control characters removed; names and titles are kept to one line, and user text in git commit messages is shortened and sanitised.
- **Errors** from the server show only a reference ID (`X-Request-Id`); the details go to the Worker log (`npx wrangler tail`). Admin sign-ins and failed attempts are logged too.
- **Headers:** a Content-Security-Policy on the site (`docs/index.html`; keep its Worker URL in sync with `config.js`), `Referrer-Policy: no-referrer`, and `nosniff`, a strict CSP and HSTS on every API response. CORS allows only `ALLOWED_ORIGINS`.
- **Turnstile** (optional): set `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET` to require an "are you human" check before starting a demo or requesting a space.
- **Not yet:** clickjacking protection (`frame-ancestors`) needs a custom domain, because GitHub Pages can't send headers. Keys and codes in `localStorage` share the `<user>.github.io` origin with your other Pages sites until then.

## Pages

| URL | What |
|---|---|
| `#/` | Home: start a demo, request a space, or paste a key/link |
| `#/<space>` | A space (sections, screenshots, comments) |
| `#/r/<request>` | Status of a space request. Once approved, it shows the space key |
| `#/admin` | Site admin console: requests, spaces, demos |

## Try it locally (2 minutes, no accounts)

Requires Node 18+.

```bash
node dev/server.mjs
```

Open http://localhost:8787. The site admin console is at http://localhost:8787/#/admin, key `dev-admin`. The dev server runs the real Worker against a fake GitHub saved in `dev/.data/`, and runs demo cleanup every minute.

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

### 3. Deploy the Worker

```bash
cd worker
npm install
npx wrangler login
```

Edit `worker/wrangler.toml` (`GITHUB_OWNER`, `GITHUB_REPO`, `ALLOWED_ORIGINS`, demo limits), then:

```bash
npx wrangler secret put GITHUB_TOKEN   # the token from step 2
npx wrangler secret put ADMIN_KEY      # long random string: the site admin key
npx wrangler secret put SPACE_SECRET   # long random string: never share, never change casually
npx wrangler secret put ADMIN_TOTP_SECRET   # optional, recommended: base32 secret for your authenticator app
npx wrangler deploy
```

To generate a random string: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`

To generate a TOTP secret, then add it to your authenticator app as a "setup key" (time-based, 6 digits):
`node -e "const a='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';console.log(Array.from(require('crypto').randomBytes(20),b=>a[b&31]).join(''))"`

### 4. Publish the site

1. Put the Worker URL in `docs/config.js`.
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
| `ADMIN_KEY` | secret | | Site admin sign-in. Changing it signs every admin session out |
| `ADMIN_TOTP_SECRET` | secret | | Optional. Base32; requires an authenticator code at admin sign-in |
| `SPACE_SECRET` | secret | | Derives space keys, review codes, image tokens and the IP salt. Changing it invalidates all of them |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET` | var / secret | | Optional. Turnstile check on demo and space requests |
| `AUTH_LIMIT` / `WRITE_LIMIT` | rate-limit binding | 20 / 30 per min | Per-IP limits. Without the bindings, an in-memory fallback uses `RATE_AUTH_PER_MIN` / `RATE_WRITES_PER_MIN` |
| `GITHUB_OWNER`, `GITHUB_REPO` | var | | The data repo |
| `GITHUB_BRANCH` / `DEMO_BRANCH` | var | `review-data` / `demo-data` | Branches for spaces and demos |
| `ALLOWED_ORIGINS` | var | none (deny) | Your Pages origin(s), comma-separated. `*` only for local dev |
| `DEMO_ENABLED` | var | `true` | Turn demos off with `false` |
| `DEMO_QUOTA_MB` / `DEMO_HOURS` | var | `5` / `24` | Demo storage and lifetime |
| `DEMO_MAX_ACTIVE` | var | `30` | Demo spaces alive at once, across everyone |
| `DEMO_PER_IP_PER_DAY` | var | `3` | Demos one visitor can start per day |
| `SPACE_QUOTA_MB` | var | `200` | Default storage for approved spaces |
| `MAX_PENDING_REQUESTS` | var | `50` | Waiting requests before new ones are refused (max 3 per visitor) |

## Limits worth knowing

- **Images:** up to 15 MB each (PNG, JPG, GIF, WebP). They count toward the space's storage quota.
- **Sections:** up to 40 per space. Opening a space reads every section file, and the Workers free plan allows 50 GitHub calls per request.
- **GitHub API:** 5,000 requests/hour per token. Fine for a few dozen active reviewers, not for public traffic.
- **Cloudflare Workers free plan:** 100,000 requests/day.
- **No email.** The admin sees new requests in the console, and requesters check their status page. The status link is tied to the browser it was sent from, and it can be copied to another device.
- **Names are self-declared.** Reviewers type their own name; the review code is what keeps outsiders out.
- **Abuse:** demos are anonymous. Rate limits use a salted hash of the visitor's IP, kept for one day. For stronger protection, add [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) to the demo button.

## Development

```bash
cd worker && npm test     # Worker tests against an in-memory fake GitHub (dev/fake-github.mjs)
node dev/server.mjs       # whole app locally
```
