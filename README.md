# Cinamon Currency Converter

A small Cinnamon **desklet** (Linux Mint 22, Cinnamon 6.x) for live currency
conversion on the desktop. Type an amount, see the converted value as you type.
Rates come from []https://github.com/lineofflight/frankfurter](https://github.com/lineofflight/frankfurter) (Frankfurter/ECB, cached) or a local fixed table.


## Install

```bash
ln -s "$PWD/cinamon-currency-converter@gittimchub.github.com" \
      ~/.local/share/cinnamon/desklets/cinamon-currency-converter@gittimchub.github.com
```

Reload Cinnamon (`Alt+F2` → `r`), then right-click desktop → **Desklets** →
*Cinamon Currency Converter* → **+**.

## Configure

Right-click the desklet → **Configure**:

- **Rate source** — web service vs. fixed table; base currency, cache duration.
- **Fixed rates** — JSON `[{"from":"EUR","to":"DKK","rate":7.4744}]`. Reverse is
  derived automatically.
- **Fields** — JSON `[{"from":"EUR","to":"DKK"}]`, one live input row each.

Empty field counts as `1`, so an untouched row shows the current rate. Results
round to 2 decimals. Click a field to type; **Esc** or click-outside releases it.

## Test

```bash
node "cinamon-currency-converter@gittimchub.github.com/test/test-rateLib.js"
```
