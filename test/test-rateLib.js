/* Standalone unit tests for the pure rate logic. Run: node test/test-rateLib.js */
const R = require("../rateLib.js");

let pass = 0, fail = 0;
function eq(actual, expected, msg) {
    let a = (typeof actual === "number") ? Math.round(actual * 1e9) / 1e9 : actual;
    let e = (typeof expected === "number") ? Math.round(expected * 1e9) / 1e9 : expected;
    if (a === e) { pass++; }
    else { fail++; console.error("FAIL: " + msg + " — got " + a + ", want " + e); }
}

// --- reverse-rate derivation: define only EUR->DKK ---
let t = R.buildTableFromFixed([{ from: "EUR", to: "DKK", rate: 7.4744 }]);
eq(R.getRate(t, "EUR", "DKK"), 7.4744, "EUR->DKK direct");
eq(R.getRate(t, "DKK", "EUR"), 1 / 7.4744, "DKK->EUR derived reverse");
eq(R.getRate(t, "EUR", "EUR"), 1, "same currency = 1");
eq(R.getRate(t, "USD", "EUR"), null, "unknown pair = null");

// case / whitespace normalization
eq(R.getRate(t, " eur ", "dkk"), 7.4744, "normalizes case/whitespace");

// alphabetical-order independence (store canonical lo_hi)
let t2 = R.buildTableFromFixed([{ from: "DKK", to: "EUR", rate: 1 / 7.4744 }]);
eq(R.getRate(t2, "EUR", "DKK"), 7.4744, "reverse-defined pair still resolves forward");

// --- cross rates from a base map ---
let base = { EUR: 1, USD: 1.1, CHF: 0.95 };
eq(R.getCrossRate(base, "EUR", "USD"), 1.1, "cross EUR->USD");
eq(R.getCrossRate(base, "CHF", "USD"), 1.1 / 0.95, "cross CHF->USD via base");
eq(R.getCrossRate(base, "USD", "USD"), 1, "cross same = 1");
eq(R.getCrossRate(base, "USD", "JPY"), null, "cross missing = null");

// --- parsing / defensive ---
eq(R.parseJsonArray("[{\"from\":\"A\"}]").length, 1, "parses valid array");
eq(R.parseJsonArray("not json").length, 0, "junk -> empty array");
eq(R.parseJsonArray("{\"a\":1}").length, 0, "object -> empty array");

// bad entries ignored when building the table
let t3 = R.buildTableFromFixed([
    { from: "EUR", to: "DKK", rate: 7.4744 },
    { from: "X", to: "X", rate: 2 },      // same currency
    { from: "A", to: "B", rate: -1 },     // non-positive
    { from: "C", to: "D" },               // missing rate
    null
]);
eq(R.getRate(t3, "EUR", "DKK"), 7.4744, "valid entry survives bad neighbours");
eq(R.getRate(t3, "A", "B"), null, "negative rate rejected");

// --- currency collection ---
let curs = R.collectCurrencies(
    [{ from: "EUR", to: "DKK" }, { from: "usd", to: "eur" }],
    [{ from: "CHF", to: "EUR", rate: 1 }]
).sort();
eq(curs.join(","), "CHF,DKK,EUR,USD", "collects+normalizes+dedupes currencies");

// --- cache freshness ---
eq(R.isCacheFresh(1000, 3600, 1000 + 3599), true, "fresh just under duration");
eq(R.isCacheFresh(1000, 3600, 1000 + 3600), false, "stale at exactly duration");
eq(R.isCacheFresh(NaN, 3600, 5000), false, "NaN timestamp = stale");

// --- result formatting ---
eq(R.formatNumber(74.744, 2), "74.74", "2 decimals by default char");
eq(R.formatNumber(7.4744, 4), "7.4744", "honours decimals arg");
eq(R.formatNumber(7.4744, 0), "7", "0 decimals");
eq(R.formatNumber(7.4744, 99), "7.4744000000", "clamps decimals to 10");
eq(R.formatNumber(null, 2), null, "null value -> null");
eq(R.formatNumber(-12.5, 2), "-12.50", "keeps sign");

// decimal char
eq(R.formatNumber(1234.5, 2, ","), "1234,50", "comma decimal char");
eq(R.formatNumber(1234.5, 2, "."), "1234.50", "dot decimal char");

// thousands separator
eq(R.formatNumber(1234567.5, 2, ".", ","), "1,234,567.50", "comma grouping");
eq(R.formatNumber(1234567.5, 2, ",", "."), "1.234.567,50", "European style");
eq(R.formatNumber(1234567.5, 2, ".", "'"), "1'234'567.50", "Swiss apostrophe");
eq(R.formatNumber(1234.5, 2, ".", "none"), "1234.50", "no grouping when none");
// collision: same char for both -> grouping dropped, never duplicated
eq(R.formatNumber(1234.5, 2, ".", "."), "1234.50", "collision drops grouping");

// parsing honours separators
eq(R.parseAmount("1,50", ","), 1.5, "parse comma decimal");
eq(R.parseAmount("1.234,56", ",", "."), 1234.56, "parse European grouped");
eq(R.parseAmount("1'234.56", ".", "'"), 1234.56, "parse Swiss grouped");
eq(isNaN(R.parseAmount("", ".")), true, "empty -> NaN");
eq(isNaN(R.parseAmount("abc", ".")), true, "junk -> NaN");

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
