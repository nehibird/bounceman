const fs = require('fs');

let step2 = fs.readFileSync('views/public/booking/step2-date.ejs', 'utf8');

// Replace the rental duration selector + time picker sections with fixed time slots
const oldDuration = `          <!-- Rental Duration Selector -->
          <div class="date-card mb-4">
            <h6 class="fw-bold mb-3"><i class="fas fa-clock me-2"></i>Rental Duration</h6>
            <div class="row g-3">
              <div class="col-4">
                <input type="radio" name="rental_duration" value="4hr" id="dur4hr" class="btn-check">
                <label class="btn btn-outline-primary w-100 rounded-pill" for="dur4hr" style="padding:12px">
                  <div class="fw-bold">4 Hours</div>
                  <div class="small">Quick party</div>
                </label>
              </div>
              <div class="col-4">
                <input type="radio" name="rental_duration" value="daily" id="durDaily" class="btn-check" checked>
                <label class="btn btn-outline-primary w-100 rounded-pill" for="durDaily" style="padding:12px">
                  <div class="fw-bold">Full Day</div>
                  <div class="small">8 hours</div>
                </label>
              </div>
              <div class="col-4">
                <input type="radio" name="rental_duration" value="overnight" id="durOvernight" class="btn-check">
                <label class="btn btn-outline-primary w-100 rounded-pill" for="durOvernight" style="padding:12px">
                  <div class="fw-bold">Overnight</div>
                  <div class="small">Next-day pickup</div>
                </label>
              </div>
            </div>
          </div>

          <div class="date-card mb-4">
            <h5 style="color:var(--bm-blue);font-weight:700;" class="mb-3"><i class="fas fa-clock me-2"></i>Event Time</h5>
            <div class="row g-3">
              <div class="col-md-6">
                <label class="form-label fw-bold">Start Time</label>
                <select name="event_start_time" id="startTime" class="time-select" required>
                  <option value="">Select start time...</option>
                </select>
              </div>
              <div class="col-md-6">
                <label class="form-label fw-bold">End Time</label>
                <select name="event_end_time" id="endTime" class="time-select" required>
                  <option value="">Select end time...</option>
                </select>
              </div>
            </div>
            <p class="text-muted small mt-2 mb-0" id="timeHint"><i class="fas fa-info-circle me-1"></i>Times auto-set based on rental duration. You can adjust if needed.</p>
          </div>`;

const newDuration = `          <!-- Time Slot Selection -->
          <div class="date-card mb-4">
            <h5 style="color:var(--bm-blue);font-weight:700;" class="mb-3"><i class="fas fa-clock me-2"></i>Choose Your Time Slot</h5>
            <div class="row g-3">
              <div class="col-md-6">
                <input type="radio" name="time_slot" value="morning" id="slotMorning" class="btn-check">
                <label class="btn btn-outline-primary w-100 text-start" for="slotMorning" style="padding:16px;border-radius:12px">
                  <div class="fw-bold"><i class="fas fa-sun me-2" style="color:#f59e0b"></i>Morning</div>
                  <div class="text-muted small">9:00 AM - 1:00 PM (4 hours)</div>
                </label>
              </div>
              <div class="col-md-6">
                <input type="radio" name="time_slot" value="afternoon" id="slotAfternoon" class="btn-check">
                <label class="btn btn-outline-primary w-100 text-start" for="slotAfternoon" style="padding:16px;border-radius:12px">
                  <div class="fw-bold"><i class="fas fa-cloud-sun me-2" style="color:#f97316"></i>Afternoon</div>
                  <div class="text-muted small">3:00 PM - 7:00 PM (4 hours)</div>
                </label>
              </div>
              <div class="col-md-6">
                <input type="radio" name="time_slot" value="fullday" id="slotFullDay" class="btn-check" checked>
                <label class="btn btn-outline-primary w-100 text-start" for="slotFullDay" style="padding:16px;border-radius:12px">
                  <div class="fw-bold"><i class="fas fa-calendar-day me-2" style="color:#3b82f6"></i>Full Day</div>
                  <div class="text-muted small">9:00 AM - 7:00 PM (10 hours)</div>
                </label>
              </div>
              <div class="col-md-6">
                <input type="radio" name="time_slot" value="overnight" id="slotOvernight" class="btn-check">
                <label class="btn btn-outline-primary w-100 text-start" for="slotOvernight" style="padding:16px;border-radius:12px">
                  <div class="fw-bold"><i class="fas fa-moon me-2" style="color:#6366f1"></i>Overnight</div>
                  <div class="text-muted small">3:00 PM - 10:00 AM next day</div>
                </label>
              </div>
            </div>
            <input type="hidden" name="rental_duration" id="hiddenDuration2" value="daily">
            <input type="hidden" name="event_start_time" id="startTime" value="09:00">
            <input type="hidden" name="event_end_time" id="endTime" value="19:00">
          </div>`;

step2 = step2.replace(oldDuration, newDuration);

// Update the JavaScript to handle time slot changes
// Find the script section and replace/add slot handling
const oldFormValidation = `  // Form validation
  document.getElementById('dateForm').addEventListener('submit', function(e) {
    if (!document.getElementById('eventDateInput').value) {
      e.preventDefault();
      alert('Please select an event date.');
      return;
    }
    var start = document.getElementById('startTime').value;
    var end = document.getElementById('endTime').value;
    if (!start || !end) {
      e.preventDefault();
      alert('Please select start and end times.');
      return;
    }
    var dur = document.querySelector('input[name="rental_duration"]:checked');
    var durVal = dur ? dur.value : 'daily';
    if (durVal !== 'overnight' && start >= end) {
      e.preventDefault();
      alert('End time must be after start time.');
      return;
    }
  });`;

const newFormValidation = `  // Time slot mapping
  var slotConfig = {
    morning:   { duration: '4hr',       start: '09:00', end: '13:00' },
    afternoon: { duration: '4hr',       start: '15:00', end: '19:00' },
    fullday:   { duration: 'daily',     start: '09:00', end: '19:00' },
    overnight: { duration: 'overnight', start: '15:00', end: '10:00' }
  };

  // Update hidden fields when slot changes
  document.querySelectorAll('input[name="time_slot"]').forEach(function(radio) {
    radio.addEventListener('change', function() {
      var config = slotConfig[this.value];
      if (config) {
        document.getElementById('hiddenDuration2').value = config.duration;
        document.getElementById('startTime').value = config.start;
        document.getElementById('endTime').value = config.end;
      }
    });
  });

  // Form validation
  document.getElementById('dateForm').addEventListener('submit', function(e) {
    if (!document.getElementById('eventDateInput').value) {
      e.preventDefault();
      alert('Please select an event date.');
      return;
    }
    var slot = document.querySelector('input[name="time_slot"]:checked');
    if (!slot) {
      e.preventDefault();
      alert('Please select a time slot.');
      return;
    }
  });`;

step2 = step2.replace(oldFormValidation, newFormValidation);

// Also remove the old hiddenDuration input since we have hiddenDuration2 now
step2 = step2.replace(
  '<input type="hidden" name="rental_duration" id="hiddenDuration" value="daily">',
  ''
);

fs.writeFileSync('views/public/booking/step2-date.ejs', step2);
console.log('Updated step2 with fixed time slots');
