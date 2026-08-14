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
const { taxBreakdown } = require('../lib/helpers');

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
    doc.fillColor(NAVY).fontSize(22).font('Helvetica-Bold').text(BIZ.name, 50, 50);
    doc.fontSize(9).font('Helvetica').fillColor(GREY)
      .text(BIZ.addr, 50, 76).text(BIZ.city).text(BIZ.phone).text(BIZ.email);

    doc.fillColor(ORANGE).fontSize(28).font('Helvetica-Bold').text('INVOICE', 380, 50, { width: 165, align: 'right' });
    doc.fillColor(NAVY).fontSize(9).font('Helvetica')
      .text('Invoice #: ' + booking.booking_number, 330, 86, { width: 215, align: 'right' })
      .text('Issued: ' + new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }), { width: 215, align: 'right' })
      .text('Due: ' + (opts.terms || 'On or before the event date'), { width: 215, align: 'right' });

    doc.moveTo(50, 140).lineTo(545, 140).strokeColor('#DDDDDD').stroke();

    // ---- bill to / event --------------------------------------------------
    let y = 158;
    doc.fontSize(8).fillColor(GREY).font('Helvetica-Bold').text('BILL TO', 50, y);
    doc.fontSize(10).fillColor(NAVY).font('Helvetica');
    let by = y + 14;
    if (opts.billTo) { doc.font('Helvetica-Bold').text(opts.billTo, 50, by); by += 14; doc.font('Helvetica'); }
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
    if (parseFloat(booking.delivery_fee) > 0) {
      doc.text('Delivery & setup', 58, y, { width: 310 })
        .text('1', 380, y, { width: 40, align: 'right' })
        .text(money(booking.delivery_fee), 460, y, { width: 78, align: 'right' });
      y += 24;
    }

    doc.moveTo(50, y).lineTo(545, y).strokeColor('#DDDDDD').stroke();
    y += 12;

    // ---- totals, with sales tax broken out by jurisdiction ----------------
    const line = (label, val, bold, color) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(color || NAVY).fontSize(bold ? 12 : 10)
        .text(label, 300, y, { width: 160, align: 'right' })
        .text(val, 460, y, { width: 78, align: 'right' });
      y += bold ? 20 : 16;
    };

    const subtotal = parseFloat(booking.subtotal) || 0;
    const fee = parseFloat(booking.delivery_fee) || 0;
    line('Subtotal', money(subtotal + fee));

    const taxAmt = parseFloat(booking.tax_amount) || 0;
    if (booking.tax_exempt_claimed) {
      line('Sales tax (exempt)', money(0));
    } else if (taxAmt > 0) {
      const tb = taxBreakdown(booking.delivery_city);
      if (tb) {
        // Tax applies to the rental subtotal; delivery is excluded under
        // OAC 710:65-19-70(b). Split the charged amount across the three
        // jurisdictions so the totals still foot exactly.
        const parts = [
          ['Oklahoma state', tb.stateRate],
          [(tb.countyName ? tb.countyName.charAt(0) + tb.countyName.slice(1).toLowerCase() : '') + ' County', tb.countyRate],
          ['City of ' + (booking.delivery_city || '').replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\B\w/g, (c) => c.toLowerCase()), tb.cityRate],
        ].filter((p) => p[1] > 0);
        let running = 0;
        parts.forEach((p, i) => {
          const amt = i === parts.length - 1
            ? Math.round((taxAmt - running) * 100) / 100
            : Math.round(subtotal * p[1] * 100) / 100;
          running += amt;
          doc.font('Helvetica').fillColor(GREY).fontSize(9)
            .text(p[0] + ' sales tax  ' + (p[1] * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '') + '%', 280, y, { width: 180, align: 'right' })
            .text(money(amt), 460, y, { width: 78, align: 'right' });
          y += 14;
        });
        doc.fillColor(NAVY);
        line('Total sales tax  ' + (tb.total * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '') + '%', money(taxAmt));
      } else {
        line('Sales tax', money(taxAmt));
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
      .text(BIZ.site + '  ·  ' + BIZ.phone, 50, 720, { width: 495, align: 'center' });

    doc.end();
  });
}

module.exports = { buildInvoicePdf };
