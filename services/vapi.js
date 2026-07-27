// Thin read-only client for the Vapi REST API.
//
// Why this exists: Vapi moved call recordings onto a PRIVATE Cloudflare R2 bucket,
// so the `artifact.recordingUrl` handed to us on the end-of-call webhook is not
// fetchable — it answers 400 InvalidArgument/Authorization. The usable link is
// `artifact.presignedMonoUrl`, which expires ~30 minutes after Vapi mints it.
// A recording link therefore can never be baked into a Slack card or a page; it
// has to be resolved on demand, which is what getRecordingUrl() is for.
const API_BASE = 'https://api.vapi.ai';
const TIMEOUT_MS = 8000;

async function getCall(callId) {
  const key = process.env.VAPI_API_KEY;
  if (!key) throw new Error('VAPI_API_KEY not set');
  const r = await fetch(`${API_BASE}/call/${encodeURIComponent(callId)}`, {
    headers: { Authorization: 'Bearer ' + key },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!r.ok) throw new Error('Vapi API returned ' + r.status);
  return r.json();
}

// Fresh, signed, ~30-minute audio URL for a call — or null if there is no recording.
async function getRecordingUrl(callId) {
  const call = await getCall(callId);
  const a = call.artifact || {};
  return a.presignedMonoUrl || a.presignedStereoUrl || null;
}

// Flatten a Vapi call into the handful of fields the admin UI actually renders.
function normalizeCall(call) {
  const a = call.artifact || {};
  const startedAt = call.startedAt ? new Date(call.startedAt) : null;
  const endedAt = call.endedAt ? new Date(call.endedAt) : null;
  return {
    id: call.id,
    caller: (call.customer && call.customer.number) || null,
    startedAt,
    endedAt,
    durationSec: (startedAt && endedAt) ? Math.round((endedAt - startedAt) / 1000) : null,
    endedReason: call.endedReason || null,
    cost: call.cost != null ? Number(call.cost) : null,
    summary: (call.analysis && call.analysis.summary) || call.summary || null,
    transcript: a.transcript || call.transcript || null,
    successEvaluation: (call.analysis && call.analysis.successEvaluation) || null,
    // Signed and short-lived — never persist or hand this to Slack, link the proxy instead.
    recordingUrl: a.presignedMonoUrl || a.presignedStereoUrl || null,
    hasRecording: !!(a.presignedMonoUrl || a.presignedStereoUrl || a.recordingUrl || call.recordingUrl)
  };
}

// Seconds -> "1m 46s" / "42s". Shared by the Slack card and the admin views.
function formatDuration(sec) {
  if (sec == null) return 'unknown';
  return sec >= 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec}s`;
}

// ── Signed, login-free recording links for Slack cards ──────────────────────
// The call cards are read on a phone, and an admin session only lasts 24h, so a link
// behind requireAuth means logging in almost every time. Instead the card carries an
// unguessable HMAC tied to that one call id and an expiry. It grants access to exactly
// one recording and nothing else in admin. 14 days matches Vapi's retention window —
// past that the audio no longer exists to serve.
const crypto = require('crypto');
const LINK_TTL_DAYS = 14;

function signingSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET not set — cannot sign recording links');
  return s;
}

function recordingSignature(callId, exp) {
  return crypto.createHmac('sha256', signingSecret()).update(`recording:${callId}:${exp}`).digest('hex');
}

function signedRecordingUrl(callId, baseUrl) {
  const exp = Math.floor(Date.now() / 1000) + LINK_TTL_DAYS * 86400;
  const sig = recordingSignature(callId, exp);
  return `${baseUrl}/api/call/recording/${encodeURIComponent(callId)}?e=${exp}&s=${sig}`;
}

function verifyRecordingSignature(callId, exp, sig) {
  const e = Number(exp);
  if (!e || !sig || Number.isNaN(e)) return false;
  if (Math.floor(Date.now() / 1000) > e) return false;
  const expected = recordingSignature(callId, String(exp));
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

module.exports = { getCall, getRecordingUrl, normalizeCall, formatDuration, signedRecordingUrl, verifyRecordingSignature };
