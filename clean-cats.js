const db = require('better-sqlite3')('data/bounceman.db');
// Delete old hyphenated slug categories
db.prepare("DELETE FROM categories WHERE slug IN ('bounce-houses','combo-units','water-slides','obstacle-courses','interactive-games','add-ons')").run();
// Keep add_ons category in DB (equipment references it) but it won't show in filters since route excludes it
const cats = db.prepare("SELECT name, slug FROM categories").all();
console.log("Categories:", JSON.stringify(cats));
