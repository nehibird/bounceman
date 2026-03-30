const fs = require('fs');
let f = fs.readFileSync('views/public/equipment-detail.ejs', 'utf8');

// 1. Replace addon price display with dynamic data attributes
f = f.replace(
  /(<div class="text-end me-2">)\s*(<span class="fw-bold" style="color:var\(--bm-orange\)">)\+\$\$\{parseFloat\(addon\.price_4hr\)\.toFixed\(0\)\}(<\/span>)\s*(<\/div>)/,
  `<div class="text-end me-2">
                <span class="fw-bold addon-price" style="color:var(--bm-orange)" data-price-4hr="\${parseFloat(addon.price_4hr).toFixed(0)}" data-price-daily="\${parseFloat(addon.price_daily).toFixed(0)}" data-price-overnight="\${parseFloat(addon.price_overnight || addon.price_daily).toFixed(0)}">+$\${parseFloat(addon.price_4hr).toFixed(0)}</span>
              </div>`
);

// 2. Update the addon description to be more fun
f = f.replace(
  `<div class="fw-bold">\${addon.name}</div>
                <div class="text-muted small">\${addon.short_description || ''}</div>`,
  `<div class="fw-bold">\${addon.name}</div>
                <div class="text-muted small">Make it a party — rent the world's loudest Bluetooth speaker!</div>`
);

// 3. Add updateAddonPrices function and wire it up
const addonFn = `
  // Update addon prices based on selected duration
  function updateAddonPrices() {
    var slot = document.querySelector('input[name="time_slot"]:checked');
    var dur = slot ? slot.value : 'fullday';
    var priceKey = dur === '4hr' ? '4hr' : (dur === 'overnight' ? 'overnight' : 'daily');
    document.querySelectorAll('.addon-price').forEach(function(el) {
      var price = el.getAttribute('data-price-' + priceKey);
      el.textContent = '+$' + price;
    });
  }

`;

f = f.replace('  // Tier visual styling', addonFn + '  // Tier visual styling');

// 4. Call updateAddonPrices when tier changes
f = f.replace(
  `      updateTierStyles();
    });
  });

  // Initialize tier styles`,
  `      updateTierStyles();
      updateAddonPrices();
    });
  });

  // Initialize tier styles`
);

fs.writeFileSync('views/public/equipment-detail.ejs', f);
console.log('Updated addon pricing and description');
