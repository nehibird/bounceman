const fs = require('fs');

// equipment.ejs — wrap the card in a clickable link
let eq = fs.readFileSync('views/public/equipment.ejs', 'utf8');
eq = eq.replace(
  `<div class="equipment-card">
          <img src="\${item.image || '/assets/images/placeholder-bounce.svg'}" class="card-img-top" alt="\${item.name}">`,
  `<a href="/equipment/\${item.slug}" class="equipment-card-link" style="text-decoration:none;color:inherit;display:block">
        <div class="equipment-card" style="cursor:pointer">
          <img src="\${item.image || '/assets/images/placeholder-bounce.svg'}" class="card-img-top" alt="\${item.name}">`
);
eq = eq.replace(
  `          </div>
        </div>
      </div>
      \`).join('') : \``,
  `          </div>
        </div>
        </a>
      </div>
      \`).join('') : \``
);
fs.writeFileSync('views/public/equipment.ejs', eq);
console.log('Updated equipment.ejs');

// index.ejs — wrap homepage cards too
let idx = fs.readFileSync('views/public/index.ejs', 'utf8');
idx = idx.replace(
  `<div class="equipment-card">
          <img src="\${item.image || '/assets/images/placeholder-bounce.svg'}" class="card-img-top" alt="\${item.name}">`,
  `<a href="/equipment/\${item.slug}" class="equipment-card-link" style="text-decoration:none;color:inherit;display:block">
        <div class="equipment-card" style="cursor:pointer">
          <img src="\${item.image || '/assets/images/placeholder-bounce.svg'}" class="card-img-top" alt="\${item.name}">`
);
// Close the anchor tag after the card closes on homepage
idx = idx.replace(
  `          </div>
        </div>
      </div>
\`).join('') : \``,
  `          </div>
        </div>
        </a>
      </div>
\`).join('') : \``
);
fs.writeFileSync('views/public/index.ejs', idx);
console.log('Updated index.ejs');
