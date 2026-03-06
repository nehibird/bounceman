/**
 * Seed script for BounceMan demo data.
 * Idempotent — uses INSERT OR IGNORE on unique constraints (slug, code, key).
 * Run: node seed.js
 */

const { getDb, initialize } = require('./db');
const { v4: uuid } = require('uuid');

// Initialize DB schema + default data first
initialize();

const db = getDb();

console.log('[SEED] Starting demo data seed...');

// ---------------------------------------------------------------------------
// 1. Categories (merge with existing — INSERT OR IGNORE on slug)
// ---------------------------------------------------------------------------
const catInsert = db.prepare(
  `INSERT OR IGNORE INTO categories (id, name, slug, description, sort_order, active) VALUES (?, ?, ?, ?, ?, 1)`
);

const categories = [
  ['Bounce Houses', 'bounce-houses', 'Classic and themed bounce houses for all ages', 1],
  ['Water Slides', 'water-slides', 'Water slides and wet/dry combos for summer fun', 2],
  ['Obstacle Courses', 'obstacle-courses', 'Inflatable obstacle courses for competitive fun', 3],
  ['Interactive Games', 'interactive-games', 'Interactive inflatable games and challenges', 4],
  ['Concessions', 'concessions', 'Snow cones, cotton candy, and party extras', 5],
];

for (const [name, slug, desc, order] of categories) {
  catInsert.run(uuid(), name, slug, desc, order);
}
console.log('[SEED] Categories seeded');

// ---------------------------------------------------------------------------
// 2. Equipment (INSERT OR IGNORE on slug)
// ---------------------------------------------------------------------------
const equipInsert = db.prepare(`
  INSERT OR IGNORE INTO equipment
    (id, name, slug, category, short_description, dimensions, capacity_kids,
     age_range, setup_time_min, power_required, price_4hr, price_daily, price_overnight,
     deposit_amount, status, featured, sort_order, condition)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?, 'excellent')
`);

const equipment = [
  // [name, slug, category, short_description, dimensions, capacity_kids, age_range, setup_min, power, price_4hr, price_daily, price_overnight, deposit, featured, sort_order]
  ['Classic Castle Bounce House', 'classic-castle-bounce-house', 'bounce_houses',
    'A timeless castle bounce house perfect for any backyard party.',
    "15'L x 15'W x 13'H", 8, '3-12', 15, '1 standard outlet (20 amp)', 100, 150, 175, 50, 1, 1],

  ['Tropical Combo Bounce House w/ Slide', 'tropical-combo-bounce-house', 'bounce_houses',
    'Bounce house and slide combo with a tropical island theme.',
    "20'L x 15'W x 14'H", 10, '3-12', 20, '1 standard outlet (20 amp)', 125, 200, 225, 50, 1, 2],

  ['Princess Castle', 'princess-castle', 'bounce_houses',
    'A pink and purple princess-themed bounce house — fit for royalty!',
    "15'L x 15'W x 14'H", 8, '3-10', 15, '1 standard outlet (20 amp)', 110, 175, 200, 50, 1, 3],

  ['18ft Tropical Water Slide', '18ft-tropical-water-slide', 'water_slides',
    'Beat the Oklahoma heat with this towering tropical water slide.',
    "30'L x 12'W x 18'H", 6, '5-14', 25, '1 standard outlet (20 amp)', 150, 250, 275, 75, 1, 4],

  ['Dual Lane Water Slide', 'dual-lane-water-slide', 'water_slides',
    'Race your friends down two lanes on this massive water slide!',
    "35'L x 15'W x 20'H", 8, '6-14', 30, '1 standard outlet (20 amp)', 150, 300, 325, 75, 0, 5],

  ['40ft Obstacle Course', '40ft-obstacle-course', 'obstacle_courses',
    'A 40-foot inflatable obstacle course — great for competitions and field days.',
    "40'L x 12'W x 15'H", 10, '5-15', 30, '2 standard outlets (20 amp)', 150, 275, 300, 75, 0, 6],

  ['Wrecking Ball Game', 'wrecking-ball-game', 'interactive_games',
    'Knock your opponents off the pedestal with the wrecking ball!',
    "20'L x 20'W x 10'H", 4, '6-14', 20, '1 standard outlet (20 amp)', 125, 200, 225, 50, 0, 7],

  ['Jousting Arena', 'jousting-arena', 'interactive_games',
    'Two players battle head-to-head on inflatable pedestals with jousting poles.',
    "20'L x 20'W x 8'H", 2, '6-14', 15, '1 standard outlet (20 amp)', 125, 175, 200, 50, 0, 8],

  ['Snow Cone Machine', 'snow-cone-machine', 'concessions',
    'Includes machine, 50 cups, and 3 syrup flavors. Tabletop unit.',
    'Tabletop', null, 'All ages', 5, 'Standard outlet', 50, 75, 85, 25, 0, 9],

  ['Cotton Candy Machine', 'cotton-candy-machine', 'concessions',
    'Spin up fluffy cotton candy for your guests! Includes 50 cones and sugar.',
    'Tabletop', null, 'All ages', 5, 'Standard outlet', 50, 75, 85, 25, 0, 10],
];

for (const [name, slug, category, desc, dims, cap, age, setup, power, price_4hr, price_daily, price_overnight, deposit, featured, sort] of equipment) {
  equipInsert.run(uuid(), name, slug, category, desc, dims, cap, age, setup, power, price_4hr, price_daily, price_overnight, deposit, featured, sort);
}
console.log('[SEED] Equipment seeded (' + equipment.length + ' items)');

// ---------------------------------------------------------------------------
// 3. Delivery Zones — only insert if table is empty (db.js may have seeded some)
// ---------------------------------------------------------------------------
db.prepare('DELETE FROM delivery_zones').run();
const zoneInsert = db.prepare(
  `INSERT INTO delivery_zones (id, name, zip_codes, delivery_fee, active) VALUES (?, ?, ?, ?, 1)`
);
zoneInsert.run(uuid(), 'Local (FREE Delivery)', '74653,74601,74602,74604,74631,74647,74632,74641', 0);
zoneInsert.run(uuid(), 'Nearby ($35)', '74073,74644,74646,74651,74630', 35);
zoneInsert.run(uuid(), 'Extended ($65)', '74074,74075,74076,74078,74058,74056', 65);
console.log('[SEED] Delivery zones seeded (3 zones)');

// ---------------------------------------------------------------------------
// 4. Settings (INSERT OR IGNORE — won't overwrite existing values from db.js)
// ---------------------------------------------------------------------------
const settingInsert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');

const extraSettings = {
  company_name: 'Bounce Man LLC',
  company_email: 'info@bouncemanrentals.com',
  company_phone: '(580) 555-JUMP',
  company_address: 'Tonkawa, OK 74653',
  tax_rate: '0.085',
  deposit_percent: '25',
  damage_waiver_fee: '15',
  cancellation_hours: '48',
  meta_title: 'Bounce Man Rentals - Tonkawa OK Bounce House Rentals',
  meta_description: 'Bounce house, water slide, and party rental equipment in Tonkawa and Northern Oklahoma. Book online today!',
  primary_color: '#FF6B35',
  secondary_color: '#004E89',
};

for (const [key, value] of Object.entries(extraSettings)) {
  settingInsert.run(key, value);
}
console.log('[SEED] Settings seeded');

// ---------------------------------------------------------------------------
// 5. Discount Codes (INSERT OR IGNORE on code)
// ---------------------------------------------------------------------------
const discountInsert = db.prepare(`
  INSERT OR IGNORE INTO discount_codes
    (id, code, type, value, min_order, max_uses, uses_count, valid_from, valid_until, active)
  VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 1)
`);

discountInsert.run(uuid(), 'WELCOME10', 'percent', 10, 0, null, null, null);
discountInsert.run(uuid(), 'SUMMER25', 'flat', 25, 100, null, '2026-06-01', '2026-09-01');
console.log('[SEED] Discount codes seeded');

// ---------------------------------------------------------------------------
// 6. Sample Reviews (only if none exist)
// ---------------------------------------------------------------------------
const reviewCount = db.prepare('SELECT COUNT(*) as cnt FROM reviews').get().cnt;
if (reviewCount === 0) {
  const reviewInsert = db.prepare(`
    INSERT INTO reviews (id, rating, comment, customer_name, approved, featured, created_at)
    VALUES (?, ?, ?, ?, 1, ?, datetime('now', ?))
  `);

  reviewInsert.run(uuid(), 5,
    'The kids had an absolute blast! Setup and pickup were super easy. Definitely booking again for our next birthday party.',
    'Sarah M.', 1, '-10 days');

  reviewInsert.run(uuid(), 5,
    'Rented the Tropical Combo for our church picnic. Nehemiah was great to work with — on time, friendly, and the equipment was spotless.',
    'Pastor James T.', 1, '-25 days');

  reviewInsert.run(uuid(), 4,
    'Great water slide for our Fourth of July party. The kids loved it! Only wish we had booked for longer.',
    'Mike & Lisa R.', 0, '-45 days');

  reviewInsert.run(uuid(), 5,
    'Best birthday party ever! My daughter is still talking about the Princess Castle. Thank you Bounce Man!',
    'Amanda K.', 1, '-5 days');

  console.log('[SEED] Reviews seeded (4 reviews)');
} else {
  console.log('[SEED] Reviews already exist (' + reviewCount + '), skipping');
}

// ---------------------------------------------------------------------------
// 7. Contract Template (only if no default exists — db.js may have created one)
// ---------------------------------------------------------------------------
const templateExists = db.prepare('SELECT id FROM contract_templates WHERE is_default = 1').get();
if (!templateExists) {
  const contractContent = [
    'BOUNCE MAN LLC - RENTAL AGREEMENT',
    '',
    'This Rental Agreement ("Agreement") is entered into between Bounce Man LLC ("Company") and the undersigned customer ("Renter").',
    '',
    'BOOKING DETAILS:',
    'Booking #: {{booking_number}}',
    'Event Date: {{event_date}}',
    'Event Time: {{event_start_time}} - {{event_end_time}}',
    'Delivery Address: {{delivery_address}}',
    'Equipment: {{items_list}}',
    '',
    'TERMS AND CONDITIONS:',
    '',
    '1. RENTAL PERIOD: The rental period begins at the scheduled delivery time and ends at the scheduled pickup time.',
    '',
    '2. SUPERVISION: Renter agrees to provide adult supervision (18+) at all times while equipment is in use. No unsupervised children.',
    '',
    '3. SAFETY RULES: No shoes, sharp objects, silly string, food, drinks, or pets on/in equipment. Posted capacity limits must be observed at all times.',
    '',
    '4. WEATHER: Equipment must NOT be used in rain, winds exceeding 15 mph, lightning, or any severe weather condition. Renter must deflate and secure units if sudden weather arises.',
    '',
    '5. SETUP AREA: Renter will provide a flat, clear area free of debris, dog waste, and overhead obstructions. A dedicated 110V/20A outlet within 100 feet is required per unit.',
    '',
    '6. DAMAGE & LOSS: Renter is financially responsible for any damage beyond normal wear and tear. Replacement costs will be billed at current replacement value.',
    '',
    '7. CANCELLATION: Cancellations made at least {{cancellation_hours}} hours before the event receive a full deposit refund. Late cancellations forfeit the deposit.',
    '',
    '8. LIABILITY WAIVER: Renter assumes all risk of injury or property damage. Renter releases and holds Bounce Man LLC harmless from any and all claims, damages, or liability.',
    '',
    '9. INDEMNIFICATION: Renter agrees to indemnify Bounce Man LLC, its owners, employees, and agents against any third-party claims arising from the rental.',
    '',
    '10. PAYMENT: Total rental amount is due per the agreed payment schedule. A non-refundable deposit of {{deposit_percent}}% is required to confirm the booking.',
    '',
    'RENTAL TOTAL: ${{total}}',
    'DEPOSIT REQUIRED: ${{deposit_amount}}',
    '',
    'By signing below, Renter acknowledges reading and agreeing to all terms and conditions set forth in this Agreement.',
    '',
    'Renter Signature: ________________________  Date: ____________',
    'Renter Name (Print): {{customer_name}}',
  ].join('\n');

  db.prepare(
    `INSERT INTO contract_templates (id, name, content, is_default, active) VALUES (?, ?, ?, 1, 1)`
  ).run(uuid(), 'Standard Rental Agreement', contractContent);
  console.log('[SEED] Contract template seeded');
} else {
  console.log('[SEED] Contract template already exists, skipping');
}

console.log('[SEED] Demo data seeding complete!');
