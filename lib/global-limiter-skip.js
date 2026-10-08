'use strict';

// Shared by server.js's site-wide /api rate limiter. Extracted so it's unit-testable
// without booting the whole app (server.js calls app.listen() and starts schedulers at
// module load, so it can't safely be required from a test process).
//
// M7: the office API has its own per-key limiters (middleware/office-auth.js) plus a
// pre-auth per-IP limiter on failed attempts — it must be exempt from the public-facing
// site-wide limiter, same as /sarah and /webhooks.
function shouldSkipGlobalLimiter(path) {
  return path.startsWith('/sarah') || path.startsWith('/webhooks') || path.startsWith('/office');
}

module.exports = { shouldSkipGlobalLimiter };
