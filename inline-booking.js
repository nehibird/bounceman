const fs = require('fs');

// ============================================
// 1. Update route to pass addons
// ============================================
let routes = fs.readFileSync('routes/public.js', 'utf8');

routes = routes.replace(
  `  res.render('public/equipment-detail', {
    title: \`\${item.name} - Bounce Man Rentals\`,
    settings,
    item,
    images,
    related,
    reviews,
    page: 'equipment'
  });`,
  `  // Get add-ons
  const addons = db.prepare(\`
    SELECT e.*,
      (SELECT image_path FROM equipment_images WHERE equipment_id = e.id AND is_primary = 1 LIMIT 1) as image
    FROM equipment e
    WHERE e.category = 'add_ons' AND e.status = 'available'
    ORDER BY e.sort_order
  \`).all();

  res.render('public/equipment-detail', {
    title: \`\${item.name} - Bounce Man Rentals\`,
    settings,
    item,
    images,
    related,
    reviews,
    addons,
    page: 'equipment'
  });`
);

fs.writeFileSync('routes/public.js', routes);
console.log('Updated route to pass addons');

// ============================================
// 2. Rewrite the booking section of equipment-detail.ejs
// ============================================
let detail = fs.readFileSync('views/public/equipment-detail.ejs', 'utf8');

// Replace everything from Check Availability through Book Button with inline booking
const oldBooking = `        <!-- Check Availability -->
        <div class="bg-white rounded-4 p-4 shadow-sm mb-4">
          <h6 style="color:var(--bm-blue);font-weight:700;margin-bottom:16px"><i class="fas fa-calendar-alt me-2"></i>Check Availability</h6>
          <div class="input-group">
            <input type="text" id="availDate" class="form-control" placeholder="Select a date..." readonly style="border-radius:12px 0 0 12px">
            <button id="checkAvailBtn" class="btn" style="background:var(--bm-blue);color:white;border-radius:0 12px 12px 0;font-weight:600">
              <i class="fas fa-search me-1"></i>Check
            </button>
          </div>
          <div id="availResult" class="mt-3" style="display:none"></div>
        </div>

        <!-- Book Button -->
        <a href="/booking?items=\${item.id}" class="btn btn-book-now btn-lg w-100 mb-3">
          <i class="fas fa-calendar-check me-2"></i>Book This Item
        </a>

        \${item.deposit_amount ? \`
        <p class="text-center text-muted small"><i class="fas fa-info-circle me-1"></i>A $\${parseFloat(item.deposit_amount).toFixed(0)} deposit is required to reserve.</p>
        \` : ''}`;

const newBooking = `        <!-- Inline Booking Flow -->
        <form id="inlineBookingForm" action="/booking/details" method="GET">
          <input type="hidden" name="items" value="\${item.id}">
          <input type="hidden" name="rental_duration" id="hiddenDuration" value="daily">
          <input type="hidden" name="event_start_time" id="hiddenStart" value="09:00">
          <input type="hidden" name="event_end_time" id="hiddenEnd" value="19:00">

          <!-- Step 1: Select Duration -->
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
          </div>

          <!-- Step 2: Pick Date -->
          <div class="bg-white rounded-4 p-4 shadow-sm mb-4">
            <h6 style="color:var(--bm-blue);font-weight:700;margin-bottom:16px"><i class="fas fa-calendar-alt me-2"></i>2. Pick Your Date</h6>
            <div class="input-group">
              <input type="text" id="availDate" name="event_date" class="form-control" placeholder="Select a date..." readonly style="border-radius:12px 0 0 12px" required>
              <button type="button" id="checkAvailBtn" class="btn" style="background:var(--bm-blue);color:white;border-radius:0 12px 12px 0;font-weight:600">
                <i class="fas fa-search me-1"></i>Check
              </button>
            </div>
            <div id="availResult" class="mt-3" style="display:none"></div>
          </div>

          <!-- Step 3: Add-Ons (shown after date is checked) -->
          \${(typeof addons !== 'undefined' && addons.length > 0) ? \`
          <div class="bg-white rounded-4 p-4 shadow-sm mb-4" id="addonSection" style="display:none">
            <h6 style="color:var(--bm-blue);font-weight:700;margin-bottom:16px"><i class="fas fa-plus-circle me-2"></i>3. Add Extras</h6>
            \${addons.map(addon => \`
            <div class="d-flex align-items-center gap-3 p-3 rounded-3" style="background:#f8f9fa">
              <i class="fas fa-music" style="font-size:20px;color:var(--bm-orange)"></i>
              <div style="flex:1">
                <div class="fw-bold">\${addon.name}</div>
                <div class="text-muted small">\${addon.short_description || ''}</div>
              </div>
              <div class="text-end me-2">
                <span class="fw-bold" style="color:var(--bm-orange)">+$\${parseFloat(addon.price_4hr).toFixed(0)}</span>
              </div>
              <input type="checkbox" name="addon_ids" value="\${addon.id}" class="form-check-input" style="width:22px;height:22px;cursor:pointer">
            </div>
            \`).join('')}
          </div>
          \` : ''}

          <!-- Book Button -->
          <button type="submit" class="btn btn-book-now btn-lg w-100 mb-3" id="bookBtn">
            <i class="fas fa-calendar-check me-2"></i>Continue to Details
          </button>
        </form>

        \${item.deposit_amount ? \`
        <p class="text-center text-muted small"><i class="fas fa-info-circle me-1"></i>A $\${parseFloat(item.deposit_amount).toFixed(0)} deposit is required to reserve.</p>
        \` : ''}`;

detail = detail.replace(oldBooking, newBooking);

// Update the script section
const oldScript = `  // Flatpickr date picker
  flatpickr('#availDate', {
    minDate: 'today',
    dateFormat: 'Y-m-d',
    disableMobile: true
  });

  // Availability check
  document.getElementById('checkAvailBtn').addEventListener('click', function() {
    var date = document.getElementById('availDate').value;
    var resultDiv = document.getElementById('availResult');
    if (!date) {
      resultDiv.style.display = 'block';
      resultDiv.innerHTML = '<div class="alert alert-warning mb-0 py-2"><i class="fas fa-exclamation-triangle me-1"></i>Please select a date first.</div>';
      return;
    }
    resultDiv.style.display = 'block';
    resultDiv.innerHTML = '<div class="text-center text-muted py-2"><i class="fas fa-spinner fa-spin me-1"></i>Checking...</div>';

    fetch('/check-availability?item_id=\${item.id}&date=' + encodeURIComponent(date))
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (data.available) {
          resultDiv.innerHTML = '<div class="alert alert-success mb-0 py-2"><i class="fas fa-check-circle me-1"></i>Available on ' + date + '! <a href="/booking?items=\${item.id}&date=' + date + '" class="alert-link">Book now</a></div>';
        } else {
          resultDiv.innerHTML = '<div class="alert alert-danger mb-0 py-2"><i class="fas fa-times-circle me-1"></i>Sorry, not available on ' + date + '. Try another date.</div>';
        }
      })
      .catch(function() {
        resultDiv.innerHTML = '<div class="alert alert-danger mb-0 py-2"><i class="fas fa-exclamation-circle me-1"></i>Could not check availability. Please try again.</div>';
      });
  });`;

const newScript = `  // Flatpickr date picker
  flatpickr('#availDate', {
    minDate: 'today',
    dateFormat: 'Y-m-d',
    disableMobile: true
  });

  // Time slot config
  var slotConfig = {
    '4hr-morning':   { duration: '4hr',       start: '09:00', end: '13:00' },
    '4hr-afternoon': { duration: '4hr',       start: '15:00', end: '19:00' },
    fullday:         { duration: 'daily',     start: '09:00', end: '19:00' },
    overnight:       { duration: 'overnight', start: '15:00', end: '10:00' }
  };

  function updateHiddenFields() {
    var slot = document.querySelector('input[name="time_slot"]:checked');
    if (!slot) return;
    var key = slot.value;
    if (key === '4hr') {
      var win = document.querySelector('input[name="time_window"]:checked');
      key = '4hr-' + (win ? win.value : 'morning');
    }
    var config = slotConfig[key];
    if (config) {
      document.getElementById('hiddenDuration').value = config.duration;
      document.getElementById('hiddenStart').value = config.start;
      document.getElementById('hiddenEnd').value = config.end;
    }
  }

  // Show/hide 4hr sub-choice
  document.querySelectorAll('input[name="time_slot"]').forEach(function(radio) {
    radio.addEventListener('change', function() {
      var subChoice = document.getElementById('timeSlotChoice');
      if (this.value === '4hr') {
        subChoice.style.display = 'block';
      } else {
        subChoice.style.display = 'none';
      }
      updateHiddenFields();
    });
  });

  document.querySelectorAll('input[name="time_window"]').forEach(function(radio) {
    radio.addEventListener('change', updateHiddenFields);
  });

  // Availability check
  document.getElementById('checkAvailBtn').addEventListener('click', function() {
    var date = document.getElementById('availDate').value;
    var resultDiv = document.getElementById('availResult');
    if (!date) {
      resultDiv.style.display = 'block';
      resultDiv.innerHTML = '<div class="alert alert-warning mb-0 py-2"><i class="fas fa-exclamation-triangle me-1"></i>Please select a date first.</div>';
      return;
    }
    resultDiv.style.display = 'block';
    resultDiv.innerHTML = '<div class="text-center text-muted py-2"><i class="fas fa-spinner fa-spin me-1"></i>Checking...</div>';

    fetch('/check-availability?item_id=\${item.id}&date=' + encodeURIComponent(date))
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (data.available) {
          resultDiv.innerHTML = '<div class="alert alert-success mb-0 py-2"><i class="fas fa-check-circle me-1"></i>Available on ' + date + '!</div>';
          // Show add-ons section
          var addonSection = document.getElementById('addonSection');
          if (addonSection) addonSection.style.display = 'block';
        } else {
          resultDiv.innerHTML = '<div class="alert alert-danger mb-0 py-2"><i class="fas fa-times-circle me-1"></i>Sorry, not available on ' + date + '. Try another date.</div>';
          var addonSection = document.getElementById('addonSection');
          if (addonSection) addonSection.style.display = 'none';
        }
      })
      .catch(function() {
        resultDiv.innerHTML = '<div class="alert alert-danger mb-0 py-2"><i class="fas fa-exclamation-circle me-1"></i>Could not check availability. Please try again.</div>';
      });
  });

  // Form validation
  document.getElementById('inlineBookingForm').addEventListener('submit', function(e) {
    if (!document.getElementById('availDate').value) {
      e.preventDefault();
      alert('Please select a date first.');
      return;
    }
    updateHiddenFields();
  });`;

detail = detail.replace(oldScript, newScript);

fs.writeFileSync('views/public/equipment-detail.ejs', detail);
console.log('Updated equipment-detail.ejs with inline booking flow');
