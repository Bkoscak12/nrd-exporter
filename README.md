# NRD Exporter

A browser bookmark that exports Exempt Market Dealer (EMD) firms, their registered individuals and dealing representatives, and their terms & conditions from the CSA [National Registration Search](https://info.securities-administrators.ca/nrsmobile/nrssearch.aspx) to Excel, with a terms & conditions report grouped by category and province.

**Install:** open the [install page](https://bkoscak12.github.io/nrd-exporter/) and drag the button to your bookmarks bar. The bookmark loads the latest `nrd-exporter.js` from this repository's GitHub Pages site on every click, so changes pushed here reach it automatically.

## How it works

- Runs only in your own browser tab on `info.securities-administrators.ca`, using the same data calls as the NRD's own pages. Nothing is sent anywhere else.
- Paces itself at about one request per second and backs off when the site asks it to slow down (HTTP 429). A full EMD scan with every individual's record takes hours; progress is saved in the browser and can be resumed.
- Never bypasses the site's reCAPTCHA. If the site asks for one, solve it on the search page and start again.

## Files

| File | Purpose |
|---|---|
| `nrd-exporter.js` | The tool. Edit this. |
| `install.template.html` | Source of the install page. |
| `build.py` | Run `python3 build.py` after editing either file above; writes `index.html`. |
| `index.html` | The install page GitHub Pages serves. Generated; don't edit by hand. |

## Disclaimer

Not affiliated with or endorsed by the Canadian Securities Administrators or CIRO. Not legal advice. The CSA presents registration information as a plain language summary of publicly available documents; check the NRD record before relying on it. Exports contain personal information about registered individuals; handle them accordingly.
