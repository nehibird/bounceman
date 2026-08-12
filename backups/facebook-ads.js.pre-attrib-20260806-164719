'use strict';

const FB_APP_ID      = process.env.FB_APP_ID;
const FB_APP_SECRET  = process.env.FB_APP_SECRET;
const FB_AD_ACCOUNT  = process.env.FB_AD_ACCOUNT_ID; // act_XXXXXXXXXX
const FB_PIXEL_ID    = process.env.FB_PIXEL_ID;
const FB_ACCESS_TOKEN = process.env.FB_ACCESS_TOKEN;
const FB_API_BASE    = 'https://graph.facebook.com/v22.0';

async function fbGet(path, params = {}) {
  const qs = new URLSearchParams({ access_token: FB_ACCESS_TOKEN, ...params }).toString();
  const res = await fetch(`${FB_API_BASE}${path}?${qs}`);
  const data = await res.json();
  if (data.error) throw new Error(`FB API error: ${data.error.message} (code ${data.error.code})`);
  return data;
}

async function fbPost(path, body = {}) {
  const res = await fetch(`${FB_API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: FB_ACCESS_TOKEN, ...body }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`FB API error: ${data.error.message} (code ${data.error.code})`);
  return data;
}

async function isConnected() {
  try {
    await fbGet('/me', { fields: 'id,name' });
    return true;
  } catch {
    return false;
  }
}

async function getTokenInfo() {
  try {
    const data = await fbGet('/debug_token', {
      input_token: FB_ACCESS_TOKEN,
      access_token: `${FB_APP_ID}|${FB_APP_SECRET}`,
    });
    const info = data.data || {};
    return {
      valid: info.is_valid,
      expires_at: info.expires_at ? new Date(info.expires_at * 1000).toISOString() : null,
      scopes: info.scopes || [],
      app_id: info.app_id,
    };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

async function getTokenExpiry() {
  const info = await getTokenInfo();
  return info.expires_at;
}

async function getCampaigns() {
  const data = await fbGet(`/${FB_AD_ACCOUNT}/campaigns`, {
    fields: 'id,name,status,daily_budget,lifetime_budget,objective,created_time,updated_time',
    limit: '100',
  });
  return (data.data || []).map(c => ({
    id: c.id,
    name: c.name,
    status: c.status,
    daily_budget: c.daily_budget ? (parseInt(c.daily_budget, 10) / 100).toFixed(2) : null,
    lifetime_budget: c.lifetime_budget ? (parseInt(c.lifetime_budget, 10) / 100).toFixed(2) : null,
    objective: c.objective,
    created_time: c.created_time,
  }));
}

async function getCampaignPerformance(campaignId, dateRange = { since: null, until: null }) {
  const params = {
    fields: 'campaign_id,campaign_name,impressions,clicks,spend,actions,cpc,ctr,reach',
    level: 'campaign',
  };
  if (dateRange.since && dateRange.until) {
    params.time_range = JSON.stringify({ since: dateRange.since, until: dateRange.until });
  } else {
    params.date_preset = 'last_30d';
  }
  const data = await fbGet(`/${campaignId}/insights`, params);
  const r = (data.data || [])[0];
  if (!r) return { impressions: 0, clicks: 0, spend: '0.00', conversions: 0, ctr: '0%', cpc: '0.00' };
  const purchases = (r.actions || []).find(a => a.action_type === 'purchase');
  return {
    impressions: parseInt(r.impressions || '0', 10),
    clicks: parseInt(r.clicks || '0', 10),
    spend: parseFloat(r.spend || '0').toFixed(2),
    conversions: purchases ? parseInt(purchases.value, 10) : 0,
    ctr: r.ctr ? (parseFloat(r.ctr)).toFixed(2) + '%' : '0%',
    cpc: r.cpc ? parseFloat(r.cpc).toFixed(2) : '0.00',
    reach: parseInt(r.reach || '0', 10),
  };
}

async function createCampaign(data) {
  // 1. Create Campaign
  const campaign = await fbPost(`/${FB_AD_ACCOUNT}/campaigns`, {
    name: data.name,
    objective: data.objective || 'OUTCOME_TRAFFIC',
    status: 'PAUSED',
    special_ad_categories: [],
  });

  // 2. Create Ad Set
  const adSet = await fbPost(`/${FB_AD_ACCOUNT}/adsets`, {
    name: `${data.name} - Ad Set`,
    campaign_id: campaign.id,
    daily_budget: Math.round(parseFloat(data.daily_budget || 5) * 100), // cents
    billing_event: 'IMPRESSIONS',
    optimization_goal: 'REACH',
    targeting: {
      geo_locations: {
        custom_locations: [{
          latitude: 36.6781,
          longitude: -97.3103,
          radius: data.radius_miles || 30,
          distance_unit: 'mile',
        }],
      },
      age_min: data.age_min || 25,
      age_max: data.age_max || 55,
    },
    status: 'PAUSED',
  });

  return { campaign_id: campaign.id, ad_set_id: adSet.id };
}

async function updateCampaignStatus(campaignId, status) {
  // status should be 'ACTIVE' or 'PAUSED'
  const fbStatus = status.toUpperCase();
  return fbPost(`/${campaignId}`, { status: fbStatus });
}

async function updateCampaignBudget(campaignId, budgetDollars) {
  // Find the ad sets for this campaign and update their daily budgets
  const sets = await fbGet(`/${campaignId}/adsets`, { fields: 'id' });
  const results = [];
  for (const set of (sets.data || [])) {
    const r = await fbPost(`/${set.id}`, {
      daily_budget: Math.round(parseFloat(budgetDollars) * 100),
    });
    results.push(r);
  }
  return results;
}

async function sendPixelEvent(eventName, eventData = {}, userData = {}) {
  if (!FB_PIXEL_ID) {
    console.warn('[FB PIXEL] FB_PIXEL_ID not set, skipping server-side event');
    return null;
  }

  // Hash user data per FB requirements
  const crypto = require('crypto');
  function hash(v) { return v ? crypto.createHash('sha256').update(v.trim().toLowerCase()).digest('hex') : undefined; }

  const hashedUser = {};
  if (userData.email) hashedUser.em = [hash(userData.email)];
  if (userData.phone) hashedUser.ph = [hash(userData.phone.replace(/\D/g, ''))];
  if (userData.first_name) hashedUser.fn = [hash(userData.first_name)];
  if (userData.last_name) hashedUser.ln = [hash(userData.last_name)];

  const payload = {
    data: [{
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      // event_id lets Meta dedupe this server event against the matching browser
      // pixel event (both use the booking number), so a sale is counted once.
      event_id: eventData.event_id,
      action_source: 'website',
      event_source_url: eventData.event_source_url || 'https://bouncemanrentals.com',
      user_data: hashedUser,
      custom_data: {
        currency: eventData.currency || 'USD',
        value: eventData.value,
        content_name: eventData.content_name,
        content_type: eventData.content_type || 'product',
        order_id: eventData.order_id,
      },
    }],
  };

  try {
    const res = await fetch(`${FB_API_BASE}/${FB_PIXEL_ID}/events?access_token=${FB_ACCESS_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await res.json();
    if (result.error) throw new Error(result.error.message);
    console.log(`[FB PIXEL] ${eventName} event sent, events_received: ${result.events_received}`);
    return result;
  } catch (e) {
    console.error('[FB PIXEL ERROR]', e.message);
    return null;
  }
}

// Verify token on module load
(async () => {
  try {
    const info = await getTokenInfo();
    if (info.valid) {
      const expiryStr = info.expires_at ? ` (expires ${info.expires_at})` : ' (no expiry — long-lived)';
      console.log(`[FB ADS] Token valid${expiryStr}`);
    } else {
      console.warn('[FB ADS] Token invalid or expired:', info.error || 'unknown reason');
    }
  } catch (e) {
    console.warn('[FB ADS] Could not verify token:', e.message);
  }
})();

module.exports = { isConnected, getTokenInfo, getTokenExpiry, getCampaigns, getCampaignPerformance, createCampaign, updateCampaignStatus, updateCampaignBudget, sendPixelEvent };
