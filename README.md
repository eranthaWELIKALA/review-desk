# Screenshot Review

A small design-review site for GitHub Pages. Your team uploads screenshots into **sections**; clients open a link, enter a review code, and leave feedback **on a section as a whole** or **pinned to an exact spot on a screenshot**. No GitHub account is needed to comment.

Screenshots and comments are stored as files in a GitHub repo, so everything is versioned and you can see who said what in the git history.

```
Clients / team ──► GitHub Pages site (docs/)  ──►  Cloudflare Worker  ──►  GitHub repo
                   static HTML/JS/CSS              holds the token          review-data branch
                                                   checks codes/keys        images/  data/
```

GitHub Pages can only serve static files and can't keep a secret, so a small free **Cloudflare Worker** holds the GitHub token and makes every write on the site's behalf.

## What people can do

| | Clients (review code) | Team (admin key) |
|---|---|---|
| Browse sections and screenshots | ✓ | ✓ |
| Comment on a section, pin comments on a screenshot, reply | ✓ | ✓ |
| Create, rename and delete sections | | ✓ |
| Upload screenshots (button, drag & drop, or paste with Ctrl/⌘+V) | | ✓ |
| Edit captions, delete screenshots | | ✓ |
| Resolve or reopen comments, delete comments | | ✓ |

Other details: links to a single section or screenshot (`Copy link`), arrow keys and Esc in the viewer, Ctrl/⌘+Enter to post, resolved comments hidden by default, works on phones, follows the system's light/dark mode.

## Try it locally first (2 minutes, no accounts)

Requires Node 18+.

```bash
node dev/server.mjs
```

Open http://localhost:8787/?admin and sign in with the key `dev-admin`. Data is saved in `dev/.data/`, laid out exactly as it will be in GitHub. Add `REVIEW_CODE=abc node dev/server.mjs` to try the client code screen.

## Set it up for real

### 1. Create the repos

The simplest setup uses **two repos**:

- **Site repo** (public is fine): this project. GitHub Pages serves its `docs/` folder.
- **Data repo** (**private** recommended): where screenshots and comments go. Client screenshots usually shouldn't be public, and on a free GitHub plan Pages needs the site repo to be public.

Create the data repo on GitHub (it can be empty but must have one commit: tick “Add a README”), then create the data branch:

```bash
git clone https://github.com/<you>/<data-repo>.git && cd <data-repo>
git checkout --orphan review-data
git rm -rf . && git commit --allow-empty -m "Review data"
git push -u origin review-data
```

> You can use one repo for both if it's fine for the screenshots to be public. Point the Worker at the same repo and keep `GITHUB_BRANCH = "review-data"` so uploads don't trigger Pages rebuilds.

### 2. Create a GitHub token

GitHub → Settings → Developer settings → **Fine-grained personal access tokens** → Generate new token:

- Repository access: **Only select repositories** → your data repo
- Permissions → Repository → **Contents: Read and write**

Copy the token.

### 3. Deploy the Worker

Requires a free Cloudflare account.

```bash
cd worker
npm install
npx wrangler login
```

Edit `worker/wrangler.toml`:

```toml
GITHUB_OWNER = "your-username-or-org"
GITHUB_REPO = "your-data-repo"
ALLOWED_ORIGINS = "https://your-username.github.io"
```

Then set the secrets and deploy:

```bash
npx wrangler secret put GITHUB_TOKEN   # paste the token from step 2
npx wrangler secret put ADMIN_KEY      # a long random string for your team
npx wrangler secret put REVIEW_CODE    # optional: code you give clients
npx wrangler deploy
```

`wrangler deploy` prints the Worker URL, e.g. `https://screenshot-review-api.yourname.workers.dev`.

To generate a strong admin key: `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`

### 4. Publish the site

1. Put the Worker URL in `docs/config.js`.
2. Push this project to the site repo.
3. On GitHub: repo → Settings → Pages → Source **Deploy from a branch** → branch `main`, folder **`/docs`** → Save.

After a minute the site is live at `https://<you>.github.io/<site-repo>/`.

### 5. Use it

- **Team:** open `https://<you>.github.io/<site-repo>/?admin`, enter the admin key (remembered on that browser), create sections and upload screenshots.
- **Clients:** send them the site link and the review code, or a link with the code built in: `https://<you>.github.io/<site-repo>/?code=YOUR-CODE`. They type their name once, then comment.

## How data is stored

On the `review-data` branch of the data repo:

```
data/index.json               project title and section order
data/sections/<id>.json       one section: its screenshots and all comments
images/<sectionId>/<id>-<name>.png
```

Every change is a commit (`review: comment by Nimal`, `review: upload login.png to "Onboarding"`), so nothing is ever truly lost: deleted screenshots and comments remain in git history. When two people post at the same moment, the Worker detects the conflict and retries, so no comment is overwritten.

## Settings reference (`worker/wrangler.toml`)

| Name | Kind | Purpose |
|---|---|---|
| `GITHUB_TOKEN` | secret | Fine-grained token with Contents read/write on the data repo |
| `ADMIN_KEY` | secret | Unlocks team features |
| `REVIEW_CODE` | secret, optional | If set, everyone must enter it to view or comment. If not set, anyone with the link can |
| `GITHUB_OWNER`, `GITHUB_REPO` | var | The data repo |
| `GITHUB_BRANCH` | var | Data branch, default `review-data` |
| `ALLOWED_ORIGINS` | var | Your Pages origin(s), comma-separated. `*` allows any site to call the API |
| `PUBLIC_IMAGES` | var | `true` loads images straight from `raw.githubusercontent.com` (public data repo only). `false` streams them through the Worker, which works with private repos |

## Limits worth knowing

- **Image size:** up to 15 MB each (PNG, JPG, GIF, WebP).
- **GitHub API:** a token gets 5,000 requests per hour. Opening the site costs about 1 + (number of sections) requests; each screenshot costs one the first time a browser loads it (then it's cached). That's plenty for a review with a few dozen people, but not for public traffic.
- **Cloudflare Workers free plan:** 100,000 requests per day.
- **Not live-updating:** new comments from others appear when you click **Refresh** or come back to the tab after a minute away.
- **Names are self-declared.** Clients type their own name; the review code is what keeps outsiders out. Rotate it with `npx wrangler secret put REVIEW_CODE` when a review round ends.
- **Repo size:** GitHub recommends keeping repos under ~1 GB. For long-running use, start a fresh data branch per project or archive old ones.

## Development

```bash
cd worker && npm test     # Worker tests against an in-memory fake GitHub
node dev/server.mjs       # whole app locally
```
