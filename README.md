# ShipTrim

**Universal shipping-label cropper & A4 formatter for Flipkart, Meesho and
Amazon sellers.** Drop in the label PDF your marketplace gave you and get back a
compact, print-ready sheet — labels detected, cropped, paired with their
invoices and packed onto A4.

[![licence: MIT](https://img.shields.io/badge/licence-MIT-1248A6)](LICENSE)
![no build step](https://img.shields.io/badge/build-none-1248A6)
![runs offline](https://img.shields.io/badge/runs-offline-1248A6)

Everything runs in the browser. **No upload, no server, no network call** —
customer names, addresses and invoices never leave the machine. There is no
backend to trust, and the tool works with the network switched off.

## Quick start

No build step, no dependencies to install. Clone it and serve the folder:

```bash
git clone https://github.com/kkeyxxvii/ShipTrim.git
cd ShipTrim
python3 -m http.server 4178
```

Then open <http://localhost:4178> and drop a PDF on it. Sample Flipkart, Meesho
and Amazon PDFs are in `samples/` if you want to try it without a real order.

> Opening `index.html` by double-clicking will **not** work: browsers block the
> PDF engine's worker and font data on `file://` URLs. The app tells you so
> rather than hanging. Any static web server will do — `python3 -m http.server`,
> `npx serve`, nginx, or GitHub Pages.

## What it does

1. **Upload** one or many PDFs — drag & drop or browse. Shows name, page count,
   size and page dimensions.
2. **Marketplace** — Flipkart, Meesho, Amazon or Auto Detect. Auto Detect
   fingerprints each *file* separately, so a mixed batch still gets the right
   rules per file.
3. **Invoice** — with or without.
4. **Output** — A4 mode (packed sheets) or Label mode (one shipment per page at
   its native size, for 4×6 thermal printers).

   *Without invoice* crops each label at the cut line and discards everything
   below it — no invoice ink reaches the output at all.
5. Detect → crop → arrange → preview → **Download PDF**.

## How the detection works

Text keywords alone are unreliable across sellers and template revisions, and
whitespace alone fails because marketplaces print the label and the invoice
inside one ruled box. ShipTrim combines both:

- **Ink profiling.** Each page is rasterised and reduced to row/column ink
  profiles. Long rules (the label's own frame and table borders) are detected
  and excluded, otherwise the frame puts ink in every row and hides every gap.
- **Whitespace segmentation** splits the page into stacked blocks, and a
  full-height gutter test splits genuine 2-up sheets into columns. That test is
  deliberately strict — near-equal halves, each with its own recipient block —
  so a two-column label is never mistaken for two labels.
- **Anchor splitting.** Phrases that a label and an invoice each announce
  themselves with (`TAX INVOICE`, `Original For Recipient`, `Customer Address`,
  `If undelivered`, …) mark section starts. The cut lands on the dashed
  "cut here" rule the marketplace already prints, or failing that on the widest
  band of white above the anchor. If a template drops that wording altogether,
  the dashed rule alone triggers the split, provided there is real content on
  both sides and the half below it reads as an invoice — wording changes between
  template revisions far more often than the cut line does.
- **Pairing.** Labels are matched to the invoice that follows them in document
  order, so order is preserved and nothing is mispaired — including PDFs that
  put labels and invoices on separate pages.

Unpaired labels print label-only rather than borrowing someone else's invoice,
and the result panel says how many.

## Invoice legibility

Shrinking an invoice is only safe until its text stops being readable, so the
app measures the source's body-text size and reports what it will actually
print at: *"Invoice prints at 57 % of the original (101x67 mm, body text ~3.4
pt), label at 171 %."* Below ~4 pt it warns, and says which control fixes it -
raising **Invoice size**, or forcing fewer units per A4 page when the unit
itself is the limit. A dense A4 tax invoice packed 4-up cannot be made readable
by any slider; only a larger unit can do that, and the app says so rather than
printing an unreadable grey block and calling it done.

## How the A4 layout works

The grid is solved from the real crop dimensions, not a fixed template. Every
candidate grid is scored on paper utilisation under two limits that reflect what
actually matters on a label:

- **A floor** — a label is never shrunk below 72 % of its printed size (40 % when
  an invoice shares the unit), so barcodes stay scannable.
- **A ceiling** — never enlarged past 1.3×, so a lone 4×6 label is centred near
  its printed size instead of being stretched across a whole A4.

With invoices, 3–4 shipment units per sheet are preferred whenever the floor
allows, the label keeps the full unit width and the invoice is scaled beneath it
(32 % of the label's height by default, adjustable). Each crop is fitted to its
cell by *containing* it — aspect ratio is always preserved, nothing is stretched,
overlapped or clipped.

Crops are embedded as vector Form XObjects, so barcodes and QR codes stay crisp
at any scale — nothing is re-rasterised.

## Advanced controls

Page margin, gap between units, invoice share, crop padding, dashed cut guides,
and a manual override for units per A4 page.

## Brand

| Token | Value | Used for |
| --- | --- | --- |
| Primary | `#1248A6` | buttons, selected state, links, logo ground |
| Secondary | `#3E88FF` | accents, focus rings, progress gradient |
| Background | `#F9FAFA` | page ground |
| Text | `#131818` | body copy (greys derive from it) |

Secondary sits at 3.4:1 against white, so it carries accents and never small
white text; primary (8.4:1) carries every filled control. Marketplace card
icons keep Flipkart / Meesho / Amazon's own colours so sellers recognise them.

All colours live as custom properties at the top of `styles.css` -- renaming the
product or re-theming it means editing that one block.

## Layout of this folder

```
index.html      markup
styles.css      styling
app.js          detection, layout solver, PDF composition
vendor/         pdf.js + pdf-lib + font data (vendored, so it runs offline)
samples/        synthetic Flipkart / Meesho / Amazon PDFs for testing
```

`window.ShipTrim` is exposed for debugging: `loadUrl(url)`, `run()`,
`relayout()`, the live state `S`, and `_internals` for the detection functions.

## Browser support

Any current Chrome, Edge, Firefox or Safari. The heavy lifting is `<canvas>`
pixel work plus `Uint8Array` maths, so a laptop handles a few hundred labels
comfortably. Rendering is done with pdf.js's print intent rather than its
display path, so a bulk job keeps running when you switch tabs.

## Privacy

Label PDFs contain your customers' names, addresses and phone numbers.
ShipTrim never transmits them: no fetch, no analytics, no telemetry, no CDN.
The only network requests the page makes are for its own files in `vendor/`.
You can verify that by loading it with DevTools' network tab open, or by
pulling the plug.

For the same reason, **don't commit real label PDFs** — `.gitignore` blocks the
usual filenames, but it cannot catch everything. The files in `samples/` are
synthetic, generated for testing; every name, address and order ID in them is
made up.

## Accuracy, honestly

Detection is structural, not a hard-coded template, so it adapts to layouts I
have never seen — but marketplaces do change their PDFs. If a new template
crops wrong, the preview shows it before you print, and the detected regions
table lists exactly what was found. Adding a keyword or an anchor phrase in
`app.js` is usually the whole fix.

Check the preview before a bulk print run. The barcode is the part that has to
survive, and the layout engine has a scale floor to protect it, but nothing
beats printing one sheet and scanning it.

## Contributing

Issues and PRs welcome — particularly new marketplace templates. If a PDF
crops wrong, the most useful report is a **redacted** sample (replace the
customer block with fake text) plus what you expected.

## Licence

MIT — see [LICENSE](LICENSE). Bundled pdf.js (Apache-2.0) and pdf-lib (MIT)
keep their own licences; see [vendor/README.md](vendor/README.md).
