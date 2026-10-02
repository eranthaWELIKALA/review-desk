// The only file you need to edit for the site.
window.REVIEW_CONFIG = {
  // URL of your deployed Cloudflare Worker (no trailing slash). If you change it,
  // update the Content-Security-Policy in index.html too.
  apiUrl: 'https://screenshot-review-api.review-desk.workers.dev',
  // Clerk publishable key (public; starts with pk_test_ or pk_live_), from the Clerk
  // dashboard → API keys. Empty turns sign-in off: reviewers and demos still work.
  clerkPublishableKey: '',
};
