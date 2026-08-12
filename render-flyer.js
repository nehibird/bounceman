const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  let html = fs.readFileSync('/tmp/flyerimg/flyer.html', 'utf8');
  html = html.replace(/src="images\//g, 'src="file:///tmp/flyerimg/');
  fs.writeFileSync('/tmp/flyerimg/flyer.render.html', html);
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1200, height: 1900 }, deviceScaleFactor: 2 });
  await p.goto('file:///tmp/flyerimg/flyer.render.html', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);
  const el = await p.$('.page');
  await el.screenshot({ path: '/tmp/flyerimg/flyer-final.png' });
  await b.close();
  console.log('rendered');
})().catch(e => { console.error(e); process.exit(1); });
