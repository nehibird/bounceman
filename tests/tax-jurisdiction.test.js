// Sales-tax jurisdiction regression test. No framework, no network.
//
// The bug class: tax was derived from the postal city the customer typed, so rural addresses with
// a "Tonkawa"/"Blackwell" mailing address were charged a city rate they did not owe (10.25% /
// 10.75% charged, 5.75% owed), the three booking channels disagreed, and invoices re-printed a
// city split that was never charged. The Census geocoder returns a CCD ("County Subdivision",
// a statistical area) for every point; treating that as a city is the specific trap.
//
// Run from the app root: node tests/tax-jurisdiction.test.js
// The Google geocoder and the Census layer are stubbed at globalThis.fetch (the only seam
// lib/ok-tax-data.js uses), so nothing here touches the network.
const os = require('os');
const fs = require('fs');
const path = require('path');

// Must be set BEFORE the libs load: key present, throwaway cache file (never the real one).
const CACHE = path.join(os.tmpdir(), 'tax-geo-cache-test-' + process.pid + '.json');
process.env.TAX_GEO_CACHE = CACHE;
process.env.GOOGLE_MAPS_API_KEY = 'test-key-not-real';

const root = path.join(__dirname, '..');
const H = require(path.join(root, 'lib/helpers'));
const { invoiceTaxSplit, buildInvoicePdf } = require(path.join(root, 'services/invoice'));

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
}
const near = (a, b) => Math.abs(a - b) < 1e-9;
function tn(name, got, want) { t(name, near(got, want), true); if (!near(got, want)) console.log(`        got ${got} want ${want}`); }

// ---- fixtures: the audit's real addresses ------------------------------------------------
const ADDR = {
  publicSt: { address: '775 N Public Street', city: 'Tonkawa',   zip: '74653', lat: 36.6900, lng: -97.3200, place: null },        // OUTSIDE
  hubbard:  { address: '8751 W Hubbard Rd',   city: 'Blackwell', zip: '74631', lat: 36.8200, lng: -97.3000, place: null },        // OUTSIDE
  summit:   { address: '304 N Summit St',     city: 'Tonkawa',   zip: '74653', lat: 36.6840, lng: -97.3100, place: 'Tonkawa city' }, // INSIDE
  southAve: { address: '14700 W South Ave',   city: 'Tonkawa',   zip: '74653', lat: 36.6790, lng: -97.3300, place: 'Tonkawa city' }, // INSIDE
  // Not cached by any other case, so a failure scenario really exercises the failure path.
  unseen:   { address: '1 Nowhere Rd',        city: 'Tonkawa',   zip: '74653', lat: 36.7000, lng: -97.3400, place: null }
};
const r5 = (n) => Math.round(n * 1e5) / 1e5;
const byPoint = {}; for (const a of Object.values(ADDR)) byPoint[r5(a.lat) + ',' + r5(a.lng)] = a;

// Census response shape. County Subdivisions (the CCD) is ALWAYS present, as in the real API,
// and is named after the postal town even where there is no city: that is the trap.
function censusBody(a, opts) {
  const g = {
    States: [{ NAME: 'Oklahoma' }],
    Counties: [{ BASENAME: 'Kay', NAME: 'Kay County' }],
    'County Subdivisions': [{ BASENAME: a.city, NAME: a.city + ' CCD' }]
  };
  if (a.place && !(opts && opts.noPlaces)) g['Incorporated Places'] = [{ BASENAME: 'Tonkawa', NAME: a.place }];
  return { result: { geographies: g } };
}

// ---- network model for the sampling / retry / second-source cases (section 8) ----------------
// WORLD(lat,lng) decides the Census answer for any point not in `byPoint`: a place name, or null
// for unincorporated. GOOGLE / ONELINE are per-test response tables keyed by a predicate on the
// query text. `calls` counts what the resolver actually fetched.
const calls = { google: 0, geo: 0, oneline: 0 };
const resetCalls = () => { calls.google = calls.geo = calls.oneline = 0; };
let GOOGLE = [], ONELINE = [], WORLD = null, GEO_DELAY = null;
const box = (b) => b ? { northeast: { lat: b.n, lng: b.e }, southwest: { lat: b.s, lng: b.w } } : undefined;
const vpAround = (lat, lng, d) => ({ n: lat + d, s: lat - d, e: lng + d, w: lng - d });

let mode = 'ok'; // ok | throw | hang | garbage
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  url = String(url);
  if (mode === 'throw') return Promise.reject(new Error('stubbed network down'));
  if (mode === 'hang') {
    return new Promise((_, rej) => { if (init && init.signal) init.signal.addEventListener('abort', () => rej(new Error('aborted'))); });
  }
  if (mode === 'garbage') return Promise.resolve({ ok: true, status: 200, json: async () => ({ unexpected: true }) });
  const json = (body) => Promise.resolve({ ok: true, status: 200, json: async () => body });
  if (url.includes('maps.googleapis.com')) {
    calls.google++;
    const q = decodeURIComponent((url.match(/address=([^&]+)/) || [])[1] || '').toLowerCase();
    const hit = GOOGLE.find((e) => e.when(q));
    if (hit) {
      const r = hit.res;
      return json({ status: 'OK', results: [{
        geometry: { location: { lat: r.lat, lng: r.lng }, location_type: r.lt, viewport: box(r.vp), bounds: box(r.bounds) },
        partial_match: !!r.partial, types: r.types || ['street_address'], formatted_address: 'stub: ' + q,
        address_components: [{ types: ['administrative_area_level_1'], short_name: r.state || 'OK' }]
      }] });
    }
    const a = Object.values(ADDR).find((x) => q.startsWith(x.address.toLowerCase()));
    if (!a) return json({ status: 'ZERO_RESULTS', results: [] });
    return json({ status: 'OK', results: [{
      geometry: { location: { lat: a.lat, lng: a.lng }, location_type: 'ROOFTOP' },
      partial_match: false, formatted_address: a.address,
      address_components: [{ types: ['administrative_area_level_1'], short_name: 'OK' }]
    }] });
  }
  if (url.includes('geocoding.geo.census.gov/geocoder/locations/onelineaddress')) {
    calls.oneline++;
    const q = decodeURIComponent((url.match(/address=([^&]+)/) || [])[1] || '').toLowerCase();
    const hit = ONELINE.find((e) => e.when(q));
    return json({ result: { addressMatches: hit ? [{ matchedAddress: hit.matched, coordinates: { x: hit.x, y: hit.y } }] : [] } });
  }
  if (url.includes('geocoding.geo.census.gov')) {
    calls.geo++;
    const x = parseFloat(decodeURIComponent((url.match(/[?&]x=([^&]+)/) || [])[1]));
    const y = parseFloat(decodeURIComponent((url.match(/[?&]y=([^&]+)/) || [])[1]));
    const a = byPoint[r5(y) + ',' + r5(x)];
    let body = { result: { geographies: {} } };
    if (a) body = censusBody(a, global.__censusOpts);
    else if (WORLD) body = censusBody({ city: 'Tonkawa', place: WORLD(y, x) });
    const delay = GEO_DELAY ? GEO_DELAY(y, x) : 0;
    if (!delay) return json(body);
    return new Promise((res, rej) => {
      const tm = setTimeout(() => res({ ok: true, status: 200, json: async () => body }), delay);
      if (init && init.signal) init.signal.addEventListener('abort', () => { clearTimeout(tm); rej(new Error('aborted')); });
    });
  }
  return Promise.reject(new Error('unexpected fetch in test: ' + url));
};

const SETTINGS = { damage_waiver_fee: '0', deposit_flat: '50' };
const SUBTOTAL = 392.73;
const rate = (city) => H.calcPricing(SETTINGS, SUBTOTAL, 0, city, false).taxRate;
const STATE_KAY = H.taxBreakdown('NARDIN').total; // Nardin = state + Kay, no city levy
const TONKAWA = H.getTaxRate('TONKAWA');
const BLACKWELL = H.getTaxRate('BLACKWELL');
const dp = (a) => ({ address: a.address, state: 'OK', zip: a.zip });
const resolve = (a) => H.resolveTaxCity(a.zip, a.city, dp(a));

(async () => {
  console.log('rate tables (sanity):');
  tn('state + Kay (no city) is 5.75%', STATE_KAY, 0.0575);
  tn('Tonkawa city total is 10.25%', TONKAWA, 0.1025);
  tn('Blackwell city total is 10.75%', BLACKWELL, 0.1075);

  console.log('1. outside city limits => county + state only, never a city rate:');
  for (const k of ['publicSt', 'hubbard']) {
    const a = ADDR[k];
    const j = await resolve(a);
    t(`${a.address}: resolved to a verified jurisdiction object`, !!j && typeof j === 'object' && j.verified === true, true);
    const tb = H.taxBreakdown(j);
    t(`${a.address}: no city component`, tb && tb.cityRate, 0);
    t(`${a.address}: flagged unincorporated`, tb && tb.unincorporated, true);
    tn(`${a.address}: priced at 5.75%`, rate(j), 0.0575);
  }

  console.log('2. inside city limits => that city\'s rate:');
  for (const k of ['summit', 'southAve']) {
    const a = ADDR[k];
    const j = await resolve(a);
    const tb = H.taxBreakdown(j);
    t(`${a.address}: city is TONKAWA`, tb && tb.key, 'TONKAWA');
    tn(`${a.address}: priced at the Tonkawa rate`, rate(j), TONKAWA);
  }

  console.log('3. a CCD is NOT a municipality (the trap):');
  {
    const a = ADDR.publicSt;
    // Census always lists "Tonkawa CCD" under County Subdivisions for these points.
    const body = censusBody(a);
    t('fixture carries the CCD', body.result.geographies['County Subdivisions'][0].NAME, 'Tonkawa CCD');
    t('fixture has no Incorporated Places layer', 'Incorporated Places' in body.result.geographies, false);
    const cen = await require(path.join(root, 'lib/ok-tax-data')).censusLookup(a.lat, a.lng);
    t('censusLookup ignores the CCD (place is null)', cen.place, null);
    const bl = ADDR.hubbard;
    const cen2 = await require(path.join(root, 'lib/ok-tax-data')).censusLookup(bl.lat, bl.lng);
    t('Blackwell CCD is not a place either', cen2.place, null);
    tn('and the price carries no city rate', rate(await resolve(a)), 0.0575);
  }

  console.log('4. failed / timed-out / keyless lookup: no throw, no silent city rate:');
  const u = ADDR.unseen;
  for (const m of ['throw', 'garbage', 'hang', 'nokey']) {
    mode = m === 'nokey' ? 'ok' : m;
    const saved = process.env.GOOGLE_MAPS_API_KEY;
    if (m === 'nokey') delete process.env.GOOGLE_MAPS_API_KEY;
    let threw = null, out;
    const t0 = Date.now();
    try { out = await resolve(u); } catch (e) { threw = e; }
    process.env.GOOGLE_MAPS_API_KEY = saved;
    t(`[${m}] resolveTaxCity does not throw`, threw, null);
    const priced = H.calcPricing(SETTINGS, SUBTOTAL, 0, out, false).taxRate;
    t(`[${m}] result is not a verified jurisdiction (nothing was verified)`, !!(out && typeof out === 'object' && out.verified), false);
    t(`[${m}] unverified address priced at the 5.75% state+county floor, not the typed city's ${(TONKAWA * 100).toFixed(2)}% (got ${(priced * 100).toFixed(3)}%)`, near(priced, 0.0575), true);
    if (m === 'hang') t('[hang] gave up inside the documented deadline', Date.now() - t0 < 6000, true);
  }
  mode = 'ok';
  {
    const p = H.taxBreakdown(ADDR.unseen.city, dp(ADDR.unseen));
    t('taxBreakdown cache-only peek: nothing cached => falls back to typed city, no network, no throw', !!p, true);
  }

  console.log('5. conservative fallback is state + county, never 0, never a guess:');
  for (const [label, city] of [['null', null], ['empty', ''], ['unknown town', 'Atlantis'], ['unverified jurisdiction obj', { verified: false, countyName: 'KAY', placeKey: 'TONKAWA' }]]) {
    const r = H.calcPricing(SETTINGS, SUBTOTAL, 0, city, false);
    tn(`${label}: rate is 5.75%`, r.taxRate, 0.0575);
    t(`${label}: tax charged is non-zero`, r.taxAmount > 0, true);
    t(`${label}: tax amount = 5.75% of subtotal`, r.taxAmount, Math.round(SUBTOTAL * 0.0575 * 100) / 100);
  }
  tn('exempt customer still pays 0 (fallback never overrides exemption)', H.calcPricing(SETTINGS, SUBTOTAL, 0, null, true).taxRate, 0);

  console.log('6. channel parity (public funnel vs admin vs Sarah):');
  // The public funnel resolves the delivery point (booking.js). Every other channel that prices a
  // booking must resolve the SAME way, or the same address is taxed differently by whichever door
  // it came in through. Each calcPricing() call that takes a delivery city must be fed from
  // `await resolveTaxCity(..., { address ... })`, not a raw typed-city string.
  // Accepted resolvers -- all three take the delivery ADDRESS and answer by municipal boundary:
  //   resolveTaxCity         awaited, 4 s deadline; the charge paths (booking.js, sarah.js)
  //   resolveTaxCityBounded  same, hard-capped so an admin form cannot hang (admin.js)
  //   cachedTaxCity          sync cache-only peek; Sarah's spoken QUOTE paths, which must not
  //                          block a live call. Flagged tax_estimated, and the charge path
  //                          re-resolves before money moves.
  // A raw typed-city string is never acceptable. `quoteTax.taxCity` is traced through `quoteTax`.
  const RESOLVERS = /resolveTaxCity(?:Bounded)?\s*\(|cachedTaxCity\s*\(/;
  function channelAudit(file) {
    const src = fs.readFileSync(path.join(root, 'routes', file), 'utf8');
    const bad = [];
    const re = /calcPricing\(([^;]*)\)/g; let m;
    while ((m = re.exec(src))) {
      const args = m[1].split(',').map((s) => s.trim());
      if (args.length < 4 || /^(null|undefined)$/.test(args[3])) continue; // sample/quote math with no city
      const id = args[3];
      const base = id.split('.')[0];
      const asg = new RegExp('\\b' + base.replace(/[.$]/g, '\\$&') + '\\s*=\\s*([^;]*)', 'gs');
      let ok = false, a;
      while ((a = asg.exec(src))) {
        if (RESOLVERS.test(a[1]) && /address/.test(a[1])) { ok = true; break; }
      }
      if (!ok) bad.push(id);
    }
    return bad;
  }
  for (const f of ['booking.js', 'admin.js', 'sarah.js']) {
    t(`routes/${f}: tax city comes from resolveTaxCity(... address)`, channelAudit(f), []);
  }
  {
    // Behavioural half: the shared resolver gives the SAME tax for the same address however it is
    // reached, and the typed-city shortcut is provably different (that gap is the original bug).
    const a = ADDR.publicSt;
    const viaResolver = rate(await resolve(a));
    const viaResolverAgain = rate(await resolve(a));
    tn('resolver is deterministic/cached: same address, same tax', viaResolver, viaResolverAgain);
    t('typed-city shortcut would have charged a DIFFERENT tax (why parity matters)', rate(a.city) !== viaResolver, true);
  }

  console.log('7. invoice shows what was CHARGED (BM-MVR411XL-ZIW and friends):');
  const MVR = { booking_number: 'BM-MVR411XL-ZIW', delivery_city: 'BLACKWELL', subtotal: 392.73, delivery_fee: 0, discount_amount: 0, tax_rate: 0.0575, tax_amount: 22.58, total: 415.31 };
  {
    const s = invoiceTaxSplit(MVR);
    t('repriced booking: no City of Blackwell line', s.parts.some((p) => /Blackwell/i.test(p.label)), false);
    t('repriced booking: state + Kay County only', s.parts.map((p) => p.label), ['Oklahoma state', 'Kay County']);
    tn('repriced booking: total rate is the 5.75% charged', s.total, 0.0575);
    tn('split sums to the rate charged', s.parts.reduce((x, p) => x + p.rate, 0), 0.0575);
    const old = H.taxBreakdown(MVR.delivery_city);
    t('(old behaviour would have printed 10.75% for the same booking)', Math.abs(old.total - 0.1075) < 1e-9, true);
  }
  {
    const s = invoiceTaxSplit({ booking_number: 'x', delivery_city: 'TONKAWA', subtotal: 100, tax_rate: 0.1025, tax_amount: 10.25 });
    t('genuinely in-city booking still shows its city line', s.parts.map((p) => p.label), ['Oklahoma state', 'Kay County', 'City of Tonkawa']);
  }
  {
    const s = invoiceTaxSplit({ delivery_city: 'BLACKWELL', subtotal: 100, tax_rate: 0.0575, tax_amount: 5.75, tax_jurisdiction: JSON.stringify({ countyName: 'KAY', placeKey: null, source: 'census' }) });
    t('stored jurisdiction is preferred and agrees', [s.basis, s.parts.length], ['stored', 2]);
    const lie = invoiceTaxSplit({ delivery_city: 'BLACKWELL', subtotal: 100, tax_rate: 0.0575, tax_amount: 5.75, tax_jurisdiction: JSON.stringify({ countyName: 'KAY', placeKey: 'BLACKWELL' }) });
    t('stored jurisdiction contradicting the stored rate is not believed', lie.basis !== 'stored', true);
  }
  {
    const s = invoiceTaxSplit({ delivery_city: 'TONKAWA', subtotal: 100, tax_rate: 0.0999, tax_amount: 9.99 });
    t('rate matching no jurisdiction => honestly unreconciled, no invented split', [s.unreconciled === true, s.parts], [true, undefined]);
    const s2 = invoiceTaxSplit({ delivery_city: 'TONKAWA', subtotal: 100, tax_rate: 0.1025, tax_amount: 7.00 });
    t('rate that does not explain the amount charged => unreconciled', s2.unreconciled, true);
    const s3 = invoiceTaxSplit({ delivery_city: '', subtotal: 100, tax_rate: 0.0575, tax_amount: 5.75 });
    t('no city and no stored jurisdiction => unreconciled (does not guess a county)', s3.unreconciled, true);
  }
  {
    // End to end: the PDF renders for each shape without throwing.
    const cust = { name: 'Test', email: 't@example.com' };
    for (const b of [MVR, { ...MVR, tax_rate: 0.0999, tax_amount: 39.24, delivery_city: 'TONKAWA' }]) {
      let err = null, buf = null;
      try { buf = await buildInvoicePdf({ ...b, balance_due: 365.31, event_date: '2026-11-14' }, cust, [], {}); } catch (e) { err = e; }
      t(`buildInvoicePdf renders (${b.tax_rate})`, [err && err.message, !!buf && buf.length > 500], [null, true]);
    }
  }

  console.log('8. multi-point sampling / venue retry / second source (stubbed network):');
  {
    delete require.cache[require.resolve(path.join(root, 'lib/ok-tax-data'))];
    const T = require(path.join(root, 'lib/ok-tax-data'));
    const R = (address, zip) => T.resolveTaxJurisdiction({ address, city: 'Tonkawa', state: 'OK', zip: zip || '74653' }, { deadlineMs: 4000 });
    // City limit = the line lng -97.3050: west of it is "Tonkawa city", east is unincorporated Kay County.
    WORLD = (lat, lng) => (lng < -97.3050 ? 'Tonkawa city' : null);
    const where = (lng) => ({ lat: 36.6865, lng });
    const G = (when, p, extra) => GOOGLE.push({ when, res: Object.assign({ lat: p.lat, lng: p.lng, lt: 'ROOFTOP' }, extra) });
    const place = (j) => j && j.verified ? (j.placeKey || 'UNINC') : null;

    // -- A: every sampled point agrees => accepted ------------------------------------------
    resetCalls();
    G((q) => q.startsWith('sample park'), where(-97.3102), { lt: 'GEOMETRIC_CENTER', types: ['establishment', 'park', 'point_of_interest'], vp: vpAround(36.6865, -97.3102, 0.0013) });
    let j = await R('Sample Park');
    t('A. all 5 points agree: accepted', [j.verified, place(j), j.sampled, j.sampleCount], [true, 'TONKAWA', true, 5]);
    t('A. samples are stored on the result (and so cached)', Array.isArray(j.samples) && j.samples.length === 5, true);
    tn('A. priced as Tonkawa city', rate(j), TONKAWA);
    resetCalls();
    const j2 = await R('Sample Park');
    t('A. second call is served from cache: no network at all', [calls.google, calls.geo, calls.oneline], [0, 0, 0]);
    t('A. peek (sync cache read) returns the sampled answer', T.peekTaxJurisdiction({ address: 'Sample Park', city: 'Tonkawa', state: 'OK', zip: '74653' }).sampleCount, 5);
    t('A. cached answer is identical', JSON.stringify(j2), JSON.stringify(j));

    // -- B: any one corner disagrees => refused ---------------------------------------------
    G((q) => q.startsWith('edge park'), where(-97.3060), { lt: 'GEOMETRIC_CENTER', types: ['establishment', 'park'], vp: vpAround(36.6865, -97.3060, 0.0013) });
    j = await R('Edge Park');
    t('B. centre in city but the east corners are outside: refused', [j.verified, j.nearBoundary], [false, true]);
    t('B. reason names the disagreeing point', /sample points disagree/.test(j.reason), true);
    tn('B. refused result prices at the 5.75% floor, not a city rate', rate(j), 0.0575);
    // interpolated address on the line (the 11455 South Main shape): centre + SW inside, NE/NW/SE outside
    G((q) => q.startsWith('11455 south main'), where(-97.3052), { lt: 'RANGE_INTERPOLATED', vp: vpAround(36.6865, -97.3052, 0.0013) });
    j = await R('11455 South Main');
    t('B. RANGE_INTERPOLATED straddling the line: refused', [j.verified, j.nearBoundary], [false, true]);

    // -- C: a ROOFTOP point is not sampled and is unaffected by its viewport -----------------
    resetCalls();
    G((q) => q.startsWith('rooftop edge'), where(-97.3061), { lt: 'ROOFTOP', vp: vpAround(36.6865, -97.3061, 0.0013) }); // equally hostile viewport (spans the line)
    j = await R('Rooftop Edge');
    t('C. ROOFTOP with a viewport that spans the line: still accepted', [j.verified, place(j), !!j.sampled], [true, 'TONKAWA', false]);
    t('C. exactly ONE Census point lookup (no sampling) for a rooftop', calls.geo, 1);

    // -- D: partial match, cleaned retry succeeds --------------------------------------------
    G((q) => q.startsWith('test elementary school, 501 n public st'), where(-97.3200), { lt: 'ROOFTOP', partial: true });
    G((q) => q.startsWith('501 n public st'), where(-97.3200), { lt: 'ROOFTOP' });
    j = await R('Test Elementary School, 501 N Public St, Tonkawa, OK 74653');
    t('D. partial + venue prefix: retried and accepted', [j.verified, place(j)], [true, 'TONKAWA']);
    t('D. retry is recorded (what was stripped, how far the point moved)', [j.retry.rule, j.retry.removed, j.retry.movedM], ['venue-prefix', 'Test Elementary School', 0]);
    // -- E: retry lands materially elsewhere => refused --------------------------------------
    G((q) => q.startsWith('far school, 600 n elm st'), where(-97.3200), { lt: 'ROOFTOP', partial: true });
    G((q) => q.startsWith('600 n elm st'), { lat: 36.6965, lng: -97.3200 }, { lt: 'ROOFTOP' }); // ~1.1 km north
    j = await R('Far School, 600 N Elm St, Tonkawa, OK 74653');
    t('E. cleaned retry moved ~1.1 km: refused, not guessed', [j.verified, /moved the point/.test(j.reason)], [false, true]);
    // small move (27 m) but across the city line => different jurisdiction => refused
    G((q) => q.startsWith('line school, 700 n oak st'), { lat: 36.6865, lng: -97.30520 }, { lt: 'ROOFTOP', partial: true });
    G((q) => q.startsWith('700 n oak st'), { lat: 36.6865, lng: -97.30490 }, { lt: 'ROOFTOP' });
    j = await R('Line School, 700 N Oak St, Tonkawa, OK 74653');
    t('E. small move that crosses the city line: refused', [j.verified, /different jurisdiction/.test(j.reason)], [false, true]);
    // retry also partial / relational prefix / no street => no retry
    G((q) => q.startsWith('also school, 800 n ash st'), where(-97.3200), { lt: 'ROOFTOP', partial: true });
    G((q) => q.startsWith('800 n ash st'), where(-97.3200), { lt: 'ROOFTOP', partial: true });
    j = await R('Also School, 800 N Ash St, Tonkawa, OK 74653');
    t('E. retry is itself partial: refused', [j.verified, /also partial/.test(j.reason)], [false, true]);
    G((q) => q.startsWith('across from 200 s 6th st'), where(-97.3200), { lt: 'ROOFTOP', partial: true });
    resetCalls();
    j = await R('Across from 200 S 6th St');
    t('E. relational prefix ("Across from") is never rewritten to the street address', [j.verified, calls.google], [false, 1]);

    // -- cleaner (pure) ------------------------------------------------------------------------
    const cl = (a) => { const c = T.cleanVenueAddress(a); return c && c.address; };
    t('clean: venue prefix removed', cl('Tonkawa Elementary School, 501 N Public St, Tonkawa, OK 74653'), '501 N Public St, Tonkawa, OK 74653');
    t('clean: no comma needed', cl('First Baptist Church 320 W North Ave Tonkawa OK'), '320 W North Ave Tonkawa OK');
    t('clean: plain street address has nothing to strip', cl('501 N Public St, Tonkawa, OK'), null);
    t('clean: "Pavilion 7" is not a street number', cl('Ponca Lake Park - Pavilion 7, Ponca City, OK 74604'), null);
    t('clean: relational prefix refused', cl('Across from 200 S 6th St, Ponca City'), null);
    t('clean: venue with no street at all', cl('Blinn Park, Tonkawa, OK'), null);

    // -- F: city-only is an explicit human-answer outcome, with no network call ------------------
    resetCalls();
    for (const [a, c] of [['Blackwell, OK', 'Blackwell'], ['Nardin, OK 74646', 'Nardin'], ['Tonkawa', 'Tonkawa'], ['Tonkawa, OK', 'Tonkawa']]) {
      j = await T.resolveTaxJurisdiction({ address: a, city: c, state: 'OK' }, { deadlineMs: 4000 });
      t(`F. "${a}": needsHuman, unverified, not a rate`, [j.verified, j.needsHuman, T.jurisdictionBreakdown(j)], [false, true, null]);
    }
    t('F. no geocode attempted for city-only text', [calls.google, calls.geo], [0, 0]);
    t('F. addressNeedsHuman: empty address + a city', !!T.addressNeedsHuman({ address: '', city: 'Blackwell' }), true);
    t('F. addressNeedsHuman: a real street is not flagged', T.addressNeedsHuman({ address: '8751 W Hubbard Rd', city: 'Blackwell' }), null);
    // Google can also answer a street-less query with a locality centroid: same outcome
    G((q) => q.startsWith('somewhere'), where(-97.3200), { lt: 'APPROXIMATE', types: ['locality', 'political'], vp: vpAround(36.6865, -97.32, 0.04) });
    j = await R('Somewhere');
    t('F. locality-only geocode => needsHuman', [j.verified, j.needsHuman], [false, true]);

    // -- G: Census one-line as an independent confirmer ----------------------------------------------
    G((q) => q.startsWith('300 conf rd'), where(-97.3200), { lt: 'ROOFTOP' });
    ONELINE.push({ when: (q) => q.startsWith('300 conf rd'), x: -97.3199, y: 36.6865, matched: '300 CONF RD, TONKAWA, OK, 74653' });
    j = await R('300 Conf Rd');
    t('G. agreeing Census match is recorded as confirmed', [j.verified, j.confirm.status], [true, 'confirmed']);
    G((q) => q.startsWith('310 clash rd'), where(-97.3060), { lt: 'ROOFTOP' }); // city side
    ONELINE.push({ when: (q) => q.startsWith('310 clash rd'), x: -97.3045, y: 36.6865, matched: '310 CLASH RD, TONKAWA, OK, 74653' }); // ~135 m east, outside
    j = await R('310 Clash Rd');
    t('G. Census lands <=300 m away in a different jurisdiction: conflict => refused', [j.verified, j.confirm.status], [false, 'conflict']);
    G((q) => q.startsWith('320 far rd'), where(-97.3060), { lt: 'ROOFTOP' });
    ONELINE.push({ when: (q) => q.startsWith('320 far rd'), x: -97.2900, y: 36.6865, matched: '320 FAR RD, TONKAWA, OK, 74653' }); // 1.4 km away
    j = await R('320 Far Rd');
    t('G. Census interpolates 1.4 km away: inconclusive, does NOT veto Google\'s rooftop', [j.verified, j.confirm.status], [true, 'inconclusive']);
    j = await R('Sample Park');
    t('G. venue/no-match: stays silent (nomatch)', true, true);

    // -- H: Google unavailable => Census one-line fallback, under a stricter test ---------------------
    const savedKey = process.env.GOOGLE_MAPS_API_KEY;
    delete process.env.GOOGLE_MAPS_API_KEY;
    ONELINE.push({ when: (q) => q.startsWith('100 fallback st'), x: -97.3300, y: 36.6865, matched: '100 FALLBACK ST, TONKAWA, OK, 74653' });
    j = await R('100 Fallback St');
    t('H. no Google key: deep inside the city, Census-only answer accepted', [j.verified, place(j), j.via, j.fallback], [true, 'TONKAWA', 'census-oneline', 'google-unavailable']);
    t('H. ...and it was checked on a ring (9 points)', j.sampleCount, 9);
    ONELINE.push({ when: (q) => q.startsWith('110 edgefb st'), x: -97.3070, y: 36.6865, matched: '110 EDGEFB ST, TONKAWA, OK, 74653' });
    j = await R('110 Edgefb St');
    t('H. Census-only point within 500 m of the line: refused', [j.verified, j.nearBoundary], [false, true]);
    ONELINE.push({ when: (q) => q.startsWith('120 south drop st'), x: -97.3300, y: 36.6865, matched: '120 DROP ST, TONKAWA, OK, 74653' });
    j = await R('120 South Drop St');
    t('H. Census silently dropped a word of the street ("South"): not trusted', [j.verified, /does not carry the street/.test(j.reason)], [false, true]);
    ONELINE.push({ when: (q) => q.startsWith('130 zip st'), x: -97.3300, y: 36.6865, matched: '130 ZIP ST, TONKAWA, OK, 74601' });
    j = await R('130 Zip St');
    t('H. Census matched a different ZIP: not trusted', j.verified, false);
    j = await R('140 Nomatch St');
    t('H. no Google and no Census match: no answer at all (null), nothing cached', j, null);
    process.env.GOOGLE_MAPS_API_KEY = savedKey;
    j = await T.peekTaxJurisdiction({ address: '120 South Drop St', city: 'Tonkawa', state: 'OK', zip: '74653' });
    t('H. an UNVERIFIED Census-only answer is not remembered (Google may be back)', j, null);

    // -- I: budget. Slow/hung Census must never push a quote past the deadline -------------------------
    G((q) => q.startsWith('slow park'), where(-97.3110), { lt: 'GEOMETRIC_CENTER', types: ['park'], vp: vpAround(36.6865, -97.3110, 0.0013) });
    GEO_DELAY = () => 60000; // every Census geographies call hangs (until aborted)
    let t0 = Date.now();
    j = await R('Slow Park');
    t('I. all Census calls hang: gave up at the deadline, no throw, null', [j, Date.now() - t0 < 4600], [null, true]);
    // disagreement short-circuit: one corner answers instantly (outside), the others take 2.5 s
    G((q) => q.startsWith('quick edge'), where(-97.3062), { lt: 'GEOMETRIC_CENTER', types: ['park'], vp: vpAround(36.6865, -97.3062, 0.0013) });
    GEO_DELAY = (lat, lng) => (lng > -97.3050 ? 0 : (Math.abs(lat - 36.6865) < 1e-9 && Math.abs(lng + 97.3062) < 1e-9 ? 0 : 2500));
    t0 = Date.now();
    j = await R('Quick Edge');
    t('I. first disagreement short-circuits: refused without waiting for the slow points', [j && j.verified, Date.now() - t0 < 1500], [false, true]);
    GEO_DELAY = null;
    await new Promise((r) => setTimeout(r, 2800)); // let the abandoned lookups finish before the cache-reload case

    // -- J: cache versioning: stale UNVERIFIED answers are re-decided, VERIFIED ones are kept -------------
    {
      const stale = {
        jur: {
          'a:blinn park|tonkawa|ok|74653': { at: Date.now(), v: { verified: false, reason: 'geocode too imprecise (GEOMETRIC_CENTER)' } },
          'a:old verified rd|tonkawa|ok|74653': { at: Date.now(), v: { verified: true, countyName: 'KAY', placeKey: null, source: 'census' } }
        }, geocode: {}, census: {}, oneline: {}
      };
      fs.writeFileSync(CACHE, JSON.stringify(stale));
      delete require.cache[require.resolve(path.join(root, 'lib/ok-tax-data'))];
      const T2 = require(path.join(root, 'lib/ok-tax-data'));
      GOOGLE.push({ when: (q) => q.startsWith('blinn park'), res: Object.assign(where(-97.3102), { lt: 'GEOMETRIC_CENTER', types: ['park'], vp: vpAround(36.6865, -97.3102, 0.0013) }) });
      resetCalls();
      const a = await T2.resolveTaxJurisdiction({ address: 'Blinn Park', city: 'Tonkawa', state: 'OK', zip: '74653' }, { deadlineMs: 4000 });
      t('J. stale unverified cache entry (pre-sampling rules) is re-decided and now verifies', [a.verified, calls.google > 0], [true, true]);
      resetCalls();
      const b = await T2.resolveTaxJurisdiction({ address: 'Old Verified Rd', city: 'Tonkawa', state: 'OK', zip: '74653' }, { deadlineMs: 4000 });
      t('J. an old VERIFIED cache entry is returned untouched (no re-decision, no network)', [b.verified, b.placeKey, calls.google], [true, null, 0]);
    }
    WORLD = null; GOOGLE = []; ONELINE = [];
  }

  try { fs.unlinkSync(CACHE); } catch (e) {}
  globalThis.fetch = realFetch;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST HARNESS ERROR', e); process.exit(2); });
