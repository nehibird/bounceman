const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'bounceman.db');
let db;

function getDb() {
  if (!db) {
    const fs = require('fs');
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function initialize() {
  const d = getDb();

  d.exec(`
    -- Users (admin/staff)
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'staff',
      phone TEXT,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Customers
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      address TEXT,
      city TEXT,
      state TEXT DEFAULT 'OK',
      zip TEXT,
      notes TEXT,
      source TEXT DEFAULT 'website',
      total_bookings INTEGER DEFAULT 0,
      total_revenue REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Equipment inventory
    CREATE TABLE IF NOT EXISTS equipment (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      category TEXT NOT NULL DEFAULT 'bounce_house',
      description TEXT,
      short_description TEXT,
      dimensions TEXT,
      weight_lbs REAL,
      capacity_kids INTEGER,
      age_range TEXT,
      setup_time_min INTEGER DEFAULT 15,
      power_required TEXT DEFAULT '1 standard outlet',
      price_hourly REAL,
      price_4hr REAL,
      price_daily REAL NOT NULL,
      price_weekend REAL,
      price_overnight REAL,
      price_wet REAL,
      deposit_amount REAL DEFAULT 50,
      replacement_cost REAL,
      manufacturer TEXT,
      model TEXT,
      serial_number TEXT,
      purchase_date TEXT,
      condition TEXT DEFAULT 'excellent',
      status TEXT DEFAULT 'available',
      featured INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Equipment images
    CREATE TABLE IF NOT EXISTS equipment_images (
      id TEXT PRIMARY KEY,
      equipment_id TEXT NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
      image_path TEXT NOT NULL,
      is_primary INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Equipment categories
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      description TEXT,
      image_path TEXT,
      sort_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1
    );

    -- Rental packages (bundle pricing)
    CREATE TABLE IF NOT EXISTS packages (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      description TEXT,
      price REAL NOT NULL,
      discount_percent REAL DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS package_items (
      id TEXT PRIMARY KEY,
      package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
      equipment_id TEXT NOT NULL REFERENCES equipment(id) ON DELETE CASCADE
    );

    -- Bookings / Events
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      booking_number TEXT UNIQUE NOT NULL,
      customer_id TEXT NOT NULL REFERENCES customers(id),
      status TEXT NOT NULL DEFAULT 'pending',
      event_date TEXT NOT NULL,
      event_start_time TEXT NOT NULL,
      event_end_time TEXT NOT NULL,
      setup_time TEXT,
      pickup_time TEXT,
      event_type TEXT,
      venue_type TEXT DEFAULT 'residential',
      delivery_address TEXT,
      delivery_city TEXT,
      delivery_state TEXT DEFAULT 'OK',
      delivery_zip TEXT,
      delivery_notes TEXT,
      surface_type TEXT,
      power_available INTEGER DEFAULT 1,
      subtotal REAL NOT NULL DEFAULT 0,
      delivery_fee REAL DEFAULT 0,
      tax_amount REAL DEFAULT 0,
      tax_rate REAL DEFAULT 0,
      discount_amount REAL DEFAULT 0,
      discount_code TEXT,
      total REAL NOT NULL DEFAULT 0,
      deposit_amount REAL DEFAULT 0,
      deposit_paid INTEGER DEFAULT 0,
      balance_due REAL DEFAULT 0,
      damage_waiver INTEGER DEFAULT 0,
      damage_waiver_fee REAL DEFAULT 0,
      payment_status TEXT DEFAULT 'unpaid',
      payment_method TEXT,
      contract_signed INTEGER DEFAULT 0,
      contract_signed_at TEXT,
      contract_signature TEXT,
      assigned_crew TEXT,
      delivery_route_order INTEGER,
      internal_notes TEXT,
      weather_alert_sent INTEGER DEFAULT 0,
      review_requested INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Booking line items
    CREATE TABLE IF NOT EXISTS booking_items (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      equipment_id TEXT REFERENCES equipment(id),
      package_id TEXT REFERENCES packages(id),
      item_name TEXT NOT NULL,
      item_type TEXT DEFAULT 'equipment',
      quantity INTEGER DEFAULT 1,
      unit_price REAL NOT NULL,
      total_price REAL NOT NULL,
      duration_type TEXT DEFAULT 'daily',
      wet_option INTEGER DEFAULT 0
    );

    -- Payments
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL REFERENCES bookings(id),
      customer_id TEXT NOT NULL REFERENCES customers(id),
      amount REAL NOT NULL,
      payment_type TEXT NOT NULL DEFAULT 'charge',
      payment_method TEXT NOT NULL,
      stripe_payment_id TEXT,
      stripe_charge_id TEXT,
      card_last4 TEXT,
      card_brand TEXT,
      status TEXT DEFAULT 'completed',
      refund_amount REAL DEFAULT 0,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Digital contracts
    CREATE TABLE IF NOT EXISTS contracts (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL REFERENCES bookings(id),
      customer_id TEXT NOT NULL REFERENCES customers(id),
      template_id TEXT,
      content TEXT NOT NULL,
      signed INTEGER DEFAULT 0,
      signature_data TEXT,
      signed_at TEXT,
      signer_ip TEXT,
      signer_name TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Contract templates
    CREATE TABLE IF NOT EXISTS contract_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      is_default INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Communication log
    CREATE TABLE IF NOT EXISTS communications (
      id TEXT PRIMARY KEY,
      customer_id TEXT REFERENCES customers(id),
      booking_id TEXT REFERENCES bookings(id),
      type TEXT NOT NULL,
      direction TEXT DEFAULT 'outbound',
      subject TEXT,
      body TEXT,
      recipient TEXT,
      status TEXT DEFAULT 'sent',
      sent_at TEXT DEFAULT (datetime('now')),
      opened_at TEXT,
      metadata TEXT
    );

    -- Email templates
    CREATE TABLE IF NOT EXISTS email_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      trigger_event TEXT,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Reviews
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      booking_id TEXT REFERENCES bookings(id),
      customer_id TEXT REFERENCES customers(id),
      rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
      comment TEXT,
      customer_name TEXT,
      approved INTEGER DEFAULT 0,
      featured INTEGER DEFAULT 0,
      response TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Delivery routes
    CREATE TABLE IF NOT EXISTS delivery_routes (
      id TEXT PRIMARY KEY,
      route_date TEXT NOT NULL,
      route_type TEXT DEFAULT 'delivery',
      assigned_crew TEXT,
      status TEXT DEFAULT 'planned',
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS delivery_route_stops (
      id TEXT PRIMARY KEY,
      route_id TEXT NOT NULL REFERENCES delivery_routes(id) ON DELETE CASCADE,
      booking_id TEXT NOT NULL REFERENCES bookings(id),
      stop_order INTEGER NOT NULL,
      estimated_arrival TEXT,
      actual_arrival TEXT,
      status TEXT DEFAULT 'pending',
      notes TEXT
    );

    -- Equipment maintenance log
    CREATE TABLE IF NOT EXISTS maintenance_log (
      id TEXT PRIMARY KEY,
      equipment_id TEXT NOT NULL REFERENCES equipment(id),
      type TEXT NOT NULL DEFAULT 'inspection',
      description TEXT,
      cost REAL DEFAULT 0,
      performed_by TEXT,
      performed_at TEXT DEFAULT (datetime('now')),
      next_due TEXT,
      status TEXT DEFAULT 'completed'
    );

    -- Discount codes
    CREATE TABLE IF NOT EXISTS discount_codes (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      type TEXT DEFAULT 'percent',
      value REAL NOT NULL,
      min_order REAL DEFAULT 0,
      max_uses INTEGER,
      uses_count INTEGER DEFAULT 0,
      valid_from TEXT,
      valid_until TEXT,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Delivery zones (pricing by area)
    CREATE TABLE IF NOT EXISTS delivery_zones (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      zip_codes TEXT NOT NULL,
      delivery_fee REAL NOT NULL DEFAULT 0,
      active INTEGER DEFAULT 1
    );

    -- Blocked dates
    CREATE TABLE IF NOT EXISTS blocked_dates (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      reason TEXT,
      equipment_id TEXT REFERENCES equipment(id),
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Settings
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Activity log (audit trail)
    CREATE TABLE IF NOT EXISTS activity_log (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      details TEXT,
      ip_address TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Walk-up events (per-kid pricing at tournaments, festivals, etc.)
    CREATE TABLE IF NOT EXISTS walk_up_events (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      event_date TEXT NOT NULL,
      location TEXT,
      price_per_kid REAL NOT NULL DEFAULT 15.00,
      active INTEGER DEFAULT 1,
      wristband_counter INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Walk-up registrations (parent signs waiver + pays per kid)
    CREATE TABLE IF NOT EXISTS walk_up_registrations (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES walk_up_events(id),
      parent_name TEXT NOT NULL,
      parent_phone TEXT,
      kid_count INTEGER NOT NULL DEFAULT 1,
      kid_names TEXT,
      waiver_signed INTEGER DEFAULT 0,
      waiver_signature TEXT,
      waiver_signed_at TEXT,
      signer_ip TEXT,
      wristband_start INTEGER,
      wristband_end INTEGER,
      stripe_session_id TEXT,
      stripe_payment_intent TEXT,
      amount_paid REAL,
      payment_status TEXT DEFAULT 'pending',
      slack_notified INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    -- Ad platform configuration
    CREATE TABLE IF NOT EXISTS ad_config (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Ad campaigns
    CREATE TABLE IF NOT EXISTS ad_campaigns (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      platform_campaign_id TEXT,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'paused',
      daily_budget REAL DEFAULT 5.00,
      target_keywords TEXT,
      target_audience TEXT,
      start_date TEXT,
      end_date TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Ad performance data
    CREATE TABLE IF NOT EXISTS ad_performance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id TEXT REFERENCES ad_campaigns(id),
      date TEXT NOT NULL,
      impressions INTEGER DEFAULT 0,
      clicks INTEGER DEFAULT 0,
      spend REAL DEFAULT 0,
      conversions INTEGER DEFAULT 0,
      cost_per_click REAL DEFAULT 0,
      cost_per_conversion REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Ad automation rules
    CREATE TABLE IF NOT EXISTS ad_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      rule_type TEXT NOT NULL,
      conditions TEXT,
      actions TEXT,
      enabled INTEGER DEFAULT 1,
      last_triggered TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Seed default settings
  const insertSetting = d.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  const defaults = {
    'company_name': 'Bounce Man LLC',
    'company_email': 'nehi@birdherd.media',
    'company_phone': '',
    'company_address': '113 North Barrick Way, Tonkawa, OK 74653',
    'tax_rate': '0.1025',
    'booking_lead_hours': '24',
    'max_booking_days_out': '180',
    'delivery_radius_miles': '50',
    'default_event_duration': '4',
    'operating_season_start': '04-01',
    'operating_season_end': '11-30',
    'damage_waiver_fee': '15',
    'deposit_percent': '50',
    'halfday_hours': '4',
    'halfday_morning_start': '09:00',
    'halfday_morning_end': '13:00',
    'halfday_afternoon_start': '15:00',
    'halfday_afternoon_end': '19:00',
    'blocked_weekdays': '0',
    'cancellation_hours': '48',
    'auto_confirm_bookings': '0',
    'review_request_delay_hours': '24',
    'weather_alert_enabled': '1',
    'stripe_public_key': '',
    'stripe_secret_key': '',
    'stripe_webhook_secret': '',
    'smtp_host': 'mail.smtp2go.com',
    'smtp_port': '2525',
    'smtp_user': '',
    'smtp_pass': '',
    'smtp_from': 'bookings@bouncemanrentals.com',
    'google_analytics_id': '',
    'facebook_pixel_id': '',
    'primary_color': '#FF6B35',
    'secondary_color': '#004E89',
    'meta_title': 'Bounce Man Rentals - Party Equipment Rental in Tonkawa, OK',
    'meta_description': 'Bounce house rentals, water slides, and party equipment for Tonkawa, Ponca City, Stillwater and surrounding Oklahoma areas.',
    'pricing_info': 'Bounce Man Party Rentals - Tonkawa, OK\n\nBounce House: $150 (4hr) / $200 (full day) / $225 (overnight)\nCombo (bounce + slide): $250 (4hr) / $325 (full day) / $350 (overnight)\nWater Slide: $300 (4hr) / $375 (full day) / $400 (overnight)\nBluetooth Party Speaker: $50 (4hr) / $75 (full day)\n\nFREE delivery in Tonkawa! Nearby areas $35-65.\n\nBook at bouncemanrentals.com or call (580) 308-9288',
    'event_base_url': 'https://bouncemanrentals.com/event'
  };

  for (const [key, value] of Object.entries(defaults)) {
    insertSetting.run(key, value);
  }

  // Sync env-based settings (overwrite DB value if env is set)
  const updateSetting = d.prepare('UPDATE settings SET value = ? WHERE key = ?');
  if (process.env.FB_PIXEL_ID) updateSetting.run(process.env.FB_PIXEL_ID, 'facebook_pixel_id');

  // Seed default admin user
  const adminExists = d.prepare('SELECT id FROM users WHERE role = ?').get('admin');
  if (!adminExists) {
    const { v4: uuid } = require('uuid');
    // MED-2: Use env var for initial admin password — never hardcode credentials
    const defaultPassword = process.env.ADMIN_INITIAL_PASSWORD || require('crypto').randomBytes(16).toString('hex');
    if (!process.env.ADMIN_INITIAL_PASSWORD) {
      console.log('[SECURITY] Generated random admin password:', defaultPassword);
      console.log('[SECURITY] Set ADMIN_INITIAL_PASSWORD in .env to control this');
    }
    const hash = bcrypt.hashSync(defaultPassword, 10);
    d.prepare('INSERT INTO users (id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)').run(
      uuid(), 'nehi@birdherd.media', hash, 'Nehemiah Reese', 'admin'
    );
    console.log('[DB] Default admin user created: nehi@birdherd.media');
  }

  // Seed default categories (only if table is empty)
  const { v4: uuid } = require('uuid');
  const catCount = d.prepare('SELECT COUNT(*) as c FROM categories').get().c;
  if (catCount === 0) {
    const catInsert = d.prepare('INSERT INTO categories (id, name, slug, description, sort_order) VALUES (?, ?, ?, ?, ?)');
    const cats = [
      ['Bounce Houses', 'bounce_houses', 'Standard and themed bounce houses for all ages', 1],
      ['Combo Units', 'combo_units', 'Bounce house and slide combo units', 2],
      ['Water Slides', 'water_slides', 'Water slides and wet/dry combos for summer fun', 3],
      ['Obstacle Courses', 'obstacle_courses', 'Inflatable obstacle courses for competitive fun', 4],
      ['Interactive Games', 'interactive_games', 'Interactive inflatable games and challenges', 5],
      ['Add-Ons', 'add_ons', 'Tables, chairs, generators, and accessories', 6]
    ];
    for (const [name, slug, desc, order] of cats) {
      catInsert.run(uuid(), name, slug, desc, order);
    }
  }

  // Seed default email templates
  const emailInsert = d.prepare('INSERT OR IGNORE INTO email_templates (id, name, slug, subject, body, trigger_event, active) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const templates = [
    ['Booking Confirmation', 'booking-confirmation', 'Your Bounce Man Rental is Confirmed! ({{booking_number}})',
      'Hi {{customer_first_name}},\n\nYour booking #{{booking_number}} has been confirmed!\n\nEvent Date: {{event_date}}\nTime: {{event_start_time}} - {{event_end_time}}\nItems: {{items_list}}\nTotal: ${{total}}\n\nDelivery Address: {{delivery_address}}\n\nPlease sign your rental agreement here: {{contract_link}}\n\nThank you for choosing Bounce Man!\n\n- Bounce Man LLC\n{{company_phone}}',
      'booking_confirmed', 1],
    ['Payment Receipt', 'payment-receipt', 'Payment Received - Bounce Man Rental ({{booking_number}})',
      'Hi {{customer_first_name}},\n\nWe received your payment of ${{payment_amount}} for booking #{{booking_number}}.\n\nPayment Method: {{payment_method}}\nRemaining Balance: ${{balance_due}}\n\nThank you!\n\n- Bounce Man LLC',
      'payment_received', 1],
    ['Delivery Reminder', 'delivery-reminder', 'Your Bounce Man Rental is Tomorrow! ({{booking_number}})',
      'Hi {{customer_first_name}},\n\nJust a reminder — your rental delivery is scheduled for tomorrow!\n\nDate: {{event_date}}\nEstimated Delivery: {{setup_time}}\nItems: {{items_list}}\n\nPlease make sure:\n- The setup area is clear and accessible\n- A power outlet is available within 100 feet\n- An adult 18+ is present for delivery\n\nSee you tomorrow!\n\n- Bounce Man LLC\n{{company_phone}}',
      'delivery_reminder', 1],
    ['Review Request', 'review-request', 'How was your Bounce Man experience?',
      'Hi {{customer_first_name}},\n\nThank you for choosing Bounce Man for your event! We hope everyone had a blast.\n\nWould you take a moment to leave us a review? It helps other families find us!\n\n{{review_link}}\n\nThank you!\n\n- Bounce Man LLC',
      'post_event', 1],
    ['Weather Alert', 'weather-alert', 'Weather Update for Your Bounce Man Rental ({{booking_number}})',
      'Hi {{customer_first_name}},\n\nWe\'re monitoring weather conditions for your upcoming event on {{event_date}}.\n\n{{weather_message}}\n\nPlease contact us if you\'d like to reschedule.\n\n- Bounce Man LLC\n{{company_phone}}',
      'weather_alert', 1],
    ['Booking Quote', 'booking-quote', 'Your Bounce Man Rental Quote ({{booking_number}})',
      'Hi {{customer_first_name}},\n\nThanks for your interest in Bounce Man!\n\nHere\'s your quote:\n\nItems: {{items_list}}\nEvent Date: {{event_date}}\nSubtotal: ${{subtotal}}\nDelivery: ${{delivery_fee}}\nTax: ${{tax_amount}}\nTotal: ${{total}}\n\nReady to book? Click here: {{booking_link}}\n\nThis quote is valid for 7 days.\n\n- Bounce Man LLC\n{{company_phone}}',
      'quote_created', 1],
    ['Contract Reminder', 'contract-reminder', 'Please Sign Your Rental Agreement ({{booking_number}})',
      'Hi {{customer_first_name}},\n\nWe noticed you haven\'t signed your rental agreement yet for booking #{{booking_number}} on {{event_date}}.\n\nPlease sign here: {{contract_link}}\n\nWe need the signed agreement before we can confirm delivery.\n\nThank you!\n\n- Bounce Man LLC',
      'contract_reminder', 1]
  ];
  for (const [name, slug, subject, body, trigger, active] of templates) {
    emailInsert.run(uuid(), name, slug, subject, body, trigger, active);
  }

  // Seed default contract template
  const contractInsert = d.prepare('INSERT OR IGNORE INTO contract_templates (id, name, content, is_default, active) VALUES (?, ?, ?, ?, ?)');
  const contractExists = d.prepare('SELECT id FROM contract_templates WHERE is_default = 1').get();
  if (!contractExists) {
    const contractContent = [
      'BOUNCE MAN LLC — RENTAL AGREEMENT',
      '',
      'This Rental Agreement ("Agreement") is entered into between Bounce Man LLC ("Company") and the undersigned customer ("Renter").',
      '',
      'BOOKING DETAILS:',
      'Booking #: {{booking_number}}',
      'Event Date: {{event_date}}',
      'Event Time: {{event_start_time}} – {{event_end_time}}',
      'Delivery Address: {{delivery_address}}',
      'Equipment: {{items_list}}',
      '',
      'TERMS AND CONDITIONS:',
      '',
      '1. RENTAL PERIOD: The rental period begins at the scheduled delivery time and ends at the scheduled pickup time.',
      '',
      '2. SUPERVISION: Renter agrees to provide adult supervision (18+) at all times while equipment is in use.',
      '',
      '3. SAFETY: No shoes, sharp objects, silly string, or food/drinks on or in equipment. Maximum capacity must be observed.',
      '',
      '4. WEATHER: Equipment must not be used in rain, high winds (over 15 mph), lightning, or severe weather.',
      '',
      '5. SETUP: Renter will provide a flat, clear area free of debris. A standard 110V outlet within 100 feet is required.',
      '',
      '6. DAMAGE/LOSS: Renter is responsible for damage beyond normal wear. Replacement costs billed at current value.',
      '',
      '7. CANCELLATION: All deposits are non-refundable but may be applied toward a future rental date. If Bounce Man LLC cancels due to weather or safety concerns, Renter will receive a full refund or free reschedule.',
      '',
      '8. LIABILITY WAIVER: Renter assumes all risk. Renter holds Bounce Man LLC harmless from any claims or injuries.',
      '',
      '9. INDEMNIFICATION: Renter indemnifies Bounce Man LLC, its owners, employees, and agents from any liability.',
      '',
      '10. PAYMENT: Total rental amount is due as agreed. A 50% non-refundable deposit is required at booking. Remaining balance is due on delivery day.',
      '',
      'TOTAL: ${{total}}',
      'DEPOSIT: ${{deposit_amount}}',
      '',
      'By signing below, Renter acknowledges they have read and agree to all terms.',
      '',
      'Renter Signature: ________________________  Date: ____________',
      'Renter Name (Print): {{customer_name}}'
    ].join('\n');
    contractInsert.run(uuid(), 'Standard Rental Agreement', contractContent, 1, 1);
  }

  // Seed default delivery zones
  const zoneInsert = d.prepare('INSERT OR IGNORE INTO delivery_zones (id, name, zip_codes, delivery_fee, active) VALUES (?, ?, ?, ?, ?)');
  const zoneExists = d.prepare('SELECT id FROM delivery_zones LIMIT 1').get();
  if (!zoneExists) {
    zoneInsert.run(uuid(), 'Local (FREE Delivery)', '74653,74601,74602,74604,74631,74647,74632,74641', 0, 1);
    zoneInsert.run(uuid(), 'Nearby ($35)', '74073,74644,74646,74651,74630', 35, 1);
    zoneInsert.run(uuid(), 'Extended ($65)', '74074,74075,74076,74078,74058,74056', 65, 1);
  }

  // Seed default ad rules (all disabled)
  const adRulesCount = d.prepare('SELECT COUNT(*) as c FROM ad_rules').get().c;
  if (adRulesCount === 0) {
    const ruleInsert = d.prepare('INSERT OR IGNORE INTO ad_rules (id, name, description, rule_type, conditions, actions, enabled) VALUES (?, ?, ?, ?, ?, ?, 0)');
    ruleInsert.run(uuid(), 'Auto-Pause on Full Weekends', 'When all equipment is booked for Saturday, pause ads for that week', 'availability', JSON.stringify({condition:'all_equipment_booked',day:'saturday'}), JSON.stringify({action:'pause_all_campaigns'}));
    ruleInsert.run(uuid(), 'Weekend Budget Boost', 'Increase budget 50% on Thursday and Friday', 'schedule', JSON.stringify({days:['thursday','friday']}), JSON.stringify({action:'increase_budget',percent:50}));
    ruleInsert.run(uuid(), 'Seasonal Scaling', 'Full budget May-Sep, 50% Oct-Apr', 'schedule', JSON.stringify({full_months:[5,6,7,8,9],half_months:[1,2,3,4,10,11,12]}), JSON.stringify({action:'scale_budget',full:1.0,half:0.5}));
    ruleInsert.run(uuid(), 'Low Inventory Alert', 'Reduce budget when fewer than 2 units available', 'inventory', JSON.stringify({condition:'available_units_lt',threshold:2}), JSON.stringify({action:'reduce_budget',percent:50}));
  }

  // Migration: add bot_paused column to communications
  try {
    d.prepare('ALTER TABLE communications ADD COLUMN bot_paused INTEGER DEFAULT 0').run();
  } catch (e) { /* column already exists */ }

  // Migration: add sms_consent column to bookings
  try {
    d.prepare('ALTER TABLE bookings ADD COLUMN sms_consent INTEGER DEFAULT 0').run();
  } catch (e) { /* column already exists */ }

  // Migration: add tax_exempt_claimed column to bookings
  try {
    d.prepare('ALTER TABLE bookings ADD COLUMN tax_exempt_claimed INTEGER DEFAULT 0').run();
  } catch (e) { /* column already exists */ }

  // Migration: add tax_exempt columns to customers
  try {
    d.prepare('ALTER TABLE customers ADD COLUMN tax_exempt INTEGER DEFAULT 0').run();
  } catch (e) { /* column already exists */ }
  try {
    d.prepare('ALTER TABLE customers ADD COLUMN tax_exempt_cert TEXT').run();
  } catch (e) { /* column already exists */ }


  // Migration: blocked_numbers table for spam call filtering
  try {
    d.prepare(`CREATE TABLE IF NOT EXISTS blocked_numbers (
      id TEXT PRIMARY KEY,
      number TEXT UNIQUE NOT NULL,
      reason TEXT,
      auto_blocked INTEGER DEFAULT 0,
      blocked_at TEXT DEFAULT (datetime('now'))
    )`).run();
  } catch (e) { /* already exists */ }

  // Migration: call_log table for inbound call tracking
  try {
    d.prepare(`CREATE TABLE IF NOT EXISTS call_log (
      id TEXT PRIMARY KEY,
      caller_number TEXT NOT NULL,
      vapi_call_id TEXT,
      status TEXT NOT NULL,
      block_reason TEXT,
      called_at TEXT DEFAULT (datetime('now'))
    )`).run();
  } catch (e) { /* already exists */ }


  // Migration: add slack_reminder_sent_date to bookings (dedup delivery reminders)
  try {
    d.prepare('ALTER TABLE bookings ADD COLUMN slack_reminder_sent_date TEXT').run();
  } catch {} // column already exists
  try {
    d.prepare('ALTER TABLE bookings ADD COLUMN email_reminder_sent_date TEXT').run();
  } catch {} // column already exists
  // Migration: add Slack live card tracking columns
  try {
    d.prepare('ALTER TABLE bookings ADD COLUMN slack_message_ts TEXT').run();
  } catch {} // column already exists
  try {
    d.prepare('ALTER TABLE bookings ADD COLUMN slack_message_channel TEXT').run();
  } catch {} // column already exists
  console.log('[DB] Database initialized successfully');
}

module.exports = { getDb, initialize };
