'use strict';
/**
 * PDF invoice generator.
 *
 * Built for the bookings that don't pay online — chambers, schools, churches and
 * anyone else who needs a document to hand their treasurer before a check is cut.
 * Sales tax is broken out by jurisdiction (state / county / city) because that is
 * what an organisation's bookkeeper is going to ask for, and because it makes the
 * rate we charged auditable against the OTC COPO chart.
 */
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const { taxBreakdown } = require('../lib/helpers');
const { jurisdictionBreakdown } = require('../lib/ok-tax-data');

// ---- sales-tax split: what was CHARGED, not what the city name implies -------
// An invoice is a document a customer and an auditor rely on, so the split it prints
// must foot to the tax actually stored on the booking (tax_rate / tax_amount). It must
// NOT be re-derived from delivery_city: a booking repriced after a boundary check keeps
// its typed city, and a city rate that was never charged would print again.
//
// Order of preference:
//   1. the jurisdiction stored on the booking (when that column exists and its total
//      equals the stored rate),
//   2. a reconstruction VALIDATED against the stored rate (the typed city only picks a
//      county / candidate city; the stored rate decides whether it is believed),
//   3. otherwise say so: one honest line, no invented breakdown.
const titleCase = (s) => String(s || '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const rateEq = (a, b) => Math.abs(a - b) < 1e-6;

function storedJurisdiction(booking) {
  for (const col of ['tax_jurisdiction', 'tax_jurisdiction_json']) {
    let v = booking[col];
    if (!v) continue;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { continue; } }
    if (v && typeof v === 'object') return v;
  }
  return null;
}

// Returns { parts: [{label, rate}], total, basis, base } or { unreconciled: true, rate }.
function invoiceTaxSplit(booking) {
  const num = (v) => parseFloat(v) || 0;
  const subtotal = num(booking.subtotal);
  const taxAmt = num(booking.tax_amount);
  const bases = [subtotal, Math.max(0, subtotal - Math.abs(num(booking.discount_amount)))];
  let rate = num(booking.tax_rate);
  if (!(rate > 0)) {
    // No stored rate: the only honest rate is the one implied by what was charged.
    const b = bases.find((x) => x > 0);
    rate = b ? Math.round((taxAmt / b) * 1e5) / 1e5 : 0;
  }
  // The rate must actually explain the amount charged (either taxable base, to the cent).
  const base = bases.find((b) => Math.abs(Math.round(b * rate * 100) / 100 - taxAmt) <= 0.011);
  if (!(rate > 0) || base === undefined) return { unreconciled: true, rate };

  const fromBreakdown = (tb, cityLabel, how) => {
    if (!tb || !rateEq(tb.total, rate)) return null;
    const parts = [
      { label: 'Oklahoma state', rate: tb.stateRate },
      { label: titleCase(tb.countyName) + ' County', rate: tb.countyRate },
    ];
    if (cityLabel && tb.cityRate > 0) parts.push({ label: 'City of ' + cityLabel, rate: tb.cityRate });
    return { parts: parts.filter((p) => p.rate > 0), total: tb.total, basis: how, base };
  };

  // 1. stored jurisdiction
  const sj = storedJurisdiction(booking);
  if (sj) {
    const tb = jurisdictionBreakdown(Object.assign({ verified: true }, sj));
    const r = tb && fromBreakdown(tb, tb.unincorporated ? '' : titleCase(tb.key), 'stored');
    if (r) return r;
  }

  // 2. reconstruct, validated against the stored rate
  const typed = taxBreakdown(booking.delivery_city);
  if (typed) {
    const full = typed.cityRate > 0 && fromBreakdown(typed, titleCase(typed.key), 'reconstructed');
    if (full) return full;
    // Same county, no city levy: what an address outside city limits owes.
    const co = fromBreakdown(Object.assign({}, typed, { cityRate: 0, total: typed.stateRate + typed.countyRate }), '', 'reconstructed');
    if (co) return co;
  }

  // 3. cannot be reconciled with any known jurisdiction
  return { unreconciled: true, rate };
}

// The wordmark is a 600x600 PNG whose artwork only occupies the middle band, so a
// naive placement leaves a pile of dead space above and below it. These offsets are
// measured off the actual pixels: art runs roughly x 90-500, y 110-400 of 600.
const LOGO_PATH = path.join(__dirname, '..', 'public', 'assets', 'images', 'wordmark-email.png');
const LOGO_BOX = 150;                    // rendered width/height of the square
const LOGO_ART_TOP = 110 / 600;          // where the art actually starts, as a fraction
const LOGO_ART_BOTTOM = 400 / 600;

const NAVY = '#1A212D';
const ORANGE = '#D77C42';
const GREY = '#666666';

const BIZ = {
  name: 'Bounce Man LLC',
  addr: '113 N Barrick Way',
  city: 'Tonkawa, OK 74653',
  phone: '(580) 308-9288',
  email: 'info@bouncemanrentals.com',
  site: 'bouncemanrentals.com',
};

const money = (n) => '$' + (Math.round((parseFloat(n) || 0) * 100) / 100).toFixed(2);

function fmtDate(d) {
  try { return new Date(String(d) + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }); }
  catch (e) { return String(d); }
}
function fmtTime(t) {
  if (!t) return '';
  const [h, m] = String(t).split(':').map(Number);
  const ap = h < 12 ? 'AM' : 'PM';
  return ((h % 12) === 0 ? 12 : h % 12) + ':' + String(m || 0).padStart(2, '0') + ' ' + ap;
}

/**
 * Returns a Promise<Buffer> of the finished PDF.
 * opts: { billTo, attn, terms, notes }
 */
function buildInvoicePdf(booking, customer, items, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ---- header -----------------------------------------------------------
    // The wordmark PNG is a 600x600 square whose artwork only occupies the middle
    // band. Rather than fight the padding, the logo gets the top-left corner to
    // itself and the business address moves to the footer — it is already repeated
    // in the PAYMENT box as the remit-to, so nothing is lost.
    let logoBottom = 96;
    try {
      if (fs.existsSync(LOGO_PATH)) {
        doc.image(LOGO_PATH, 46, 30 - LOGO_ART_TOP * LOGO_BOX, { width: LOGO_BOX });
        logoBottom = 30 + (LOGO_ART_BOTTOM - LOGO_ART_TOP) * LOGO_BOX;
      } else {
        doc.fillColor(NAVY).fontSize(22).font('Helvetica-Bold').text(BIZ.name, 50, 50);
      }
    } catch (e) {
      console.error('[INVOICE] logo failed, falling back to text:', e.message);
      doc.fillColor(NAVY).fontSize(22).font('Helvetica-Bold').text(BIZ.name, 50, 50);
    }

    doc.fillColor(ORANGE).fontSize(28).font('Helvetica-Bold').text('INVOICE', 380, 44, { width: 165, align: 'right' });
    doc.fillColor(NAVY).fontSize(9).font('Helvetica')
      .text('Invoice #: ' + booking.booking_number, 300, 80, { width: 245, align: 'right' })
      .text('Issued: ' + new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }), { width: 245, align: 'right' })
      .text('Due: ' + (opts.terms || 'On or before the event date'), { width: 245, align: 'right' });

    const headerBottom = Math.max(126, logoBottom + 16);
    doc.moveTo(50, headerBottom).lineTo(545, headerBottom).strokeColor('#DDDDDD').stroke();

    // ---- bill to / event --------------------------------------------------
    let y = headerBottom + 18;
    doc.fontSize(8).fillColor(GREY).font('Helvetica-Bold').text('BILL TO', 50, y);
    doc.fontSize(10).fillColor(NAVY).font('Helvetica');
    let by = y + 14;
    if (opts.billTo) {
      // Advance by the block's real height. This used to add a flat 14pt no matter how
      // many lines billTo had, so a multi-line address was overprinted by Attn/email/phone.
      doc.font('Helvetica-Bold');
      const bh = doc.heightOfString(opts.billTo, { width: 240 });
      doc.text(opts.billTo, 50, by, { width: 240 });
      by += bh + 4;
      doc.font('Helvetica');
    }
    const who = ((customer.first_name || '') + ' ' + (customer.last_name || '')).trim();
    if (who) { doc.text((opts.billTo ? 'Attn: ' : '') + who, 50, by); by += 14; }
    if (customer.email) { doc.text(customer.email, 50, by); by += 14; }
    if (customer.phone) { doc.text(customer.phone, 50, by); by += 14; }

    doc.fontSize(8).fillColor(GREY).font('Helvetica-Bold').text('EVENT', 320, y);
    doc.fontSize(10).fillColor(NAVY).font('Helvetica');
    let ey = y + 14;
    doc.text(fmtDate(booking.event_date), 320, ey, { width: 225 }); ey += 14;
    if (booking.event_start_time) {
      doc.text(fmtTime(booking.event_start_time) + ' – ' + fmtTime(booking.event_end_time), 320, ey, { width: 225 }); ey += 14;
    }
    const addr = [booking.delivery_address, booking.delivery_city, booking.delivery_state, booking.delivery_zip].filter(Boolean).join(', ');
    if (addr) { doc.text(addr, 320, ey, { width: 225 }); ey += 26; }

    y = Math.max(by, ey) + 14;

    // ---- line items -------------------------------------------------------
    doc.rect(50, y, 495, 20).fill('#F5F5F5');
    doc.fillColor(GREY).fontSize(8).font('Helvetica-Bold')
      .text('DESCRIPTION', 58, y + 6)
      .text('QTY', 380, y + 6, { width: 40, align: 'right' })
      .text('AMOUNT', 460, y + 6, { width: 78, align: 'right' });
    y += 26;

    doc.fontSize(10).font('Helvetica').fillColor(NAVY);
    for (const it of (items || [])) {
      const dur = it.duration_type === '4hr' ? 'Half day (4 hours)'
        : it.duration_type === 'overnight' ? 'Overnight' : 'Full day';
      const wet = it.wet_option ? ' — set up WET' : '';
      doc.text(it.item_name + wet, 58, y, { width: 310 });
      doc.fontSize(8).fillColor(GREY).text(dur, 58, y + 13, { width: 310 });
      doc.fontSize(10).fillColor(NAVY)
        .text(String(it.quantity || 1), 380, y, { width: 40, align: 'right' })
        .text(money(it.total_price != null ? it.total_price : it.unit_price), 460, y, { width: 78, align: 'right' });
      y += 32;
    }
    const extraLine = (label, amount) => {
      doc.text(label, 58, y, { width: 310 })
        .text('1', 380, y, { width: 40, align: 'right' })
        .text(money(amount), 460, y, { width: 78, align: 'right' });
      y += 24;
    };
    if (parseFloat(booking.delivery_fee) > 0) extraLine('Delivery & setup', booking.delivery_fee);
    if (parseFloat(booking.surface_fee) > 0) extraLine('Surface setup (non-grass)', booking.surface_fee);
    if (parseFloat(booking.damage_waiver_fee) > 0) extraLine('Damage waiver', booking.damage_waiver_fee);
    if (parseFloat(booking.discount_amount) > 0) extraLine('Discount', -Math.abs(parseFloat(booking.discount_amount)));

    doc.moveTo(50, y).lineTo(545, y).strokeColor('#DDDDDD').stroke();
    y += 12;

    // ---- totals, with sales tax broken out by jurisdiction ----------------
    const line = (label, val, bold, color) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(color || NAVY).fontSize(bold ? 12 : 10)
        .text(label, 300, y, { width: 160, align: 'right' })
        .text(val, 460, y, { width: 78, align: 'right' });
      y += bold ? 20 : 16;
    };

    const num = (v) => parseFloat(v) || 0;
    const subtotal = num(booking.subtotal);
    const fee = num(booking.delivery_fee);
    // Must equal TOTAL minus tax, or the customer sees an invoice that does not add up.
    const preTax = subtotal + fee + num(booking.surface_fee) + num(booking.damage_waiver_fee)
      - Math.abs(num(booking.discount_amount));
    line('Subtotal', money(preTax));

    const taxAmt = parseFloat(booking.tax_amount) || 0;
    if (booking.tax_exempt_claimed) {
      line('Sales tax (exempt)', money(0));
    } else if (taxAmt > 0) {
      const split = invoiceTaxSplit(booking);
      const pct = (r) => (r * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '') + '%';
      if (!split.unreconciled) {
        // Tax applies to the rental subtotal; delivery is excluded under
        // OAC 710:65-19-70(b). Split the charged amount across the jurisdictions
        // so the totals still foot exactly.
        let running = 0;
        split.parts.forEach((p, i) => {
          const amt = i === split.parts.length - 1
            ? Math.round((taxAmt - running) * 100) / 100
            : Math.round(split.base * p.rate * 100) / 100;
          running += amt;
          doc.font('Helvetica').fillColor(GREY).fontSize(9)
            .text(p.label + ' sales tax  ' + pct(p.rate), 280, y, { width: 180, align: 'right' })
            .text(money(amt), 460, y, { width: 78, align: 'right' });
          y += 14;
        });
        doc.fillColor(NAVY);
        line('Total sales tax  ' + pct(split.total), money(taxAmt));
      } else {
        // The stored rate matches no jurisdiction we can identify: print what was
        // charged and say the breakdown is unavailable, rather than a wrong split.
        line('Sales tax' + (split.rate > 0 ? '  ' + pct(split.rate) : ''), money(taxAmt));
        doc.font('Helvetica').fillColor(GREY).fontSize(8)
          .text('Jurisdiction breakdown not available for this charge.', 280, y - 2, { width: 258, align: 'right' });
        y += 12;
        doc.fillColor(NAVY);
      }
    }

    doc.moveTo(300, y).lineTo(545, y).strokeColor('#DDDDDD').stroke();
    y += 10;
    line('TOTAL', money(booking.total), true);

    const paid = (parseFloat(booking.total) || 0) - (parseFloat(booking.balance_due) || 0);
    if (paid > 0.005) line('Paid to date', '-' + money(paid));
    line('BALANCE DUE', money(booking.balance_due), true, ORANGE);

    // ---- payment instructions --------------------------------------------
    y += 16;
    doc.rect(50, y, 495, 76).fill('#FFF3E8');
    doc.fillColor(NAVY).fontSize(9).font('Helvetica-Bold').text('PAYMENT', 62, y + 12);
    doc.font('Helvetica').fontSize(9).fillColor(GREY)
      .text('Check payable to ' + BIZ.name + ', ' + BIZ.addr + ', ' + BIZ.city + '.', 62, y + 27, { width: 470 })
      .text('We also take cash or card on the day of the event.', 62, y + 40, { width: 470 })
      .text('Questions: ' + BIZ.phone + '  ·  ' + BIZ.email, 62, y + 53, { width: 470 });
    y += 92;

    if (opts.notes) {
      doc.fillColor(GREY).fontSize(8).text(opts.notes, 50, y, { width: 495 });
      y += 24;
    }

    doc.fillColor('#AAAAAA').fontSize(8)
      .text(BIZ.name + '  ·  ' + BIZ.addr + ', ' + BIZ.city, 50, 712, { width: 495, align: 'center' })
      .text(BIZ.site + '  ·  ' + BIZ.phone + '  ·  ' + BIZ.email, 50, 724, { width: 495, align: 'center' });

    doc.end();
  });
}

module.exports = { buildInvoicePdf, invoiceTaxSplit };
