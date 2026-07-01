/*
 * Cinamon Currency Converter — desklet main entry.
 * GJS / Cinnamon 6.x (Linux Mint 22). Not Node, not a browser.
 */

const Desklet = imports.ui.desklet;
const Main = imports.ui.main;
const Settings = imports.ui.settings;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Soup = imports.gi.Soup;
const ByteArray = imports.byteArray;
const Mainloop = imports.mainloop;

const UUID = "cinamon-currency-converter@gittimchub.github.com";
const DEBOUNCE_MS = 250;

// Load the pure-logic module that lives in this desklet's own directory.
let RateLib;

function _log(msg) { global.log("[" + UUID + "] " + msg); }
function _err(msg) { global.logError("[" + UUID + "] " + msg); }


/* ------------------------------------------------------------------ *
 *  Rate providers — both expose getRate(from, to) -> number|null.
 * ------------------------------------------------------------------ */

// Reads the parsed fixed-rate table from settings; derives reverse rates.
function FixedRateProvider(fixedArray) {
    this._table = RateLib.buildTableFromFixed(fixedArray);
}
FixedRateProvider.prototype = {
    getRate: function(from, to) {
        return RateLib.getRate(this._table, from, to);
    },
    // Fixed rates are always available; nothing to fetch.
    ensureRates: function(_currencies, _onReady) {}
};


/*
 * Fetches rates from a Frankfurter-compatible /latest endpoint, caches the
 * response (with timestamp) under the user cache dir, and derives every cross
 * rate from a single base currency. All network I/O is async (libsoup3).
 */
function WebServiceRateProvider(opts) {
    this._apiBase = opts.apiBase;
    this._base = RateLib.normalizeCode(opts.baseCurrency) || "EUR";
    this._cacheSecs = opts.cacheDuration;
    this._cacheFile = opts.cacheFile;
    this._session = new Soup.Session();
    this._baseRates = null;   // { CUR: units-per-1-base, ... }
    this._fetchedAt = 0;
    this._inFlight = false;
    this._loadCache();
}
WebServiceRateProvider.prototype = {

    getRate: function(from, to) {
        if (!this._baseRates) return null;
        return RateLib.getCrossRate(this._baseRates, from, to);
    },

    destroy: function() {
        if (this._session) {
            try { this._session.abort(); } catch (e) {}
            this._session = null;
        }
    },

    _loadCache: function() {
        try {
            let [ok, contents] = GLib.file_get_contents(this._cacheFile);
            if (!ok) return;
            let text = ByteArray.toString(contents);
            let data = JSON.parse(text);
            if (data && data.baseRates && data.base === this._base) {
                this._baseRates = data.baseRates;
                this._fetchedAt = Number(data.fetchedAt) || 0;
            }
        } catch (e) { /* no/invalid cache — ignore, will fetch */ }
    },

    _saveCache: function() {
        try {
            let dir = GLib.path_get_dirname(this._cacheFile);
            GLib.mkdir_with_parents(dir, 0o755);
            let payload = JSON.stringify({
                base: this._base,
                baseRates: this._baseRates,
                fetchedAt: this._fetchedAt
            });
            GLib.file_set_contents(this._cacheFile, payload);
        } catch (e) { _err("cache write failed: " + e); }
    },

    // Fetch if cache is stale (or forced). Calls onReady() once rates change.
    ensureRates: function(currencies, onReady, force) {
        let now = Math.floor(Date.now() / 1000);
        let fresh = this._baseRates &&
                    RateLib.isCacheFresh(this._fetchedAt, this._cacheSecs, now);
        if (fresh && !force) { onReady(); return; }
        if (this._inFlight) return;

        // Ask the API for every configured currency except the base itself.
        let symbols = currencies.filter(function(c) { return c && c !== this._base; }, this)
                                .map(RateLib.normalizeCode)
                                .filter(function(c) { return c && c !== this._base; }, this);
        // Dedupe.
        symbols = symbols.filter(function(c, i) { return symbols.indexOf(c) === i; });

        let url = this._apiBase.replace(/\/+$/, "") + "/latest?from=" +
                  encodeURIComponent(this._base);
        if (symbols.length) url += "&to=" + encodeURIComponent(symbols.join(","));

        this._inFlight = true;
        let self = this;
        try {
            let msg = Soup.Message.new("GET", url);
            this._session.send_and_read_async(
                msg, GLib.PRIORITY_DEFAULT, null,
                function(session, res) {
                    self._inFlight = false;
                    try {
                        let bytes = session.send_and_read_finish(res);
                        let status = msg.get_status ? msg.get_status() : msg.status_code;
                        if (!bytes) throw new Error("empty response");
                        let text = ByteArray.toString(bytes.get_data());
                        let data = JSON.parse(text);
                        if (!data || !data.rates) throw new Error("no rates in response");

                        let map = {};
                        map[self._base] = 1;
                        for (let k in data.rates) {
                            map[RateLib.normalizeCode(k)] = Number(data.rates[k]);
                        }
                        self._baseRates = map;
                        self._fetchedAt = Math.floor(Date.now() / 1000);
                        self._saveCache();
                        _log("fetched rates from " + url + " (status " + status + ")");
                        onReady();
                    } catch (e) {
                        _err("fetch failed (" + url + "): " + e +
                             (self._baseRates ? " — using last cached rates" : ""));
                        // Fall back to whatever cache we already had; still redraw.
                        onReady();
                    }
                }
            );
        } catch (e) {
            this._inFlight = false;
            _err("could not start request: " + e);
            onReady();
        }
    }
};


/* ------------------------------------------------------------------ *
 *  Desklet
 * ------------------------------------------------------------------ */

function MyDesklet(metadata, desklet_id) {
    this._init(metadata, desklet_id);
}

MyDesklet.prototype = {
    __proto__: Desklet.Desklet.prototype,

    _init: function(metadata, desklet_id) {
        Desklet.Desklet.prototype._init.call(this, metadata, desklet_id);

        // Load the sibling pure-logic module from this desklet's directory.
        if (!RateLib) {
            imports.searchPath.unshift(metadata.path);
            RateLib = imports.rateLib;
        }

        this._rows = [];            // [{from, to, entry, output, debounceId}]
        this._provider = null;
        this._modal = false;        // true while we hold the keyboard grab
        this._stageEventId = 0;
        this._cacheFile = GLib.build_filenamev(
            [GLib.get_user_cache_dir(), UUID, "rates.json"]);

        this.settings = new Settings.DeskletSettings(this, metadata.uuid, desklet_id);
        let bind = Settings.BindingDirection.IN;
        this.settings.bindProperty(bind, "rateSource", "rateSource", this._onSettingsChanged.bind(this));
        this.settings.bindProperty(bind, "apiBase", "apiBase", this._onSettingsChanged.bind(this));
        this.settings.bindProperty(bind, "baseCurrency", "baseCurrency", this._onSettingsChanged.bind(this));
        this.settings.bindProperty(bind, "cacheDuration", "cacheDuration", this._onSettingsChanged.bind(this));
        this.settings.bindProperty(bind, "decimals", "decimals", this._onSettingsChanged.bind(this));
        this.settings.bindProperty(bind, "decimalChar", "decimalChar", this._onSettingsChanged.bind(this));
        this.settings.bindProperty(bind, "thousandsSep", "thousandsSep", this._onSettingsChanged.bind(this));
        this.settings.bindProperty(bind, "fixedRates", "fixedRates", this._onSettingsChanged.bind(this));
        this.settings.bindProperty(bind, "fields", "fields", this._onSettingsChanged.bind(this));

        this.setHeader(_("Currency Converter"));

        this._buildProvider();
        this._buildUI();
        this._refreshRates(false);
    },

    // Settings button callback (declared in settings-schema.json).
    onRefreshClicked: function() {
        this._buildProvider();
        this._refreshRates(true);
    },

    _onSettingsChanged: function() {
        this._enforceSeparators();
        this._buildProvider();
        this._buildUI();
        this._refreshRates(false);
    },

    // Decimal char and thousands separator must differ. Only "." vs "." can
    // collide; if it happens, drop the thousands separator and persist it so
    // the config UI reflects the correction.
    _enforceSeparators: function() {
        let dc = RateLib.resolveDecimalChar(this.decimalChar);
        if (this.thousandsSep && this.thousandsSep !== "none" && this.thousandsSep === dc) {
            _log("thousands separator equals decimal char — resetting to none");
            this.settings.setValue("thousandsSep", "none");
            this.thousandsSep = "none";
        }
    },

    _parsedFixed: function() { return RateLib.parseJsonArray(this.fixedRates); },
    _parsedFields: function() { return RateLib.parseJsonArray(this.fields); },

    _buildProvider: function() {
        if (this._provider && this._provider.destroy) this._provider.destroy();
        if (this.rateSource === "fixed") {
            this._provider = new FixedRateProvider(this._parsedFixed());
        } else {
            this._provider = new WebServiceRateProvider({
                apiBase: this.apiBase || "https://api.frankfurter.app",
                baseCurrency: this.baseCurrency,
                cacheDuration: Number(this.cacheDuration) || 43200,
                cacheFile: this._cacheFile
            });
        }
    },

    _buildUI: function() {
        this._clearRows();

        this._container = new St.BoxLayout({
            vertical: true,
            style_class: "ccc-container"
        });

        let fields = this._parsedFields();
        if (!fields.length) {
            this._container.add(new St.Label({
                text: _("No fields configured. Open settings to add some."),
                style_class: "ccc-empty"
            }));
        }

        fields.forEach(function(f) {
            let from = RateLib.normalizeCode(f && f.from);
            let to = RateLib.normalizeCode(f && f.to);
            if (!from || !to) return;
            this._addRow(from, to);
        }, this);

        this.setContent(this._container);
    },

    _addRow: function(from, to) {
        let row = new St.BoxLayout({ vertical: false, style_class: "ccc-row" });

        row.add(new St.Label({ text: from, style_class: "ccc-code" }));

        let entry = new St.Entry({
            style_class: "ccc-entry",
            can_focus: true,
            track_hover: true,
            hint_text: "1",
            text: "1"
        });
        row.add(entry);

        row.add(new St.Label({ text: "→", style_class: "ccc-arrow" }));

        let output = new St.Label({ text: "—", style_class: "ccc-output" });
        row.add(output);

        row.add(new St.Label({ text: to, style_class: "ccc-code" }));

        let rowData = { from: from, to: to, entry: entry, output: output, debounceId: 0 };
        this._rows.push(rowData);

        let self = this;

        // Desklets sit on the desktop layer and don't get X keyboard focus by
        // default — without a grab, keystrokes fall through to Nemo's desktop
        // type-ahead search. Grab the keyboard when a field is clicked.
        entry.clutter_text.connect("button-press-event", function() {
            self._grabKeyboard(entry);
            return Clutter.EVENT_PROPAGATE; // let the entry place its cursor
        });

        entry.clutter_text.connect("text-changed", function() {
            if (rowData.debounceId) {
                Mainloop.source_remove(rowData.debounceId);
                rowData.debounceId = 0;
            }
            rowData.debounceId = Mainloop.timeout_add(DEBOUNCE_MS, function() {
                rowData.debounceId = 0;
                self._recalcRow(rowData);
                return GLib.SOURCE_REMOVE;
            });
        });

        this._container.add(row);
    },

    // Take the keyboard grab (once) and point key focus at the given entry.
    _grabKeyboard: function(entry) {
        if (!this._modal) {
            if (Main.pushModal(this.actor)) {
                this._modal = true;
                // Watch for Escape / clicks outside the desklet to release.
                this._stageEventId = global.stage.connect(
                    "captured-event", this._onStageEvent.bind(this));
            }
        }
        global.stage.set_key_focus(entry.clutter_text);
    },

    _releaseKeyboard: function() {
        if (!this._modal) return;
        if (this._stageEventId) {
            global.stage.disconnect(this._stageEventId);
            this._stageEventId = 0;
        }
        global.stage.set_key_focus(null);
        Main.popModal(this.actor);
        this._modal = false;
    },

    _onStageEvent: function(actor, event) {
        let type = event.type();
        if (type === Clutter.EventType.KEY_PRESS &&
            event.get_key_symbol() === Clutter.KEY_Escape) {
            this._releaseKeyboard();
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.BUTTON_PRESS) {
            // Release if the click landed outside this desklet's actor tree.
            let src = event.get_source();
            let inside = false;
            while (src) {
                if (src === this.actor) { inside = true; break; }
                src = src.get_parent();
            }
            if (!inside) this._releaseKeyboard();
        }
        return Clutter.EVENT_PROPAGATE;
    },

    _recalcRow: function(rowData) {
        // Empty field defaults to 1, so an untouched row shows the current rate.
        let raw = rowData.entry.get_text().trim();
        if (raw === "") raw = "1";

        let amount = RateLib.parseAmount(raw, this.decimalChar, this.thousandsSep);
        if (!isFinite(amount)) { rowData.output.set_text("—"); return; }

        let rate = this._provider ? this._provider.getRate(rowData.from, rowData.to) : null;
        if (rate === null) { rowData.output.set_text("?"); return; }

        let result = RateLib.formatNumber(
            amount * rate, this.decimals, this.decimalChar, this.thousandsSep);
        rowData.output.set_text(result === null ? "—" : result);
    },

    _recalcAll: function() {
        this._rows.forEach(function(r) { this._recalcRow(r); }, this);
    },

    // Ensure rates are available (fetch if needed), then redraw all rows.
    _refreshRates: function(force) {
        if (!this._provider) return;
        let currencies = RateLib.collectCurrencies(this._parsedFields(), this._parsedFixed());
        let self = this;
        this._provider.ensureRates(currencies, function() {
            self._recalcAll();
        }, force);
    },

    _clearRows: function() {
        this._releaseKeyboard();
        this._rows.forEach(function(r) {
            if (r.debounceId) {
                Mainloop.source_remove(r.debounceId);
                r.debounceId = 0;
            }
        });
        this._rows = [];
        if (this._container) {
            this._container.destroy();
            this._container = null;
        }
    },

    on_desklet_removed: function() {
        this._releaseKeyboard();
        this._clearRows();
        if (this._provider && this._provider.destroy) this._provider.destroy();
        this._provider = null;
        if (this.settings && this.settings.finalize) this.settings.finalize();
    }
};

function main(metadata, desklet_id) {
    return new MyDesklet(metadata, desklet_id);
}
