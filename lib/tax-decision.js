// The sales-tax jurisdiction decision, flattened into the booking columns that STORE it.
//
// Why this exists: bookings used to keep only tax_rate / tax_amount, so every invoice and the
// OkTAP report re-derived the city/county split from the typed delivery_city.  A booking that
// was corrected to the unincorporated-county rate still DISPLAYED the city split.  Persisting
// the decision (and the rates actually applied) means nothing has to guess again.
//
// tax_basis:
//   'boundary'         - delivery point tested against the real municipal boundary (verified)
//   'typed_city'       - boundary lookup unavailable/inconclusive; rate came from the ZIP/typed
//                        city name (the legacy guess)
//   'fallback_default' - jurisdiction could not be resolved at all; state + Kay county applied
// NULL columns = a row written before this existed (or a tax-exempt booking): consumers must
// fall back to re-deriving from delivery_city and should label that as unverified.
const { taxBreakdown, STATE_RATE } = require('./helpers');
const { COUNTY_RATES } = require('./ok-tax-data');

const COLUMNS = ['tax_basis', 'tax_county', 'tax_place', 'tax_state_rate', 'tax_county_rate', 'tax_city_rate', 'tax_resolved_at'];

// taxCity = exactly what was handed to calcPricing (jurisdiction object or city string);
// pricing = calcPricing's result.  Returns an object keyed by COLUMNS, or all-null.
function taxDecision(taxCity, pricing, taxExempt) {
  const none = {}; COLUMNS.forEach(c => { none[c] = null; });
  if (taxExempt || !pricing) return none;
  let bd = null, basis;
  if (taxCity && typeof taxCity === 'object') { bd = taxBreakdown(taxCity); basis = 'boundary'; }
  else if (taxCity) { bd = taxBreakdown(taxCity); basis = 'typed_city'; }
  let county, place, stateRate, countyRate, cityRate;
  if (bd) {
    county = bd.countyName; place = bd.unincorporated ? null : bd.key;
    stateRate = bd.stateRate; countyRate = bd.countyRate; cityRate = bd.cityRate;
  } else { // calcPricing applied its state + Kay fallback
    basis = 'fallback_default'; county = 'KAY'; place = null;
    stateRate = STATE_RATE; countyRate = COUNTY_RATES.KAY || 0; cityRate = 0;
  }
  // Never store a split that disagrees with the rate actually charged.
  if (Math.abs((stateRate + countyRate + cityRate) - pricing.taxRate) > 1e-9) {
    console.warn('[TAX] Stored split (' + (stateRate + countyRate + cityRate) + ') != charged rate (' + pricing.taxRate + ') - not storing jurisdiction.');
    return none;
  }
  return {
    tax_basis: basis, tax_county: county, tax_place: place,
    tax_state_rate: stateRate, tax_county_rate: countyRate, tax_city_rate: cityRate,
    tax_resolved_at: new Date().toISOString()
  };
}

// resolveTaxCity() already bounds the boundary lookup at 4 s, but an admin form must never hang
// on a tax lookup, so hard-cap the whole thing.  A cap hit resolves to null, NOT the typed city:
// an unverified address is priced at the state+county floor on every channel (see resolveTaxCity),
// and a timeout is the one case most likely to be hiding a boundary we have never tested.  A late
// answer is discarded, but the lookup still warms the 180-day cache for next time.
async function resolveTaxCityBounded(zip, typedCity, delivery, capMs) {
  const { resolveTaxCity } = require('./helpers');
  let timer;
  const cap = new Promise((resolve) => { timer = setTimeout(() => {
    console.warn('[TAX] resolveTaxCity exceeded ' + (capMs || 6000) + ' ms cap for "' + (typedCity || '') + '" - charging the state+county floor. Review this booking.');
    resolve(null);
  }, capMs || 6000); });
  try { return await Promise.race([resolveTaxCity(zip, typedCity, delivery).catch(() => null), cap]); }
  finally { clearTimeout(timer); }
}

module.exports = { taxDecision, resolveTaxCityBounded, COLUMNS };
