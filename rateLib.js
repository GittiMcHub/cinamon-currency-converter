/*
 * rateLib.js — pure rate/parse/cache logic, no imports.gi.
 *
 * Loadable two ways:
 *   - GJS xlet:  imports.searchPath.unshift(metadata.path); const R = imports.rateLib;
 *   - Node test: const R = require('./rateLib.js');
 * Top-level `var` exports are visible under GJS's `imports.rateLib.*`; the
 * module.exports block at the bottom (skipped in GJS) exposes them to Node.
 */

// Normalize a currency code: trim, uppercase. Returns "" for junk.
var normalizeCode = function(code) {
    if (typeof code !== "string") return "";
    return code.trim().toUpperCase();
};

// Canonical storage key for an unordered pair, lo_hi with lo < hi alphabetically.
var pairKey = function(a, b) {
    return a < b ? a + "_" + b : b + "_" + a;
};

/*
 * A rate table storing one canonical entry per unordered pair.
 * Value at pairKey(lo,hi) = units of `hi` per 1 `lo` (i.e. lo->hi rate).
 * getRate derives the inverse automatically.
 */
var makeTable = function() {
    return { rates: {} };
};

// Record "1 `from` = rate `to`". Reverse is derived on read, never stored twice.
var addRate = function(table, from, to, rate) {
    from = normalizeCode(from);
    to = normalizeCode(to);
    rate = Number(rate);
    if (!from || !to || from === to) return false;
    if (!isFinite(rate) || rate <= 0) return false;
    var key = pairKey(from, to);
    // Store as lo->hi. If from<to it's already lo->hi; else invert.
    table.rates[key] = (from < to) ? rate : (1 / rate);
    return true;
};

// Rate to convert 1 `from` into `to`, or null if the pair is unknown.
var getRate = function(table, from, to) {
    from = normalizeCode(from);
    to = normalizeCode(to);
    if (!from || !to) return null;
    if (from === to) return 1;
    var key = pairKey(from, to);
    var stored = table.rates[key]; // lo->hi
    if (stored === undefined) return null;
    return (from < to) ? stored : (1 / stored);
};

// Build a table from the parsed fixed-rate array [{from,to,rate}, ...].
var buildTableFromFixed = function(arr) {
    var table = makeTable();
    if (!Array.isArray(arr)) return table;
    for (var i = 0; i < arr.length; i++) {
        var e = arr[i];
        if (e && typeof e === "object") addRate(table, e.from, e.to, e.rate);
    }
    return table;
};

/*
 * Cross-rate lookup against a base map: baseRates[X] = units of X per 1 base.
 * rate(from,to) = baseRates[to] / baseRates[from]. Base itself must be 1.
 */
var getCrossRate = function(baseRates, from, to) {
    from = normalizeCode(from);
    to = normalizeCode(to);
    if (!from || !to) return null;
    if (from === to) return 1;
    var rf = baseRates[from];
    var rt = baseRates[to];
    if (!isFinite(rf) || !isFinite(rt) || rf <= 0 || rt <= 0) return null;
    return rt / rf;
};

// Parse a JSON array from settings text; return fallback ([]) on any error.
var parseJsonArray = function(str) {
    try {
        var v = JSON.parse(str);
        return Array.isArray(v) ? v : [];
    } catch (e) {
        return [];
    }
};

// Every distinct currency code referenced by fields + fixed rows.
var collectCurrencies = function(fields, fixed) {
    var seen = {};
    var add = function(c) { c = normalizeCode(c); if (c) seen[c] = true; };
    if (Array.isArray(fields)) fields.forEach(function(f) { if (f) { add(f.from); add(f.to); } });
    if (Array.isArray(fixed)) fixed.forEach(function(f) { if (f) { add(f.from); add(f.to); } });
    return Object.keys(seen);
};

// Cache freshness: true while (now - fetchedAt) < durationSec. Times in seconds.
var isCacheFresh = function(fetchedAt, durationSec, now) {
    if (!isFinite(fetchedAt) || !isFinite(durationSec) || !isFinite(now)) return false;
    return (now - fetchedAt) < durationSec;
};

// Format a converted amount for display; "" for empty/invalid input.
var formatResult = function(amount, rate) {
    if (rate === null || rate === undefined) return null;
    if (typeof amount === "string" && amount.trim() === "") return null;
    var n = Number(amount);
    if (!isFinite(n)) return null;
    return (n * rate).toFixed(2);
};

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        normalizeCode: normalizeCode,
        pairKey: pairKey,
        makeTable: makeTable,
        addRate: addRate,
        getRate: getRate,
        buildTableFromFixed: buildTableFromFixed,
        getCrossRate: getCrossRate,
        parseJsonArray: parseJsonArray,
        collectCurrencies: collectCurrencies,
        isCacheFresh: isCacheFresh,
        formatResult: formatResult
    };
}
