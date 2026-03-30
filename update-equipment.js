/**
 * update-equipment.js
 * Replaces all demo equipment with 4 real Bounce Man LLC units.
 * Also cleans up unused categories and updates company settings.
 * Run: node update-equipment.js
 */

const { getDb, initialize } = require('./db');
const { v4: uuid } = require('uuid');

initialize();
const db = getDb();

console.log('[UPDATE] Starting equipment update...');

// ---------------------------------------------------------------------------
// 1. Delete all existing equipment_images and equipment (demo data)
// ---------------------------------------------------------------------------
db.prepare('DELETE FROM equipment_images').run();
db.prepare('DELETE FROM equipment').run();
console.log('[UPDATE] Cleared all equipment and equipment_images');

// ---------------------------------------------------------------------------
// 2. Delete ALL categories then re-insert only the 3 real ones
// ---------------------------------------------------------------------------
db.prepare('DELETE FROM categories').run();
console.log('[UPDATE] Cleared all categories');

const catInsert = db.prepare(
  `INSERT INTO categories (id, name, slug, description, sort_order, active) VALUES (?, ?, ?, ?, ?, 1)`
);
catInsert.run(uuid(), 'Bounce Houses', 'bounce_houses', 'Classic bounce houses for all ages', 1);
catInsert.run(uuid(), 'Combo Units',   'combo_units',   'Bounce and slide combo units', 2);
catInsert.run(uuid(), 'Water Slides',  'water_slides',  'Water slides for summer fun', 3);
console.log('[UPDATE] Categories set (bounce_houses, combo_units, water_slides)');

// ---------------------------------------------------------------------------
// 3. Insert the 4 real equipment units
// ---------------------------------------------------------------------------
const equipInsert = db.prepare(`
  INSERT INTO equipment
    (id, name, slug, category, short_description, capacity_kids,
     age_range, setup_time_min, power_required, price_4hr, price_daily, price_overnight,
     deposit_amount, status, featured, sort_order, condition)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?, ?)
`);

// [id_placeholder, name, slug, category, short_description, capacity_kids, age_range,
//  setup_time_min, power_required, price_4hr, price_daily, price_overnight, deposit, featured, sort_order, condition]
const units = [
  {
    name:              'Tropical Water Slide',
    slug:              'tropical-water-slide',
    category:          'water_slides',
    short_description: 'Cool off with this towering tropical water slide — perfect for beating the Oklahoma heat at your next party or event.',
    capacity_kids:     8,
    age_range:         '3-12',
    setup_time_min:    25,
    power_required:    '1 standard outlet (20 amp)',
    price_4hr:         300,
    price_daily:       375,
    price_overnight:   400,
    deposit_amount:    75,
    featured:          1,
    sort_order:        1,
    condition:         'good',
    image_url:         'https://images.unsplash.com/photo-1558618666-fcd25c85f82e?w=800',
  },
  {
    name:              'Blue Crush Water Slide',
    slug:              'blue-crush-water-slide',
    category:          'water_slides',
    short_description: 'A massive blue water slide that\'s a hit at birthday parties, church events, and family reunions.',
    capacity_kids:     8,
    age_range:         '3-12',
    setup_time_min:    25,
    power_required:    '1 standard outlet (20 amp)',
    price_4hr:         300,
    price_daily:       375,
    price_overnight:   400,
    deposit_amount:    75,
    featured:          1,
    sort_order:        2,
    condition:         'good',
    image_url:         'https://images.unsplash.com/photo-1596461404969-9ae70f2830c1?w=800',
  },
  {
    name:              'Tropical Combo Bounce & Slide',
    slug:              'tropical-combo-bounce-slide',
    category:          'combo_units',
    short_description: 'The best of both worlds — a spacious bounce area with an attached slide. Kids love it.',
    capacity_kids:     10,
    age_range:         '3-12',
    setup_time_min:    20,
    power_required:    '1 standard outlet (20 amp)',
    price_4hr:         250,
    price_daily:       325,
    price_overnight:   350,
    deposit_amount:    75,
    featured:          1,
    sort_order:        3,
    condition:         'good',
    image_url:         'https://images.unsplash.com/photo-1573225342350-16731dd9bf83?w=800',
  },
  {
    name:              'Classic Bounce House',
    slug:              'classic-bounce-house',
    category:          'bounce_houses',
    short_description: 'A classic bounce house that never gets old. Great for younger kids and backyard birthday parties.',
    capacity_kids:     8,
    age_range:         '3-12',
    setup_time_min:    15,
    power_required:    '1 standard outlet (20 amp)',
    price_4hr:         150,
    price_daily:       200,
    price_overnight:   225,
    deposit_amount:    50,
    featured:          1,
    sort_order:        4,
    condition:         'fair',
    image_url:         'https://images.unsplash.com/photo-1558618047-3c8c76bb987d?w=800',
  },
];

const imgInsert = db.prepare(`
  INSERT INTO equipment_images
    (id, equipment_id, image_path, is_primary, sort_order)
  VALUES (?, ?, ?, 1, 1)
`);

for (const unit of units) {
  const equipId = uuid();
  equipInsert.run(
    equipId,
    unit.name,
    unit.slug,
    unit.category,
    unit.short_description,
    unit.capacity_kids,
    unit.age_range,
    unit.setup_time_min,
    unit.power_required,
    unit.price_4hr,
    unit.price_daily,
    unit.price_overnight,
    unit.deposit_amount,
    unit.featured,
    unit.sort_order,
    unit.condition
  );
  imgInsert.run(uuid(), equipId, unit.image_url);
  console.log('[UPDATE] Inserted: ' + unit.name + ' (' + unit.condition + ')');
}

// ---------------------------------------------------------------------------
// 4. Update settings
// ---------------------------------------------------------------------------
const upsertSetting = db.prepare(`
  INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

upsertSetting.run('company_phone', '(580) 308-9288');
upsertSetting.run('company_email', 'info@bouncemanrentals.com');
console.log('[UPDATE] Settings updated: company_phone, company_email');

// ---------------------------------------------------------------------------
// 5. Verify
// ---------------------------------------------------------------------------
const equipCount   = db.prepare('SELECT COUNT(*) as cnt FROM equipment').get().cnt;
const imgCount     = db.prepare('SELECT COUNT(*) as cnt FROM equipment_images').get().cnt;
const catCount     = db.prepare('SELECT COUNT(*) as cnt FROM categories').get().cnt;
const phoneVal     = db.prepare("SELECT value FROM settings WHERE key = 'company_phone'").get()?.value;
const emailVal     = db.prepare("SELECT value FROM settings WHERE key = 'company_email'").get()?.value;

console.log('\n[UPDATE] Done. Verification:');
console.log('  Equipment rows:        ' + equipCount + ' (expected 4)');
console.log('  Equipment image rows:  ' + imgCount   + ' (expected 4)');
console.log('  Category rows:         ' + catCount   + ' (expected 3)');
console.log('  company_phone:         ' + phoneVal);
console.log('  company_email:         ' + emailVal);

const rows = db.prepare('SELECT name, slug, condition, price_4hr, price_daily, price_overnight, deposit_amount FROM equipment ORDER BY sort_order').all();
console.log('\n  Equipment list:');
for (const r of rows) {
  console.log(`    [${r.condition}] ${r.name} — $${r.price_4hr}/${r.price_daily}/${r.price_overnight} (deposit $${r.deposit_amount})`);
}
