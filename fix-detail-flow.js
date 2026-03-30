const fs = require('fs');

let detail = fs.readFileSync('views/public/equipment-detail.ejs', 'utf8');

// Replace the price tiers to be clickable radio buttons styled as the existing cards
const oldPriceTiers = `        <!-- Price Tiers -->
        <div class="row g-3 mb-3">
          <div class="col-4">
            <div style="background:#f8f9fa;border-radius:12px;padding:15px;text-align:center;border:2px solid transparent" class="price-tier-card">
              <div style="font-size:12px;color:#888;font-weight:600;text-transform:uppercase">4 Hours</div>
              <div style="font-size:24px;font-weight:700;color:var(--bm-orange)">$\${parseFloat(item.price_4hr || item.price_daily * 0.65).toFixed(0)}</div>
            </div>
          </div>
          <div class="col-4">
            <div style="background:var(--bm-blue);border-radius:12px;padding:15px;text-align:center;color:white;position:relative">
              <div style="position:absolute;top:-10px;left:50%;transform:translateX(-50%);background:var(--bm-orange);color:white;font-size:10px;font-weight:700;padding:2px 10px;border-radius:10px">POPULAR</div>
              <div style="font-size:12px;opacity:0.8;font-weight:600;text-transform:uppercase">Full Day</div>
              <div style="font-size:24px;font-weight:700">$\${parseFloat(item.price_daily).toFixed(0)}</div>
            </div>
          </div>
          <div class="col-4">
            <div style="background:#f8f9fa;border-radius:12px;padding:15px;text-align:center;border:2px solid transparent" class="price-tier-card">
              <div style="font-size:12px;color:#888;font-weight:600;text-transform:uppercase">Overnight</div>
              <div style="font-size:24px;font-weight:700;color:var(--bm-orange)">$\${parseFloat(item.price_overnight || item.price_daily * 1.15).toFixed(0)}</div>
            </div>
          </div>
        </div>`;

const newPriceTiers = `        <!-- Price Tiers (clickable duration selector) -->
        <div class="row g-3 mb-0">
          <div class="col-4">
            <input type="radio" name="time_slot" value="4hr" id="tier4hr" class="btn-check" form="inlineBookingForm">
            <label class="d-block" for="tier4hr" style="background:#f8f9fa;border-radius:12px;padding:15px;text-align:center;border:2px solid transparent;cursor:pointer;transition:all 0.2s" id="tierLabel4hr">
              <div style="font-size:12px;color:#888;font-weight:600;text-transform:uppercase">4 Hours</div>
              <div style="font-size:24px;font-weight:700;color:var(--bm-orange)">$\${parseFloat(item.price_4hr || item.price_daily * 0.65).toFixed(0)}</div>
            </label>
          </div>
          <div class="col-4">
            <input type="radio" name="time_slot" value="fullday" id="tierFullDay" class="btn-check" form="inlineBookingForm" checked>
            <label class="d-block" for="tierFullDay" style="background:var(--bm-blue);border-radius:12px;padding:15px;text-align:center;color:white;position:relative;cursor:pointer;transition:all 0.2s" id="tierLabelFullDay">
              <div style="position:absolute;top:-10px;left:50%;transform:translateX(-50%);background:var(--bm-orange);color:white;font-size:10px;font-weight:700;padding:2px 10px;border-radius:10px">POPULAR</div>
              <div style="font-size:12px;opacity:0.8;font-weight:600;text-transform:uppercase">Full Day</div>
              <div style="font-size:24px;font-weight:700">$\${parseFloat(item.price_daily).toFixed(0)}</div>
            </label>
          </div>
          <div class="col-4">
            <input type="radio" name="time_slot" value="overnight" id="tierOvernight" class="btn-check" form="inlineBookingForm">
            <label class="d-block" for="tierOvernight" style="background:#f8f9fa;border-radius:12px;padding:15px;text-align:center;border:2px solid transparent;cursor:pointer;transition:all 0.2s" id="tierLabelOvernight">
              <div style="font-size:12px;color:#888;font-weight:600;text-transform:uppercase">Overnight</div>
              <div style="font-size:24px;font-weight:700;color:var(--bm-orange)">$\${parseFloat(item.price_overnight || item.price_daily * 1.15).toFixed(0)}</div>
            </label>
          </div>
        </div>

        <!-- Morning/Afternoon sub-choice (appears when 4hr selected) -->
        <div id="timeSlotChoice" class="row g-2 mt-2 mb-3" style="display:none">
          <div class="col-6">
            <input type="radio" name="time_window" value="morning" id="winMorning" class="btn-check" form="inlineBookingForm" checked>
            <label class="btn btn-outline-secondary w-100 text-center" for="winMorning" style="padding:10px;border-radius:12px">
              <div class="fw-bold"><i class="fas fa-sun me-1" style="color:#f59e0b"></i>Morning</div>
              <div class="small text-muted">9 AM - 1 PM</div>
            </label>
          </div>
          <div class="col-6">
            <input type="radio" name="time_window" value="afternoon" id="winAfternoon" class="btn-check" form="inlineBookingForm">
            <label class="btn btn-outline-secondary w-100 text-center" for="winAfternoon" style="padding:10px;border-radius:12px">
              <div class="fw-bold"><i class="fas fa-cloud-sun me-1" style="color:#f97316"></i>Afternoon</div>
              <div class="small text-muted">3 PM - 7 PM</div>
            </label>
          </div>
        </div>
        <div id="tierSpacer" class="mb-3"></div>`;

detail = detail.replace(oldPriceTiers, newPriceTiers);

// Now remove the duplicate "Step 1: Choose Duration" section from the inline booking form
const oldStep1 = `          <!-- Step 1: Select Duration -->
          <div class="bg-white rounded-4 p-4 shadow-sm mb-4" id="stepDuration">
            <h6 style="color:var(--bm-blue);font-weight:700;margin-bottom:16px"><i class="fas fa-clock me-2"></i>1. Choose Duration</h6>
            <div class="row g-2">
              <div class="col-6">
                <input type="radio" name="time_slot" value="4hr" id="slot4hr" class="btn-check">
                <label class="btn btn-outline-primary w-100 text-start" for="slot4hr" style="padding:12px;border-radius:12px">
                  <div class="fw-bold">4 Hours</div>
                  <div class="small text-muted">$\${parseFloat(item.price_4hr || item.price_daily * 0.65).toFixed(0)}</div>
                </label>
              </div>
              <div class="col-6">
                <input type="radio" name="time_slot" value="fullday" id="slotFullDay" class="btn-check" checked>
                <label class="btn btn-outline-primary w-100 text-start" for="slotFullDay" style="padding:12px;border-radius:12px">
                  <div class="fw-bold">Full Day</div>
                  <div class="small text-muted">$\${parseFloat(item.price_daily).toFixed(0)}</div>
                </label>
              </div>
              <div class="col-6">
                <input type="radio" name="time_slot" value="overnight" id="slotOvernight" class="btn-check">
                <label class="btn btn-outline-primary w-100 text-start" for="slotOvernight" style="padding:12px;border-radius:12px">
                  <div class="fw-bold">Overnight</div>
                  <div class="small text-muted">$\${parseFloat(item.price_overnight || item.price_daily * 1.15).toFixed(0)}</div>
                </label>
              </div>
            </div>

            <!-- Sub-choice for 4hr: Morning or Afternoon -->
            <div id="timeSlotChoice" class="mt-3" style="display:none">
              <div class="row g-2">
                <div class="col-6">
                  <input type="radio" name="time_window" value="morning" id="winMorning" class="btn-check" checked>
                  <label class="btn btn-outline-secondary w-100 text-start" for="winMorning" style="padding:10px;border-radius:12px">
                    <div class="fw-bold"><i class="fas fa-sun me-1" style="color:#f59e0b"></i>Morning</div>
                    <div class="small text-muted">9 AM - 1 PM</div>
                  </label>
                </div>
                <div class="col-6">
                  <input type="radio" name="time_window" value="afternoon" id="winAfternoon" class="btn-check">
                  <label class="btn btn-outline-secondary w-100 text-start" for="winAfternoon" style="padding:10px;border-radius:12px">
                    <div class="fw-bold"><i class="fas fa-cloud-sun me-1" style="color:#f97316"></i>Afternoon</div>
                    <div class="small text-muted">3 PM - 7 PM</div>
                  </label>
                </div>
              </div>
            </div>
          </div>`;

detail = detail.replace(oldStep1, '');

// Update step numbers: "2. Pick Your Date" -> "Pick Your Date", "3. Add Extras" -> "Add Extras"
detail = detail.replace('2. Pick Your Date', 'Pick Your Date');
detail = detail.replace('3. Add Extras', 'Add Extras');

// Update the tier styling JS - highlight selected tier
const oldTierScript = `  // Time slot config`;
const newTierScript = `  // Tier visual styling
  function updateTierStyles() {
    var selected = document.querySelector('input[name="time_slot"]:checked');
    // Reset all tiers
    document.getElementById('tierLabel4hr').style.background = '#f8f9fa';
    document.getElementById('tierLabel4hr').style.border = '2px solid transparent';
    document.getElementById('tierLabel4hr').style.color = '';
    document.getElementById('tierLabelFullDay').style.background = '#f8f9fa';
    document.getElementById('tierLabelFullDay').style.border = '2px solid transparent';
    document.getElementById('tierLabelFullDay').style.color = '';
    document.getElementById('tierLabelOvernight').style.background = '#f8f9fa';
    document.getElementById('tierLabelOvernight').style.border = '2px solid transparent';
    document.getElementById('tierLabelOvernight').style.color = '';

    if (selected) {
      var label = document.getElementById('tierLabel' + {
        '4hr': '4hr',
        'fullday': 'FullDay',
        'overnight': 'Overnight'
      }[selected.value]);
      if (label) {
        label.style.background = 'var(--bm-blue)';
        label.style.border = '2px solid var(--bm-blue)';
        label.style.color = 'white';
      }
    }
  }

  // Time slot config`;

detail = detail.replace(oldTierScript, newTierScript);

// Add updateTierStyles call to the slot change handler
detail = detail.replace(
  `      updateHiddenFields();
    });
  });

  document.querySelectorAll('input[name="time_window"]')`,
  `      updateHiddenFields();
      updateTierStyles();
    });
  });

  // Initialize tier styles
  updateTierStyles();

  document.querySelectorAll('input[name="time_window"]')`
);

fs.writeFileSync('views/public/equipment-detail.ejs', detail);
console.log('Updated detail page - price tiers are now the duration selector');
