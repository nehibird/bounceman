const fs = require('fs');

// --- equipment.ejs ---
let eq = fs.readFileSync('views/public/equipment.ejs', 'utf8');

// Replace the info div + price area
eq = eq.replace(
  /<div class="small text-muted mb-3">\s*\$\{item\.dimensions[\s\S]*?Up to ' \+ item\.capacity_kids \+ ' kids'[\s\S]*?<\/div>\s*<div class="d-flex justify-content-between align-items-center">\s*<span class="price-tag">.*?<\/span>/,
  `<div class="small text-muted mb-3">
              \${item.dimensions ? '<i class="fas fa-ruler-combined me-1"></i>' + item.dimensions + ' &bull; ' : ''}
              \${item.capacity_kids ? '<i class="fas fa-child me-1"></i>Up to ' + item.capacity_kids + ' kids' : ''}
              &bull; <i class="fas fa-clock me-1"></i>4hr: $\${parseFloat(item.price_4hr || item.price_daily * 0.65).toFixed(0)} &bull; Full Day: $\${parseFloat(item.price_daily).toFixed(0)}
            </div>
            <div class="d-flex justify-content-between align-items-center">
              <span class="price-tag">From $\${parseFloat(item.price_4hr || item.price_daily * 0.65).toFixed(0)}</span>`
);
fs.writeFileSync('views/public/equipment.ejs', eq);
console.log('Updated equipment.ejs');

// --- index.ejs ---
let idx = fs.readFileSync('views/public/index.ejs', 'utf8');

// The homepage card doesn't have the dimensions/kids line, so add it and revert price
idx = idx.replace(
  /<p class="text-muted small">\$\{item\.short_description \|\| ''\}<\/p>\s*<div class="d-flex justify-content-between align-items-center mt-3">\s*<span class="price-tag">.*?<\/span>/,
  `<p class="text-muted small">\${item.short_description || ''}</p>
            <div class="small text-muted mb-1">
              <i class="fas fa-clock me-1"></i>4hr: $\${parseFloat(item.price_4hr || item.price_daily * 0.65).toFixed(0)} &bull; Full Day: $\${parseFloat(item.price_daily).toFixed(0)}
            </div>
            <div class="d-flex justify-content-between align-items-center mt-2">
              <span class="price-tag">From $\${parseFloat(item.price_4hr || item.price_daily * 0.65).toFixed(0)}</span>`
);
fs.writeFileSync('views/public/index.ejs', idx);
console.log('Updated index.ejs');

// --- equipment-detail.ejs (related items) ---
let det = fs.readFileSync('views/public/equipment-detail.ejs', 'utf8');
det = det.replace(
  /<span class="price-tag">4hr: \$\$\{parseFloat\(r\.price_4hr.*?<\/span>/,
  `<span class="price-tag">From $\${parseFloat(r.price_4hr || r.price_daily * 0.65).toFixed(0)}</span>`
);
fs.writeFileSync('views/public/equipment-detail.ejs', det);
console.log('Updated equipment-detail.ejs');
