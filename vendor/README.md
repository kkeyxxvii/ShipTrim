# Vendored dependencies

These files are committed rather than fetched from a CDN so that ShipTrim runs
with no network access at all — a seller's label data never needs a connection,
and the tool keeps working if a CDN is blocked or goes away.

| File | Project | Version | Licence |
| --- | --- | --- | --- |
| `pdf.min.js`, `pdf.worker.min.js` | [pdf.js](https://github.com/mozilla/pdf.js) (Mozilla) | 3.11.174 | Apache-2.0 — `LICENSE-pdf.js.txt` |
| `standard_fonts/`, `cmaps/` | pdf.js support data | 3.11.174 | Apache-2.0 |
| `pdf-lib.min.js` | [pdf-lib](https://github.com/Hopding/pdf-lib) | 1.17.1 | MIT — `LICENSE-pdf-lib.txt` |

`standard_fonts/` is not optional: PDFs that reference the Base-14 fonts without
embedding them make pdf.js stall silently if that data is missing.

To update, reinstall the packages and copy the same files across:

```bash
npm install pdfjs-dist@<version> pdf-lib@<version>
cp node_modules/pdfjs-dist/build/pdf.min.js node_modules/pdfjs-dist/build/pdf.worker.min.js vendor/
cp -R node_modules/pdfjs-dist/standard_fonts node_modules/pdfjs-dist/cmaps vendor/
cp node_modules/pdf-lib/dist/pdf-lib.min.js vendor/
```
