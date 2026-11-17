/* Bounce Man admin — chart theme.
 *
 * D0 put every colour in admin.css. Charts are JavaScript, so they had been exempt:
 * reports.ejs alone carried eight hardcoded colours (#FF6B35, #004E89, #F39C12,
 * #2ECC71, #3498DB, #E74C3C, #059669, #7B2D8E) — none of them the brand, several of
 * them the Flat-UI palette D0 deleted everywhere else.
 *
 * This reads the SAME custom properties the stylesheet defines, at runtime. So a colour
 * change in Admin → Settings moves the charts along with everything else, and there is
 * still exactly one place a literal colour may live.
 */
(function (global) {
  'use strict';

  function token(name, fallback) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name);
      v = (v || '').trim();
      return v || fallback;
    } catch (e) {
      return fallback;
    }
  }

  /* Chart.js wants rgba() for fills. The tokens are hex, so convert rather than keep a
     second, parallel set of rgba literals that could drift out of sync. */
  function alpha(hex, a) {
    var h = String(hex || '').trim().replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return 'rgba(0,0,0,' + a + ')';
    return 'rgba(' + parseInt(h.slice(0, 2), 16) + ',' +
                     parseInt(h.slice(2, 4), 16) + ',' +
                     parseInt(h.slice(4, 6), 16) + ',' + a + ')';
  }

  var T = {
    accent:   function () { return token('--bm-accent', '#d77c42'); },
    ink:      function () { return token('--bm-n-900', '#1a212d'); },
    muted:    function () { return token('--bm-n-500', '#6b7280'); },
    faint:    function () { return token('--bm-n-100', '#e3e6eb'); },
    paper:    function () { return token('--bm-n-0', '#ffffff'); },
    good:     function () { return token('--bm-fb-good', '#0f7a52'); },
    warn:     function () { return token('--bm-fb-warn', '#a76a10'); },
    bad:      function () { return token('--bm-fb-bad', '#a8321f'); },
    font:     function () { return token('--bm-font-body', 'Nunito, sans-serif'); }
  };

  /* A second series needs to be distinguishable from the accent without introducing a
     new hue — a chart with two brand-ish oranges is unreadable. Neutral ink reads as
     "the other thing" and stays inside the palette. */
  function series(i) {
    return [T.accent(), T.ink(), T.muted()][i % 3];
  }

  /* Status colours follow D0's sequence, not a traffic light: pending is quiet, the
     live one is accent, done recedes, cancelled is muted red. Green is reserved for
     money direction and is deliberately not spent here. */
  function statusColor(status) {
    switch (String(status || '').toLowerCase()) {
      case 'confirmed': return T.accent();
      case 'completed': return token('--bm-n-300', '#aab2bf');
      case 'cancelled': return T.bad();
      case 'pending':   return token('--bm-n-200', '#cbd1da');
      default:          return T.muted();
    }
  }

  /* Draws each value above its bar or point. The item asked for values labelled
     directly: reading a bar against a gridline is a measurement, reading a number is
     not. Skipped when the series is dense enough that labels would collide. */
  var valueLabels = {
    id: 'bmValueLabels',
    afterDatasetsDraw: function (chart, args, opts) {
      var fmt = (opts && opts.format) || function (v) { return v; };
      var max = (opts && opts.max) || 14;
      var ctx = chart.ctx;
      chart.data.datasets.forEach(function (ds, di) {
        if (ds.bmNoLabels) return;
        var meta = chart.getDatasetMeta(di);
        if (meta.hidden || !meta.data || meta.data.length > max) return;
        ctx.save();
        ctx.font = '600 11px ' + T.font();
        ctx.fillStyle = T.muted();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        meta.data.forEach(function (el, i) {
          var raw = ds.data[i];
          if (raw === null || raw === undefined) return;
          var text = fmt(raw, ds);
          if (text === '' || text === null) return;
          ctx.fillText(String(text), el.x, el.y - 6);
        });
        ctx.restore();
      });
    }
  };

  function money(v) {
    var n = Number(v);
    if (!isFinite(n) || n === 0) return '';
    return '$' + Math.round(n).toLocaleString();
  }

  /* Applied once, globally. Heavy gridlines were the loudest thing in every chart --
     a grid is scaffolding, not data, so it drops to the faintest neutral on the value
     axis and disappears entirely on the category axis. */
  function applyDefaults(Chart) {
    if (!Chart || !Chart.defaults) return;
    Chart.defaults.font.family = T.font();
    Chart.defaults.font.size = 12;
    Chart.defaults.color = T.muted();
    Chart.defaults.plugins.legend.labels.boxWidth = 10;
    Chart.defaults.plugins.legend.labels.boxHeight = 10;
    Chart.defaults.plugins.legend.labels.usePointStyle = true;
    Chart.defaults.plugins.tooltip.backgroundColor = T.ink();
    Chart.defaults.plugins.tooltip.titleFont = { weight: '700' };
    Chart.defaults.plugins.tooltip.padding = 10;
    Chart.defaults.plugins.tooltip.cornerRadius = 6;
    Chart.defaults.plugins.tooltip.displayColors = false;
    Chart.defaults.elements.line.borderWidth = 2;
    Chart.defaults.elements.point.radius = 3;
    Chart.defaults.elements.point.hoverRadius = 5;
    Chart.defaults.elements.bar.borderRadius = 4;
    if (Chart.register) Chart.register(valueLabels);
  }

  /* The axis config every chart here shares. */
  function scales(opts) {
    opts = opts || {};
    return {
      x: {
        grid: { display: false, drawBorder: false },
        ticks: { color: T.muted() }
      },
      y: {
        beginAtZero: true,
        border: { display: false },
        grid: { color: T.faint(), drawBorder: false, drawTicks: false },
        ticks: {
          color: T.muted(),
          padding: 8,
          callback: opts.money === false
            ? undefined
            : function (v) { return '$' + Number(v).toLocaleString(); }
        }
      }
    };
  }

  global.BMChart = {
    token: token,
    alpha: alpha,
    colors: T,
    series: series,
    statusColor: statusColor,
    money: money,
    scales: scales,
    valueLabels: valueLabels,
    applyDefaults: applyDefaults
  };

  if (global.Chart) applyDefaults(global.Chart);
})(window);
