'use strict';

const { google } = require('googleapis');
const { getDb } = require('../db');

const CLIENT_ID = process.env.GOOGLE_ADS_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_ADS_CLIENT_SECRET;
const DEVELOPER_TOKEN = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
const CUSTOMER_ID = process.env.GOOGLE_ADS_CUSTOMER_ID; // no dashes
const MCC_ID = process.env.GOOGLE_ADS_MCC_ID;           // no dashes
const REDIRECT_URI = process.env.GOOGLE_ADS_REDIRECT_URI;
const API_VERSION = process.env.GOOGLE_ADS_API_VERSION || 'v23'; // bump when Google sunsets a version
const SCOPES = ['https://www.googleapis.com/auth/adwords'];

function getOAuth2Client() {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
}

function getStoredTokens() {
  const db = getDb();
  const rows = db.prepare("SELECT key, value FROM ad_config WHERE platform = 'google'").all();
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    refresh_token: map.refresh_token || null,
    access_token: map.access_token || null,
    expiry_date: map.token_expiry ? parseInt(map.token_expiry, 10) : null,
  };
}

function storeTokens({ refresh_token, access_token, expiry_date }) {
  const db = getDb();
    const del = db.prepare("DELETE FROM ad_config WHERE platform = 'google' AND key = ?");
  const ins = db.prepare("INSERT INTO ad_config (id, platform, key, value) VALUES (lower(hex(randomblob(16))), 'google', ?, ?)");
  if (refresh_token) { del.run('refresh_token'); ins.run('refresh_token', refresh_token); }
  if (access_token)  { del.run('access_token');  ins.run('access_token',  access_token);  }
  if (expiry_date)   { del.run('token_expiry');  ins.run('token_expiry',  String(expiry_date)); }
}

// ── Public API ────────────────────────────────────────────────────────────────

function getAuthUrl() {
  const oauth2 = getOAuth2Client();
  return oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });
}

async function handleCallback(code) {
  const oauth2 = getOAuth2Client();
  const { tokens } = await oauth2.getToken(code);
  storeTokens({
    refresh_token: tokens.refresh_token,
    access_token:  tokens.access_token,
    expiry_date:   tokens.expiry_date,
  });
  return tokens;
}

async function getAccessToken() {
  const stored = getStoredTokens();
  if (!stored.refresh_token) throw new Error('Google Ads not connected — no refresh token');

  const oauth2 = getOAuth2Client();
  oauth2.setCredentials(stored);

  const now = Date.now();
  if (stored.access_token && stored.expiry_date && stored.expiry_date > now + 60000) {
    return stored.access_token;
  }

  const { credentials } = await oauth2.refreshAccessToken();
  storeTokens({
    refresh_token: credentials.refresh_token || stored.refresh_token,
    access_token:  credentials.access_token,
    expiry_date:   credentials.expiry_date,
  });
  return credentials.access_token;
}

function isConnected() {
  const { refresh_token } = getStoredTokens();
  return !!refresh_token;
}

async function adsRequest(query) {
  const token = await getAccessToken();
  const url = `https://googleads.googleapis.com/${API_VERSION}/customers/${CUSTOMER_ID}/googleAds:search`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'developer-token': DEVELOPER_TOKEN,
      'login-customer-id': CUSTOMER_ID, // direct access to advertiser; MCC does not manage it
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google Ads API error ${res.status}: ${err}`);
  }
  return res.json();
}

async function getCampaigns() {
  const data = await adsRequest(`
    SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
           campaign_budget.amount_micros
    FROM campaign
    WHERE campaign.status != 'REMOVED'
    ORDER BY campaign.name
  `);
  return (data.results || []).map(r => ({
    id: r.campaign.id,
    name: r.campaign.name,
    status: r.campaign.status,
    type: r.campaign.advertisingChannelType,
    daily_budget_micros: r.campaignBudget?.amountMicros,
    daily_budget: r.campaignBudget?.amountMicros ? (r.campaignBudget.amountMicros / 1e6).toFixed(2) : null,
  }));
}

async function getCampaignPerformance(campaignId, dateRange = 'LAST_30_DAYS') {
  const data = await adsRequest(`
    SELECT campaign.id, campaign.name,
           metrics.impressions, metrics.clicks, metrics.cost_micros,
           metrics.conversions, metrics.ctr, metrics.average_cpc
    FROM campaign
    WHERE campaign.id = ${campaignId}
    AND segments.date DURING ${dateRange}
  `);
  const r = (data.results || [])[0];
  if (!r) return null;
  return {
    impressions: r.metrics?.impressions || 0,
    clicks: r.metrics?.clicks || 0,
    spend: r.metrics?.costMicros ? (r.metrics.costMicros / 1e6).toFixed(2) : '0.00',
    conversions: r.metrics?.conversions || 0,
    ctr: r.metrics?.ctr ? (r.metrics.ctr * 100).toFixed(2) + '%' : '0%',
    avg_cpc: r.metrics?.averageCpc ? (r.metrics.averageCpc / 1e6).toFixed(2) : '0.00',
  };
}

async function createCampaign(data) {
  // Note: With a test developer token, campaign creation requires a test account.
  // This is a placeholder that returns a structured error when in test mode.
  throw new Error('Campaign creation requires a standard access developer token. Use the Google Ads UI to create campaigns, then sync them here.');
}

async function updateCampaignStatus(campaignId, status) {
  const token = await getAccessToken();
  const url = `https://googleads.googleapis.com/${API_VERSION}/customers/${CUSTOMER_ID}/campaigns:mutate`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'developer-token': DEVELOPER_TOKEN,
      'login-customer-id': CUSTOMER_ID, // direct access to advertiser; MCC does not manage it
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      operations: [{
        update: { resourceName: `customers/${CUSTOMER_ID}/campaigns/${campaignId}`, status },
        updateMask: 'status',
      }],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google Ads mutate error ${res.status}: ${err}`);
  }
  return res.json();
}

async function updateCampaignBudget(campaignId, budgetDollars) {
  const token = await getAccessToken();
  // First, get the budget resource name for this campaign
  const data = await adsRequest(`
    SELECT campaign.id, campaign.campaign_budget
    FROM campaign
    WHERE campaign.id = ${campaignId}
  `);
  const budgetResource = (data.results || [])[0]?.campaign?.campaignBudget;
  if (!budgetResource) throw new Error('Campaign budget resource not found');

  const url = `https://googleads.googleapis.com/${API_VERSION}/customers/${CUSTOMER_ID}/campaignBudgets:mutate`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'developer-token': DEVELOPER_TOKEN,
      'login-customer-id': CUSTOMER_ID, // direct access to advertiser; MCC does not manage it
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      operations: [{
        update: { resourceName: budgetResource, amountMicros: Math.round(parseFloat(budgetDollars) * 1e6) },
        updateMask: 'amount_micros',
      }],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google Ads budget update error ${res.status}: ${err}`);
  }
  return res.json();
}

/**
 * Offline conversion import.
 *
 * The browser tag on the confirmation page only fires if the customer actually lands
 * there — anyone who pays and closes the tab is invisible to it. We capture `gclid`
 * at first touch and know exactly when a deposit clears, so upload it server-side
 * instead of hoping for a page view.
 *
 * The target action MUST have been created with type UPLOAD_CLICKS ("Import — from
 * clicks"); Google rejects uploads against a WEBPAGE action.
 *
 * `orderId` is the booking number so repeat uploads of the same booking collapse
 * into one conversion rather than stacking up.
 *
 * @param {string} gclid        click ID captured at first touch
 * @param {string} bookingNumber used as orderId for dedupe
 * @param {number} value        conversion value in dollars
 * @param {Date|string} when    when the conversion happened (defaults to now)
 */
async function uploadClickConversion(gclid, bookingNumber, value, when) {
  if (!gclid) return { skipped: 'no gclid' };
  const actionId = process.env.GOOGLE_ADS_CONVERSION_ACTION_ID;
  if (!actionId) return { skipped: 'GOOGLE_ADS_CONVERSION_ACTION_ID not set' };

  // Google requires "yyyy-mm-dd hh:mm:ss+|-hh:mm" — the offset is NOT optional.
  const d = when ? new Date(when) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const conversionDateTime =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;

  const token = await getAccessToken();
  const url = `https://googleads.googleapis.com/${API_VERSION}/customers/${CUSTOMER_ID}:uploadClickConversions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'developer-token': DEVELOPER_TOKEN,
      'login-customer-id': CUSTOMER_ID,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      conversions: [{
        gclid,
        conversionAction: `customers/${CUSTOMER_ID}/conversionActions/${actionId}`,
        conversionDateTime,
        conversionValue: Number(value) || 0,
        currencyCode: 'USD',
        orderId: String(bookingNumber || ''),
      }],
      partialFailure: true,   // one bad row must not reject the batch
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Google Ads conversion upload ${res.status}: ${JSON.stringify(body).slice(0, 400)}`);
  }
  if (body.partialFailureError) {
    const msg = JSON.stringify(body.partialFailureError);
    // Google closed ConversionUploadService to new integrations in favour of the Data
    // Manager API. This account is not an existing user of it, so every upload is
    // rejected on those grounds — not because of anything in the payload. Return a
    // skip rather than throwing, so a real booking does not log an error it cannot fix.
    // Verified 2026-08-03. To actually ship offline import, port this to the Data
    // Manager API; the gclid is already captured on every booking, so the data is there.
    if (/Data Manager API|limited to existing users/i.test(msg)) {
      return { skipped: 'ConversionUploadService is closed to new integrations — needs the Data Manager API' };
    }
    throw new Error(`Google Ads partial failure: ${msg.slice(0, 400)}`);
  }
  return body;
}

module.exports = { getAuthUrl, handleCallback, getAccessToken, isConnected, getCampaigns, getCampaignPerformance, createCampaign, updateCampaignStatus, updateCampaignBudget, uploadClickConversion };
