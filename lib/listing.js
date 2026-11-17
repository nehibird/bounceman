'use strict';

/**
 * Sorting and paging for the admin lists.
 *
 * Two things motivated this. The obvious one: nothing could be sorted, so finding the
 * largest booking of the season meant reading 78 rows. The quieter one: the customers
 * query ended in `LIMIT 100` with no pager and no notice, and there are 91 customers.
 * At 101 the list would simply have stopped showing people, with nothing on the page to
 * say so. A limit without a pager is a silent lie about what exists.
 *
 * The column whitelist is the whole security story here: a sort key is a lookup into a
 * map of SQL this file owns, never a string from the query reaching the query text. An
 * unknown key falls back to the default rather than erroring, because a stale bookmark
 * should still show you the list.
 */

const PER_PAGE = 50;

/**
 * @param {object} query  req.query
 * @param {object} columns  { key: 'SQL expression' } -- the only SQL that can be chosen
 * @param {object} fallback { key, dir } used when nothing valid was asked for
 */
function parseSort(query, columns, fallback) {
  const asked = String(query.sort || '');
  const key = Object.prototype.hasOwnProperty.call(columns, asked) ? asked : fallback.key;
  const dir = String(query.dir || '').toLowerCase() === 'asc' ? 'ASC'
    : String(query.dir || '').toLowerCase() === 'desc' ? 'DESC'
      : (fallback.dir || 'ASC');
  return { key, dir, sql: columns[key] + ' ' + dir };
}

/** Clamp the requested page to something that exists, so ?page=9999 lands on the last. */
function parsePage(query, total, perPage) {
  const size = perPage || PER_PAGE;
  const pages = Math.max(1, Math.ceil(total / size));
  let page = parseInt(query.page, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (page > pages) page = pages;
  const offset = (page - 1) * size;
  return {
    page, pages, perPage: size, offset, total,
    from: total === 0 ? 0 : offset + 1,
    to: Math.min(offset + size, total),
    hasPrev: page > 1,
    hasNext: page < pages
  };
}

/**
 * Builds a URL keeping every filter already on the page and changing only what is named.
 * A null value drops the parameter, which is how "page 1" stays a clean URL.
 */
function linker(basePath, query) {
  return function (overrides) {
    const merged = Object.assign({}, query, overrides);
    const parts = [];
    Object.keys(merged).forEach(function (k) {
      const v = merged[k];
      if (v === null || v === undefined || v === '') return;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
    });
    return basePath + (parts.length ? '?' + parts.join('&') : '');
  };
}

/** The header cell. Clicking the active column flips it; clicking another starts descending. */
function sortHeader(label, key, sort, link, extraClass) {
  const active = sort.key === key;
  const nextDir = active && sort.dir === 'DESC' ? 'asc' : 'desc';
  const arrow = active ? (sort.dir === 'ASC' ? '&uarr;' : '&darr;') : '';
  const cls = 'bm-sort' + (active ? ' is-on' : '') + (extraClass ? ' ' + extraClass : '');
  const aria = active ? (sort.dir === 'ASC' ? 'ascending' : 'descending') : 'none';
  return '<th aria-sort="' + aria + '">' +
    '<a class="' + cls + '" href="' + link({ sort: key, dir: nextDir, page: null }) + '">' +
    label + '<span class="bm-sort-arrow">' + arrow + '</span></a></th>';
}

/** The footer. Says what you are looking at out of what there is -- which is the point. */
function pager(p, link) {
  if (p.total === 0) return '';
  const noun = p.total === 1 ? 'row' : 'rows';
  let html = '<div class="bm-pager"><span class="bm-pager-count">Showing ' +
    p.from + '&ndash;' + p.to + ' of ' + p.total + ' ' + noun + '</span>';
  if (p.pages > 1) {
    html += '<span class="bm-pager-nav">' +
      (p.hasPrev
        ? '<a href="' + link({ page: p.page - 1 === 1 ? null : p.page - 1 }) + '">Previous</a>'
        : '<span class="is-off">Previous</span>') +
      '<span class="bm-pager-page">Page ' + p.page + ' of ' + p.pages + '</span>' +
      (p.hasNext
        ? '<a href="' + link({ page: p.page + 1 }) + '">Next</a>'
        : '<span class="is-off">Next</span>') +
      '</span>';
  }
  return html + '</div>';
}

module.exports = { PER_PAGE, parseSort, parsePage, linker, sortHeader, pager };
