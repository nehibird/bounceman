const db = require("better-sqlite3")("./data/bounceman.db");
const crypto = require("crypto");

// Generate UUIDs
const customerId = crypto.randomUUID();
const bookingId = crypto.randomUUID();
const bookingItemId = crypto.randomUUID();

// Customer data
const customer = {
  id: customerId,
  first_name: "Chris",
  last_name: "Young",
  email: "okcchrisjyoung@gmail.com",
  phone: "5806280870",
  address: "1603 E Grand",
  city: "Tonkawa",
  state: "OK",
  zip: "74653"
};

// Insert customer
db.prepare(`INSERT INTO customers (id, first_name, last_name, email, phone, address, city, state, zip, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`).run(
  customer.id, customer.first_name, customer.last_name, customer.email, customer.phone,
  customer.address, customer.city, customer.state, customer.zip
);
console.log("Customer created:", customer.id);

// Booking data
const booking = {
  id: bookingId,
  booking_number: "BM-MNNTAXSY-WXA",
  customer_id: customerId,
  status: "confirmed",
  event_date: "2026-05-02",
  event_start_time: "09:00",
  event_end_time: "17:00",
  venue_type: "residential",
  delivery_address: "1603 E Grand",
  delivery_city: "Tonkawa",
  delivery_state: "OK",
  delivery_zip: "74653",
  subtotal: 320.00,
  tax_amount: 27.20,
  tax_rate: 0.085,
  total: 347.20,
  deposit_amount: 173.60,
  deposit_paid: 1,
  balance_due: 173.60,
  payment_status: "deposit_paid"
};

// Insert booking
db.prepare(`INSERT INTO bookings (id, booking_number, customer_id, status, event_date, event_start_time, event_end_time,
  venue_type, delivery_address, delivery_city, delivery_state, delivery_zip,
  subtotal, tax_amount, tax_rate, total, deposit_amount, deposit_paid, balance_due, payment_status, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`).run(
  booking.id, booking.booking_number, booking.customer_id, booking.status, booking.event_date,
  booking.event_start_time, booking.event_end_time, booking.venue_type, booking.delivery_address,
  booking.delivery_city, booking.delivery_state, booking.delivery_zip,
  booking.subtotal, booking.tax_amount, booking.tax_rate, booking.total,
  booking.deposit_amount, booking.deposit_paid, booking.balance_due, booking.payment_status
);
console.log("Booking created:", booking.booking_number);

// Booking item - Blue Crush Slide (Wet)
const equipmentId = "97effaab-e5e5-4acd-8963-293756fe8d46";
db.prepare(`INSERT INTO booking_items (id, booking_id, equipment_id, item_name, quantity, unit_price, subtotal, is_wet)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
  bookingItemId, bookingId, equipmentId, "Blue Crush Slide (Wet)", 1, 320.00, 320.00, 1
);
console.log("Booking item added: Blue Crush Slide (Wet)");

// Verify
const count = db.prepare("SELECT COUNT(*) as c FROM bookings").get().c;
console.log("Total bookings now:", count);
