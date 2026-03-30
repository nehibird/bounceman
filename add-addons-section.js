const fs = require('fs');

let step2 = fs.readFileSync('views/public/booking/step2-date.ejs', 'utf8');

// Add the add-ons section before the navigation buttons
const beforeButtons = `          <div class="d-flex justify-content-between">
            <a href="/booking?items=\${selectedItems.join(',')}" class="btn btn-outline-secondary rounded-pill px-4">
              <i class="fas fa-arrow-left me-2"></i>Back
            </a>`;

const addonsSection = `          <!-- Add-Ons -->
          \${(typeof addons !== 'undefined' && addons.length > 0) ? \`
          <div class="mt-4 mb-4">
            <h5 class="mb-3"><i class="fas fa-plus-circle me-2" style="color:var(--bm-orange)"></i>Make your event even better</h5>
            <div class="row g-3">
              \${addons.map(addon => \`
              <div class="col-md-6">
                <div class="card border" style="border-radius:12px">
                  <div class="card-body d-flex align-items-center gap-3">
                    <div style="flex-shrink:0">
                      <i class="fas fa-music" style="font-size:24px;color:var(--bm-orange)"></i>
                    </div>
                    <div style="flex:1">
                      <h6 class="mb-1">\${addon.name}</h6>
                      <p class="text-muted small mb-1">\${addon.short_description || ''}</p>
                      <span class="fw-bold" style="color:var(--bm-orange)">+$\${parseFloat(addon.price_4hr).toFixed(0)} (4hr) / $\${parseFloat(addon.price_daily).toFixed(0)} (full day)</span>
                    </div>
                    <div>
                      <input type="checkbox" name="addon_ids" value="\${addon.id}" class="form-check-input" style="width:24px;height:24px;cursor:pointer">
                    </div>
                  </div>
                </div>
              </div>
              \`).join('')}
            </div>
          </div>
          \` : ''}

          <div class="d-flex justify-content-between">
            <a href="/booking?items=\${selectedItems.join(',')}" class="btn btn-outline-secondary rounded-pill px-4">
              <i class="fas fa-arrow-left me-2"></i>Back
            </a>`;

step2 = step2.replace(beforeButtons, addonsSection);
fs.writeFileSync('views/public/booking/step2-date.ejs', step2);
console.log('Added add-ons section to booking step 2');
