/* ===================================================================
   ShipTrim \u2014 universal shipping-label cropper & A4 formatter
   Everything runs in the browser: pdf.js analyses, pdf-lib composes.
   Crops stay vector (barcodes never get rasterised).
   \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
/* Non-embedded Base-14 fonts need the standard font data, and CJK PDFs need
   the cmaps \u2014 both are vendored so the tool runs fully offline. */
const PDFJS_OPTS = {
  standardFontDataUrl: 'vendor/standard_fonts/',
  cMapUrl: 'vendor/cmaps/', cMapPacked: true
};
const { PDFDocument, rgb, degrees } = PDFLib;

/* -- units ----------------------------------------------------------- */
const MM = 2.834645669;                 // 1 mm in PDF points
const A4 = { w: 595.276, h: 841.89 };
const pt2mm = p => p / MM;
const listOf = xs => xs.length < 2 ? (xs[0] || '')
  : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1];

/* -- keyword models -------------------------------------------------- */
const LABEL_KW = [
  ['shipping label',4],['ship to',3],['deliver to',3],['delivery address',3],
  ['customer address',3],['if undelivered',3],['return address',2.5],['awb',3],
  ['tracking',2],['shipment id',2],['bag id',2],['sort code',2],['courier',2],
  ['prepaid',2],['cash on collection',2],['cash on delivery',2],['cod',1.5],
  ['pickup',2],['destination',2],['drop pin',2],['dimensions',1],['weight',1],
  ['ekart',2],['valmo',2],['delhivery',2],['shadowfax',2],['xpressbees',2],
  ['ecom express',2],['blue dart',2],['dtdc',2],['india post',1.5],
  ['order id',1],['order no',1],['hub',1],['route',1],['pkg',1],['fba',1]
];
const INVOICE_KW = [
  ['tax invoice',5],['bill of supply',4],['original for recipient',4],
  ['invoice no',4],['invoice date',4],['invoice number',4],['gstin',3],['hsn',3],
  ['taxable',3],['cgst',3],['sgst',3],['igst',3],['place of supply',3],
  ['reverse charge',3],['bill to',3],['billing address',3],['grand total',3],
  ['amount in words',3],['authorized signatory',3],['authorised signatory',3],
  ['net amount',2],['unit price',2],['sub total',2],['subtotal',2],
  ['total amount',2],['declaration',2],['e-invoice',2],['irn',2],['invoice',2],
  ['gst',1],['discount',1],['signature',1],['sac',1]
];
const PLATFORM_KW = {
  meesho:   [['meesho',6],['valmo',6],['check the payable amount',5],
             ['sku size qty color',5],['product details',1.5],
             ['bill to / ship to',3],['supplier name',1.5]],
  flipkart: [['flipkart',6],['e-kart',5],['ekart',5],['fmpp',3],['fassured',2],
             ['f-assured',2],['hbd:',2],['cpd:',2],['ordered through',1.5]],
  amazon:   [['amazon',6],['amzn',4],['fulfilled by amazon',5],['easy ship',3],
             ['appario',3],['cloudtail',3],['asin',2],['fba',2]]
};

/* Section anchors. A real label and a real invoice each announce themselves;
   these phrases are what survive across sellers, couriers and template
   revisions, and they are chosen NOT to collide (an invoice's "shipping
   address" column must never read as the start of a new label). */
const INV_ANCHOR = /(tax invoice|original for recipient|bill of supply|invoice no\b|invoice number|invoice date|purchase order no)/;
const LBL_ANCHOR = /(customer address|if undelivered|deliver to\b|delivery address|ship to:|shipto:|consignee)/;

/* -- per-marketplace crop rules -------------------------------------- */
const PROFILES = {
  flipkart: { name:'Flipkart', minGapPt:8,  colSplit:true,  minBlockH:0.035, pad:3,
              note:'Flipkart / Ekart label + tax-invoice sheets, single or 2-up.' },
  meesho:   { name:'Meesho',   minGapPt:10, colSplit:false, minBlockH:0.04,  pad:3,
              note:'Meesho label (with the product table) on top, tax invoice below.' },
  amazon:   { name:'Amazon',   minGapPt:10, colSplit:true,  minBlockH:0.035, pad:4,
              note:'Amazon / Easy Ship & FBA labels, including 2-up A4 sheets.' },
  generic:  { name:'Generic',  minGapPt:9,  colSplit:true,  minBlockH:0.035, pad:3,
              note:'Structure-based detection \u2014 works with most courier PDFs.' }
};

/* -- app state ------------------------------------------------------- */
const S = {
  files: [],            // {name,size,bytes}
  docsJs: [],           // pdf.js documents
  pages: [],            // {docIdx,pageIdx,jsPage,vw,vh,text,textItems}
  totalBytes: 0,
  platform: 'auto',
  detected: null,
  invoice: 'without',
  mode: 'a4',
  units: [],            // {label:{page,rect}, invoice:{...}|null, ref}
  sheets: [],
  opt: { margin:8, gap:4, invShare:32, pad:3, guides:true, force:'auto' },
  busy: false,
  outBlob: null,
  cropCanvas: new Map()
};

/* -- tiny DOM helpers ------------------------------------------------ */
const $ = id => document.getElementById(id);
const el = (t, cls, css) => { const n = document.createElement(t);
  if (cls) n.className = cls; if (css) Object.assign(n.style, css); return n; };
const show = (n, yes) => n.classList.toggle('hidden', !yes);
const fmtSize = b => b < 1024 ? b+' B' : b < 1048576 ? (b/1024).toFixed(0)+' KB'
                    : (b/1048576).toFixed(1) + ' MB';

/* ===================================================================
   1 \u00b7 LOADING
   \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
async function loadFiles(fileList) {
  const files = [...fileList].filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (!files.length) return fail('That doesn\u2019t look like a PDF. Please pick a .pdf file.');
  resetResults();
  show($('loadErr'), false);
  setBusy(true, 'Reading PDF\u2026');
  try {
    S.files = []; S.docsJs = []; S.pages = []; S.totalBytes = 0; S.cropCanvas.clear();
    for (const f of files) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      S.files.push({ name: f.name, size: f.size, bytes });
      S.totalBytes += f.size;
      const doc = await pdfjsLib.getDocument({ data: bytes.slice(), ...PDFJS_OPTS }).promise;
      S.docsJs.push(doc);
      const d = S.docsJs.length - 1;
      for (let p = 1; p <= doc.numPages; p++) {
        const jsPage = await doc.getPage(p);
        const vp = jsPage.getViewport({ scale: 1 });
        S.pages.push({ docIdx:d, pageIdx:p-1, jsPage, vp, vw:vp.width, vh:vp.height,
                       text:null, items:null, analysis:null });
      }
    }
    renderFileCard();
    await sniffPlatform();
    $('runBtn').disabled = false;
    $('dockSum').innerHTML = `<b>${S.pages.length}</b> page${S.pages.length>1?'s':''} ready \u00b7 choose your options and run detection.`;
  } catch (e) {
    console.error(e);
    fail(e && /password|encrypt/i.test(e.message||'')
      ? 'This PDF is password-protected. Remove the password and try again.'
      : 'Could not read that PDF \u2014 it may be damaged. (' + (e.message||e) + ')');
    S.pages = []; $('runBtn').disabled = true;
  } finally { setBusy(false); }
}
function fail(msg){ $('loadErrMsg').textContent = msg; show($('loadErr'), true); }

function renderFileCard() {
  const f = S.files[0];
  $('fName').textContent = S.files.length === 1 ? f.name
    : `${f.name}  +${S.files.length-1} more file${S.files.length>2?'s':''}`;
  $('fPages').textContent = `${S.pages.length} page${S.pages.length>1?'s':''}`;
  $('fSize').textContent  = fmtSize(S.totalBytes);
  const p0 = S.pages[0];
  $('fDims').textContent  = `${Math.round(pt2mm(p0.vw))}\u00d7${Math.round(pt2mm(p0.vh))} mm`;
  show($('fileCard'), true); show($('drop'), false);
}

/* text of a page, cached */
async function pageText(p) {
  if (p.text !== null) return p.text;
  const tc = await p.jsPage.getTextContent();
  const items = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const [vx, vy] = p.vp.convertToViewportPoint(it.transform[4], it.transform[5]);
    const h = (it.height || 8) * 1.0;
    items.push({ s: it.str.toLowerCase(), x: vx, y: vy - h, w: it.width, h: h * 1.25 });
  }
  p.items = items;
  p.text = items.map(i => i.s).join(' ');
  return p.text;
}

/* -- platform sniffing: per file, so mixed batches still work ---------- */
async function sniffPlatform() {
  for (const f of S.files) f.detected = null;
  for (let i = 0; i < S.files.length; i++) {
    const pages = S.pages.filter(p => p.docIdx === i).slice(0, 3);
    let blob = '';
    for (const p of pages) blob += ' ' + await pageText(p);
    const scores = {};
    for (const [plat, kws] of Object.entries(PLATFORM_KW)) {
      let sc = 0;
      for (const [kw, w] of kws) { const n = countOcc(blob, kw); if (n) sc += w * Math.min(n, 3); }
      scores[plat] = sc;
    }
    const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    S.files[i].detected = best[1] >= 5 ? best[0] : null;
  }
  const found = [...new Set(S.files.map(f => f.detected).filter(Boolean))];
  S.detected = found.length === 1 ? found[0] : null;
  S.mixed = found.length > 1 ? found : null;

  const badge = $('detBadge');
  badge.textContent = S.mixed
    ? 'detected: ' + S.mixed.map(p => PROFILES[p].name).join(' + ') + ' (per file)'
    : S.detected ? 'detected: ' + PROFILES[S.detected].name
    : 'no marketplace fingerprint -- generic rules';
  badge.style.color = (S.detected || S.mixed) ? 'var(--ok)' : 'var(--ink-3)';
  paintPlatforms();
}
const countOcc = (hay, needle) => hay.split(needle).length - 1;

/* the rules a given page is cropped with */
const pageProfile = p => S.platform === 'auto'
  ? PROFILES[(S.files[p.docIdx] && S.files[p.docIdx].detected) || 'generic']
  : PROFILES[S.platform];

const activeProfile = () => PROFILES[
  S.platform === 'auto' ? (S.detected || 'generic') : S.platform ];

/* ===================================================================
   2 \u00b7 PAGE ANALYSIS  \u2014 ink profiling + block classification
   \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
const work = document.createElement('canvas');
const wctx = work.getContext('2d', { willReadFrequently: true });

async function analysePage(p, prof) {
  const key = prof.name;
  if (p.analysis && p.analysis.key === key) return p.analysis;

  await pageText(p);
  const scale = Math.min(1.35, 1100 / Math.max(p.vw, p.vh));
  const vp = p.jsPage.getViewport({ scale });
  work.width = Math.ceil(vp.width); work.height = Math.ceil(vp.height);
  wctx.setTransform(1,0,0,1,0,0);
  wctx.fillStyle = '#fff'; wctx.fillRect(0, 0, work.width, work.height);
  await p.jsPage.render({ canvasContext: wctx, viewport: vp, intent: 'print' }).promise;
  const img = wctx.getImageData(0, 0, work.width, work.height).data;
  const W = work.width, H = work.height;

  const ink = new Uint8Array(W * H);
  const rowSum = new Int32Array(H), colSum = new Int32Array(W);
  for (let y = 0; y < H; y++) {
    let o = y * W * 4, r = 0;
    for (let x = 0; x < W; x++, o += 4) {
      const lum = (img[o]*0.299 + img[o+1]*0.587 + img[o+2]*0.114);
      if (img[o+3] > 20 && lum < 242) { ink[y*W+x] = 1; r++; colSum[x]++; }
    }
    rowSum[y] = r;
  }
  const a = { key, scale, W, H, ink, rowSum, colSum,
              ruleCol: new Uint8Array(W), ruleRow: new Uint8Array(H) };

  a.box = inkBox(a, 0, H, 0, W);
  if (!a.box) { a.strips = []; p.analysis = a; return a; }

  /* Marketplace labels live inside ruled boxes: the frame's own lines put ink
     in every row and column, which would hide every gap between sections.
     Long rules are structure, not content - exclude them from the profiles. */
  const b = a.box, bw = b.x1 - b.x0, bh = b.y1 - b.y0;
  for (let x = b.x0; x < b.x1; x++) if (colInk(a, x, b.y0, b.y1) >= bh * 0.80) a.ruleCol[x] = 1;
  for (let y = b.y0; y < b.y1; y++) if (rowInk(a, y, b.x0, b.x1) >= bw * 0.80) a.ruleRow[y] = 1;

  a.strips = prof.colSplit ? columnStrips(a, p) : [{ x0: a.box.x0, x1: a.box.x1 }];
  p.analysis = a;
  return a;
}

/* bounding box of ink inside a row/col window (returns px coords) */
function inkBox(a, y0, y1, x0, x1) {
  const thrRow = Math.max(1, (x1 - x0) * 0.004);
  let top = -1, bot = -1;
  for (let y = y0; y < y1; y++) { if (rowInk(a, y, x0, x1) > thrRow) { top = y; break; } }
  if (top < 0) return null;
  for (let y = y1 - 1; y >= y0; y--) { if (rowInk(a, y, x0, x1) > thrRow) { bot = y + 1; break; } }
  const thrCol = Math.max(1, (bot - top) * 0.004);
  let lef = -1, rig = -1;
  for (let x = x0; x < x1; x++) { if (colInk(a, x, top, bot) > thrCol) { lef = x; break; } }
  for (let x = x1 - 1; x >= x0; x--) { if (colInk(a, x, top, bot) > thrCol) { rig = x + 1; break; } }
  if (lef < 0) return null;
  return { y0: top, y1: bot, x0: lef, x1: rig };
}
function rowInk(a, y, x0, x1) {
  let n = 0, base = y * a.W;
  for (let x = x0; x < x1; x++) if (!a.ruleCol[x]) n += a.ink[base + x];
  return n;
}
function colInk(a, x, y0, y1) {
  let n = 0;
  for (let y = y0; y < y1; y++) if (!a.ruleRow[y]) n += a.ink[y * a.W + x];
  return n;
}
/* raw ink, masks ignored - used to recognise rules and dashed cut lines */
function rowInkRaw(a, y, x0, x1) {
  let n = 0, base = y * a.W;
  for (let x = x0; x < x1; x++) n += a.ink[base + x];
  return n;
}

/* A real 2-up sheet has a full-height gutter, near-equal halves, and a
   recipient block in every half. Anything looser is just a two-column label. */
const RECIPIENT_ANCHORS = ['ship to','shipto','deliver to','delivery address',
  'customer address','shipping address','consignee','bill to','ship-to'];

function columnStrips(a, p) {
  const { y0, y1, x0, x1 } = a.box;
  const one = [{ x0, x1 }];
  const cw = x1 - x0, h = y1 - y0;
  const minGapPx = Math.max(a.scale * 11, cw * 0.02);
  const thr = Math.max(1, h * 0.012);
  const gaps = []; let run = -1;
  for (let x = x0; x <= x1; x++) {
    const empty = x === x1 ? true : colInk(a, x, y0, y1) <= thr;
    if (empty) { if (run < 0) run = x; }
    else if (run >= 0) { if (x - run >= minGapPx) gaps.push([run, x]); run = -1; }
  }
  if (run >= 0 && x1 - run >= minGapPx) gaps.push([run, x1]);
  const inner = gaps.filter(g => g[0] > x0 + cw * 0.18 && g[1] < x1 - cw * 0.18);
  if (!inner.length) return one;

  const strips = []; let cur = x0;
  for (const g of inner) { strips.push({ x0: cur, x1: g[0] }); cur = g[1]; }
  strips.push({ x0: cur, x1 });
  const wide = strips.filter(s => (s.x1 - s.x0) > cw * 0.2);
  if (wide.length < 2) return one;

  /* measure each half by its actual ink, not by the partition */
  const boxes = wide.map(s => inkBox(a, y0, y1, s.x0, s.x1));
  if (boxes.some(b => !b)) return one;
  const ws = boxes.map(b => b.x1 - b.x0), hs = boxes.map(b => b.y1 - b.y0);
  const ratio = arr => Math.min(...arr) / Math.max(...arr);
  if (ratio(ws) < 0.78 || ratio(hs) < 0.70) return one;   // columns, not labels

  const everyHalfIsALabel = wide.every((s, i) => {
    const t = textIn(p, a, s.x0, s.x1, boxes[i].y0, boxes[i].y1);
    return RECIPIENT_ANCHORS.some(k => t.includes(k));
  });
  return everyHalfIsALabel ? wide : one;
}

/* text (lower-cased) whose item box centre falls in a px window */
function textIn(p, a, px0, px1, py0, py1) {
  const s = a.scale, out = [];
  for (const it of p.items) {
    const cx = (it.x + it.w / 2) * s, cy = (it.y + it.h / 2) * s;
    if (cx >= px0 - 2 && cx <= px1 + 2 && cy >= py0 - 2 && cy <= py1 + 2) out.push(it.s);
  }
  return out.join(' ');
}
function score(text, kws) {
  let s = 0;
  for (const [kw, w] of kws) if (text.includes(kw)) s += w;
  return s;
}

/* -- text rows inside a window, top to bottom (px coords) ------------- */
function textRows(p, a, x0, x1, y0, y1) {
  const items = [];
  for (const it of p.items) {
    const cx = (it.x + it.w/2) * a.scale, top = it.y * a.scale, bot = (it.y + it.h) * a.scale;
    if (cx < x0 - 2 || cx > x1 + 2 || bot < y0 || top > y1) continue;
    items.push({ s: it.s, top, bot });
  }
  items.sort((m, n) => m.top - n.top);
  const rows = [];
  for (const it of items) {
    const last = rows[rows.length - 1];
    if (last && it.top < last.bot - 1) { last.t.push(it.s); last.bot = Math.max(last.bot, it.bot); }
    else rows.push({ top: it.top, bot: it.bot, t: [it.s] });
  }
  return rows.map(r => ({ top: r.top, bot: r.bot, text: r.t.join(' ') }));
}

/* A dashed "cut here" rule: many short ink runs spread across the width. */
function dashRun(a, y, x0, x1) {
  let runs = 0, on = false, ink = 0;
  for (let x = x0; x < x1; x++) {
    if (a.ink[y * a.W + x]) { ink++; if (!on) { runs++; on = true; } } else on = false;
  }
  const frac = ink / Math.max(1, x1 - x0);
  return runs >= 8 && frac > 0.08 && frac < 0.75;
}

/* Where to cut just above `anchorTop`: prefer the dashed cut line the
   marketplace already prints, then the widest band of white, and only
   failing both cut flush with the text. */
function cutAt(a, anchorTop, floorY, x0, x1) {
  const look = Math.max(floorY, anchorTop - 34 * a.scale);
  for (let y = Math.floor(anchorTop); y >= look; y--) {
    if (dashRun(a, y, x0, x1)) {
      let t = y, b = y;
      while (t > floorY && dashRun(a, t - 1, x0, x1)) t--;
      while (b < a.H - 1 && dashRun(a, b + 1, x0, x1)) b++;
      return { end: t - 1, start: b + 2 };
    }
  }
  const thr = Math.max(1, (x1 - x0) * 0.006);
  let best = null, run = -1;
  for (let y = Math.floor(look); y <= anchorTop; y++) {
    const empty = rowInk(a, y, x0, x1) <= thr;
    if (empty) { if (run < 0) run = y; }
    else if (run >= 0) { if (!best || y - run > best[1] - best[0]) best = [run, y]; run = -1; }
  }
  if (run >= 0 && (!best || anchorTop - run > best[1] - best[0])) best = [run, Math.floor(anchorTop)];
  if (best) { const mid = (best[0] + best[1]) / 2; return { end: mid, start: mid }; }
  return { end: anchorTop - 2, start: anchorTop - 2 };
}

/* Fallback when no anchor text matched: the marketplace's own dashed cut line
   is itself the boundary, provided there is real content either side of it and
   the lower half reads as an invoice. Templates change wording far more often
   than they drop the cut line. */
function dashSplit(p, a, x0, x1, y0, y1) {
  const minH = 55 * a.scale;
  const bands = []; let run = -1;
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
    const d = y < y1 && dashRun(a, y, x0, x1);
    if (d) { if (run < 0) run = y; }
    else if (run >= 0) { bands.push([run, y]); run = -1; }
  }
  for (const [t, b] of bands) {
    if (t - y0 < minH || y1 - b < minH) continue;
    const above = textIn(p, a, x0, x1, y0, t), below = textIn(p, a, x0, x1, b, y1);
    if (score(below, INVOICE_KW) > score(below, LABEL_KW) && score(above, LABEL_KW) >= 2)
      return [{ y0, y1: t - 1, type: 'label' }, { y0: b + 2, y1, type: 'invoice' }];
  }
  return null;
}

/* Split a band into label / invoice sections by anchor text. Whitespace alone
   cannot do it: every marketplace prints both inside one ruled box. */
function sectionSplit(p, a, x0, x1, y0, y1) {
  const rows = textRows(p, a, x0, x1, y0, y1);
  const minH = 55 * a.scale;
  const marks = [];
  for (const r of rows) {
    const tag = INV_ANCHOR.test(r.text) ? 'invoice'
              : LBL_ANCHOR.test(r.text) ? 'label' : null;
    if (tag) marks.push({ tag, top: r.top });
  }
  if (!marks.length) return dashSplit(p, a, x0, x1, y0, y1);
  const segs = []; let curTag = marks[0].tag, curTop = y0;
  for (const m of marks) {
    if (m.tag === curTag || m.top - curTop < minH || y1 - m.top < minH) continue;
    const c = cutAt(a, m.top, curTop + minH * 0.5, x0, x1);
    if (c.end - curTop < minH || y1 - c.start < minH) continue;
    segs.push({ y0: curTop, y1: c.end, type: curTag });
    curTop = c.start; curTag = m.tag;
  }
  if (!segs.length) return dashSplit(p, a, x0, x1, y0, y1);
  segs.push({ y0: curTop, y1, type: curTag });
  return segs;
}

/* -- split a strip into stacked blocks, then classify ---------------- */
function stripRegions(p, a, strip, prof) {
  const { x0, x1 } = strip;
  const box = inkBox(a, 0, a.H, x0, x1);
  if (!box) return [];
  const minGapPx = prof.minGapPt * a.scale;
  const thr = Math.max(1, (x1 - x0) * 0.004);

  const runs = []; let start = -1, blank = 0;
  for (let y = box.y0; y <= box.y1; y++) {
    const isInk = y < box.y1 && rowInk(a, y, x0, x1) > thr;
    if (isInk) { if (start < 0) start = y; blank = 0; }
    else if (start >= 0) {
      blank++;
      if (blank >= minGapPx || y === box.y1) { runs.push([start, y - blank + 1]); start = -1; blank = 0; }
    }
  }
  if (start >= 0) runs.push([start, box.y1]);
  if (!runs.length) return [];

  const pageH = a.H;
  const blocks = runs.map(([ry0, ry1]) => {
    const t = textIn(p, a, x0, x1, ry0, ry1);
    const ls = score(t, LABEL_KW), is = score(t, INVOICE_KW);
    let type = 'unknown';
    if (ls >= 2 && ls > is * 1.15) type = 'label';
    else if (is >= 3 && is > ls * 1.15) type = 'invoice';
    const small = (ry1 - ry0) < pageH * prof.minBlockH;
    if (small && Math.max(ls, is) < 5) type = 'unknown';
    return { y0: ry0, y1: ry1, type, text: t };
  });

  let last = null;
  for (const b of blocks) { if (b.type !== 'unknown') last = b.type; else b.type = last; }
  for (let i = blocks.length - 1; i >= 0; i--)
    if (!blocks[i].type) blocks[i].type = blocks[i+1] ? blocks[i+1].type : 'label';

  const merged = [];
  for (const b of blocks) {
    const prev = merged[merged.length - 1];
    if (prev && prev.type === b.type) { prev.y1 = b.y1; prev.text += ' ' + b.text; }
    else merged.push({ type: b.type, y0: b.y0, y1: b.y1, text: b.text });
  }

  /* a band carrying both a label and an invoice gets cut at the anchor */
  const regions = [];
  for (const r of merged) {
    const segs = sectionSplit(p, a, x0, x1, r.y0, r.y1);
    if (segs) regions.push(...segs.map(sg => ({ ...sg, text: textIn(p, a, x0, x1, sg.y0, sg.y1) })));
    else regions.push(r);
  }

  return regions.map(r => {
    const bb = inkBox(a, Math.max(0, Math.floor(r.y0)), Math.min(a.H, Math.ceil(r.y1)), x0, x1)
            || { y0: r.y0, y1: r.y1, x0, x1 };
    return { type: r.type, text: r.text,
             rect: { x: bb.x0 / a.scale, y: bb.y0 / a.scale,
                     w: (bb.x1 - bb.x0) / a.scale, h: (bb.y1 - bb.y0) / a.scale } };
  }).filter(r => r.rect.w > 24 && r.rect.h > 24);
}

/* ===================================================================
   3 \u00b7 DETECTION RUN \u2192 units
   \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
const REF_RE = /(?:order\s*(?:id|no|number)|awb|tracking|shipment\s*id|invoice\s*no)[^a-z0-9]{0,4}([a-z0-9][a-z0-9_\-\/]{5,24})/i;

async function detect() {
  const all = [];                                     // doc-ordered regions
  for (let i = 0; i < S.pages.length; i++) {
    const p = S.pages[i];
    progress((i / S.pages.length) * 0.8, `Analysing page ${i+1} of ${S.pages.length}\u2026`);
    const prof = pageProfile(p);
    const a = await analysePage(p, prof);
    if (!a.box) continue;
    for (const strip of a.strips)
      for (const r of stripRegions(p, a, strip, prof))
        all.push({ ...r, page: p, pageNo: i + 1 });
    if (i % 4 === 3) await raf();
  }
  progress(0.85, 'Pairing labels with invoices\u2026');

  /* a page with nothing recognisable still yields a label = its content box */
  const seen = new Set(all.map(r => r.pageNo));
  for (let i = 0; i < S.pages.length; i++) {
    const p = S.pages[i], a = p.analysis;
    if (seen.has(i + 1) || !a || !a.box) continue;
    all.push({ type:'label', text:'', page:p, pageNo:i+1,
      rect:{ x:a.box.x0/a.scale, y:a.box.y0/a.scale,
             w:(a.box.x1-a.box.x0)/a.scale, h:(a.box.y1-a.box.y0)/a.scale } });
  }
  all.sort((r1, r2) => r1.pageNo - r2.pageNo || r1.rect.y - r2.rect.y || r1.rect.x - r2.rect.x);

  /* pair each label with the invoice that follows it (same page or later) */
  const units = [];
  const labels  = all.filter(r => r.type === 'label');
  const invoices= all.filter(r => r.type === 'invoice');
  if (!labels.length && invoices.length) {          // invoice-only document
    invoices.forEach(r => { r.type = 'label'; labels.push(r); });
    invoices.length = 0;
  }
  const used = new Set();
  for (let i = 0; i < labels.length; i++) {
    const L = labels[i], next = labels[i + 1];
    const after = idx(all, L), stop = next ? idx(all, next) : all.length;
    let inv = null;
    for (let k = after + 1; k < stop; k++)
      if (all[k].type === 'invoice' && !used.has(k)) { inv = all[k]; used.add(k); break; }
    if (!inv) for (let k = after - 1; k >= 0; k--) {     // invoice printed above
      if (all[k].type === 'label') break;
      if (all[k].type === 'invoice' && !used.has(k)) { inv = all[k]; used.add(k); break; }
    }
    const m = (L.text + ' ' + (inv ? inv.text : '')).match(REF_RE);
    if (inv) inv.bodyPt = bodyTextPt(inv.page, inv.rect);
    units.push({ id: 'u' + i, label: L, invoice: inv, ref: m ? m[1].toUpperCase() : '\u2014' });
  }
  S.units = units;
  return units;
}
const idx = (arr, o) => arr.indexOf(o);

/* Typical body-text size inside a crop, in points. Shrinking an invoice is
   only safe until its smallest text stops being readable, so we measure the
   source rather than guess. pageText() stores box height = font height x1.25. */
function bodyTextPt(p, rect) {
  const hs = [];
  for (const it of p.items) {
    const cx = it.x + it.w/2, cy = it.y + it.h/2;
    if (cx < rect.x || cx > rect.x + rect.w || cy < rect.y || cy > rect.y + rect.h) continue;
    if (it.s.trim().length > 2) hs.push(it.h / 1.25);
  }
  if (!hs.length) return 0;
  hs.sort((a, b) => a - b);
  return hs[Math.floor(hs.length * 0.3)];        // the small end of the body copy
}
const raf = () => new Promise(r => setTimeout(r, 0));   // never rAF: hidden tabs freeze it

/* ===================================================================
   4 \u00b7 LAYOUT SOLVER
   \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
const pad = r => {
  const p = S.opt.pad;
  return { x: r.x - p, y: r.y - p, w: r.w + 2*p, h: r.h + 2*p };
};
const clampRect = (r, p) => ({
  x: Math.max(0, r.x), y: Math.max(0, r.y),
  w: Math.min(p.vw, r.x + r.w) - Math.max(0, r.x),
  h: Math.min(p.vh, r.y + r.h) - Math.max(0, r.y)
});

/* geometry of one label(+invoice) unit, normalised to width 1 */
function unitShape(u, withInv) {
  const L = clampRect(pad(u.label.rect), u.label.page);
  const lAR = L.w / L.h;
  const shape = { L, lAR, I: null, iAR: 0, h: 1 / lAR, lh: 1 / lAR, ih: 0, gap: 0 };
  if (withInv && u.invoice) {
    const I = clampRect(pad(u.invoice.rect), u.invoice.page);
    const iAR = I.w / I.h;
    const capH = shape.lh * (S.opt.invShare / 100);      // invoice height budget
    const ih = Math.min(capH, 1 / iAR);                  // never upscale past width 1
    shape.I = I; shape.iAR = iAR; shape.ih = ih;
    shape.gap = 0.022; shape.h = shape.lh + shape.gap + ih;
  }
  return shape;
}
const median = xs => { const s=[...xs].sort((a,b)=>a-b); return s[Math.floor(s.length/2)]; };

function planLayout() {
  /* "with invoice" only changes the geometry if invoices were actually found */
  const withInv = S.invoice === 'with' && S.units.some(u => u.invoice);
  const shapes = S.units.map(u => unitShape(u, withInv));
  if (!shapes.length) return { sheets: [], perPage: 0 };

  if (S.mode === 'label') {                       // one unit per page, 1:1 size
    const sheets = shapes.map((sh, i) => {
      const w = Math.max(sh.L.w, sh.I ? Math.min(sh.L.w, sh.I.w) : 0) + 2 * 4;
      const scale = sh.L.w;                        // unit width = label width (pt)
      const H = sh.h * scale + 8;
      return { w: scale + 8, h: H,
        slots: [{ u: S.units[i], sh, x: 4, y: 4, w: scale, h: sh.h * scale }] };
    });
    return { sheets, perPage: 1, grid: '1 \u00d7 1' };
  }

  /* -- A4 packing ------------------------------------------------- */
  const m = S.opt.margin * MM, g = S.opt.gap * MM;
  const availW = A4.w - 2*m, availH = A4.h - 2*m;
  const AR = 1 / median(shapes.map(s => s.h));    // representative unit aspect (w/h)
  const maxRows = withInv ? 4 : 8, maxCols = withInv ? 3 : 4;
  /* Scale limits protect the two things that actually matter on a label:
     barcodes stay scannable (floor) and a 4x6 never balloons across an
     entire A4 (ceiling). Shrinking is only capped when the label is alone
     on the unit - with an invoice, 3-4 per sheet necessarily means smaller. */
  const nativeW   = median(shapes.map(s => s.L.w));
  const minDrawnW = Math.max(withInv ? 52*MM : 40*MM, nativeW * (withInv ? 0.40 : 0.72));
  /* With an invoice riding along, the unit's size is driven by keeping that
     invoice legible, so allow a more generous enlargement than for a lone
     label - where blowing a 4x6 across a whole A4 would just waste toner. */
  const maxDrawnW = nativeW * (withInv ? 1.8 : 1.3);

  const cand = [];
  for (let cols = 1; cols <= maxCols; cols++) {
    for (let rows = 1; rows <= maxRows; rows++) {
      const n = cols * rows;
      if (withInv && n > 4) continue;             // brief: 3-4 units per sheet
      if (S.opt.force !== 'auto' && n !== +S.opt.force) continue;
      if (S.opt.force === 'auto' && n > S.units.length) continue;   // no dead cells
      const cw = (availW - (cols-1)*g) / cols, ch = (availH - (rows-1)*g) / rows;
      if (cw <= 0 || ch <= 0) continue;
      /* fill the cell, but never enlarge past the ceiling - a lone 4x6 label
         is centred at near its printed size instead of stretched over A4 */
      const dw = Math.min(cw, ch * AR, maxDrawnW), dh = dw / AR;
      const util = n * dw * dh / (A4.w * A4.h);
      cand.push({ cols, rows, cw, ch, dw, dh, n, sc: util, fits: dw >= minDrawnW });
    }
  }
  /* With an invoice the brief wants 3-4 shipment units per sheet whenever the
     size floor allows it; without one, densest-but-readable simply wins. */
  const rank = withInv && S.opt.force === 'auto'
    ? (a, b) => (b.n >= 3) - (a.n >= 3) || b.n - a.n || b.sc - a.sc
    : (a, b) => b.sc - a.sc;
  const pool = cand.filter(c => c.fits);
  let best = (pool.length ? pool : cand).sort(rank)[0];
  if (!best) {                                     // pathological page size
    const dw = Math.min(availW, availH * AR);
    best = { cols:1, rows:1, cw:availW, ch:availH, dw, dh:dw/AR, n:1, sc:0 };
  }

  const sheets = [];
  for (let i = 0; i < S.units.length; i += best.n) {
    const slots = [];
    for (let k = 0; k < best.n && i + k < S.units.length; k++) {
      const sh = shapes[i + k];
      const c = k % best.cols, r = Math.floor(k / best.cols);
      /* fit this unit's own aspect inside the cell -- contain, never stretch,
         under the same enlargement ceiling the grid was chosen with */
      const uw = Math.min(best.cw, best.ch / sh.h, maxDrawnW), uh = uw * sh.h;
      const cx = m + c * (best.cw + g), cy = m + r * (best.ch + g);
      slots.push({ u: S.units[i + k], sh,
        x: cx + (best.cw - uw)/2, y: cy + (best.ch - uh)/2, w: uw, h: uh,
        cell: { x: cx, y: cy, w: best.cw, h: best.ch } });
    }
    sheets.push({ w: A4.w, h: A4.h, slots, grid: best });
  }
  return { sheets, perPage: best.n, grid: `${best.cols} \u00d7 ${best.rows}` };
}

/* where the label / invoice sit inside a placed unit */
function slotParts(s) {
  const sh = s.sh, sc = s.w;                       // unit width in pt
  const parts = [{ kind:'label', src: s.u.label, x: s.x, y: s.y, w: sc, h: sh.lh * sc }];
  if (sh.I) {
    const ih = sh.ih * sc, iw = Math.min(sc, ih * sh.iAR);
    parts.push({ kind:'invoice', src: s.u.invoice,
      x: s.x + (sc - iw)/2, y: s.y + (sh.lh + sh.gap) * sc, w: iw, h: ih });
  }
  return parts;
}

/* ===================================================================
   5 \u00b7 PREVIEW
   \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
let pvIndex = 0;
async function renderPreview(plan) {
  const host = $('sheets'); host.innerHTML = '';
  show($('pvEmpty'), plan.sheets.length === 0);
  show(host, plan.sheets.length > 0);
  const total = plan.sheets.length;
  const many = total > 4;
  show($('pvPrev'), many); show($('pvNext'), many); show($('pvNav'), many);
  if (pvIndex >= total) pvIndex = 0;
  const list = many ? [pvIndex] : plan.sheets.map((_, i) => i);
  $('pvNav').textContent = `${pvIndex+1} / ${total}`;
  $('pvSub').textContent = `${plan.perPage} per sheet \u00b7 ${plan.grid || ''}`;

  for (const si of list) {
    const sheet = plan.sheets[si];
    const PX = Math.min(1, 430 / sheet.w) * (sheet.w > 400 ? 1 : 1.6);
    const box = el('div');
    const node = el('div', 'sheet', { width: sheet.w*PX+'px', height: sheet.h*PX+'px' });
    for (const s of sheet.slots) {
      const u = el('div', 'u', { left:s.x*PX+'px', top:s.y*PX+'px',
                                 width:s.w*PX+'px', height:s.h*PX+'px' });
      for (const part of slotParts(s)) {
        const holder = el('div', '', { position:'absolute',
          left:(part.x - s.x)*PX+'px', top:(part.y - s.y)*PX+'px',
          width:part.w*PX+'px', height:part.h*PX+'px', overflow:'hidden' });
        if (part.kind === 'invoice')
          Object.assign(holder.style, { borderTop:'1px solid var(--line)' });
        holder.appendChild(await cropCanvas(part, Math.max(part.w*PX*2, 90)));
        u.appendChild(holder);
      }
      node.appendChild(u);
    }
    box.appendChild(node);
    const cap = el('div', 'sheet-cap');
    cap.textContent = sheet.w === A4.w
      ? `Sheet ${si+1} of ${total} \u00b7 A4 \u00b7 ${sheet.slots.length} unit${sheet.slots.length>1?'s':''}`
      : `Label ${si+1} of ${total} \u00b7 ${Math.round(pt2mm(sheet.w))}\u00d7${Math.round(pt2mm(sheet.h))} mm`;
    box.appendChild(cap);
    host.appendChild(box);
  }
}

/* render one crop region to a canvas (cached) */
async function cropCanvas(part, targetPx) {
  const src = part.src, r = clampRect(pad(src.rect), src.page);
  const key = `${src.page.docIdx}:${src.page.pageIdx}:${r.x.toFixed(1)}:${r.y.toFixed(1)}:${r.w.toFixed(1)}:${Math.round(targetPx/40)}`;
  if (S.cropCanvas.has(key)) return S.cropCanvas.get(key).cloneNode(true)
    .getContext ? cloneCanvas(S.cropCanvas.get(key)) : S.cropCanvas.get(key);
  const s = Math.min(3, Math.max(0.35, targetPx / r.w));
  const c = el('canvas'); c.width = Math.max(1, Math.round(r.w*s)); c.height = Math.max(1, Math.round(r.h*s));
  Object.assign(c.style, { width:'100%', height:'100%' });
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0,0,c.width,c.height);
  await src.page.jsPage.render({
    canvasContext: ctx, intent: 'print',
    viewport: src.page.jsPage.getViewport({ scale: s }),
    transform: [1, 0, 0, 1, -r.x * s, -r.y * s]
  }).promise;
  S.cropCanvas.set(key, c);
  return cloneCanvas(c);
}
function cloneCanvas(c) {
  const n = el('canvas'); n.width = c.width; n.height = c.height;
  Object.assign(n.style, { width:'100%', height:'100%' });
  n.getContext('2d').drawImage(c, 0, 0);
  return n;
}

/* ===================================================================
   6 \u00b7 PDF COMPOSITION (vector, via pdf-lib)
   \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
async function buildPDF(plan) {
  const out = await PDFDocument.create();
  out.setTitle('ShipTrim \u2014 print-ready labels');
  out.setProducer('ShipTrim');
  const srcDocs = [];
  for (const f of S.files) srcDocs.push(await PDFDocument.load(f.bytes, { ignoreEncryption:true }));

  const cache = new Map();
  /* A Form XObject's /BBox and its content stream share one space: the source
     page's user space. So the clip box must be in page coordinates and /Matrix
     only shifts the crop's corner onto the origin. Page /Rotate is not baked
     into the form - it is re-applied when the form is placed. */
  async function embed(part) {
    const p = part.src.page, r = clampRect(pad(part.src.rect), p);
    const c1 = p.vp.convertToPdfPoint(r.x, r.y);
    const c2 = p.vp.convertToPdfPoint(r.x + r.w, r.y + r.h);
    const left = Math.min(c1[0], c2[0]), right = Math.max(c1[0], c2[0]);
    const bottom = Math.min(c1[1], c2[1]), top = Math.max(c1[1], c2[1]);
    const key = `${p.docIdx}:${p.pageIdx}:${left.toFixed(2)}:${bottom.toFixed(2)}:${right.toFixed(2)}:${top.toFixed(2)}`;
    if (cache.has(key)) return cache.get(key);
    const emb = await out.embedPage(srcDocs[p.docIdx].getPage(p.pageIdx),
                 { left, bottom, right, top }, [1, 0, 0, 1, -left, -bottom]);
    cache.set(key, emb); return emb;
  }

  /* place an embedded crop upright inside a top-left-origin target rect */
  function place(page, emb, rot, X, Ytop, TW, TH, sheetH) {
    const Y = sheetH - Ytop - TH;
    const swap = rot % 180 !== 0;
    const w = swap ? TH : TW, h = swap ? TW : TH;
    let x = X, y = Y;
    if (rot === 90)  { y = Y + TH; }
    else if (rot === 180) { x = X + TW; y = Y + TH; }
    else if (rot === 270) { x = X + TW; }
    page.drawPage(emb, { x, y, width: w, height: h, rotate: degrees(-rot) });
  }

  let done = 0;
  for (const sheet of plan.sheets) {
    const page = out.addPage([sheet.w, sheet.h]);
    for (const s of sheet.slots) {
      for (const part of slotParts(s)) {
        const emb = await embed(part);
        const rot = ((part.src.page.jsPage.rotate % 360) + 360) % 360;
        place(page, emb, rot, part.x, part.y, part.w, part.h, sheet.h);
      }
      if (S.opt.guides && sheet.w === A4.w && s.cell) {
        const c = s.cell, y = sheet.h - (c.y + c.h) - S.opt.gap*MM/2;
        if (c.y + c.h < sheet.h - S.opt.margin*MM - 1)
          page.drawLine({ start:{x:c.x, y}, end:{x:c.x+c.w, y},
            thickness:0.4, color: rgb(.82,.84,.87), dashArray:[3,3] });
        if (c.x + c.w < sheet.w - S.opt.margin*MM - 1) {
          const gx = c.x + c.w + S.opt.gap*MM/2;
          page.drawLine({ start:{x:gx, y:sheet.h-c.y}, end:{x:gx, y:sheet.h-c.y-c.h},
            thickness:0.4, color: rgb(.82,.84,.87), dashArray:[3,3] });
        }
      }
    }
    done++;
    progress(0.85 + 0.15 * (done / plan.sheets.length), `Writing sheet ${done} of ${plan.sheets.length}\u2026`);
    if (done % 5 === 0) await raf();
  }
  const bytes = await out.save({ useObjectStreams: true });
  return new Blob([bytes], { type: 'application/pdf' });
}

/* ===================================================================
   7 \u00b7 ORCHESTRATION
   \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
async function run() {
  if (S.busy || !S.pages.length) return;
  setBusy(true, 'Detecting label regions\u2026');
  try {
    await detect();
    if (!S.units.length) {
      fail('No printable content was found in this PDF.');
      setBusy(false); return;
    }
    const plan = planLayout();
    S.plan = plan;
    progress(0.85, 'Composing PDF\u2026');
    S.outBlob = await buildPDF(plan);
    await renderPreview(plan);
    paintResults(plan);
  } catch (e) {
    console.error(e); fail('Processing failed: ' + (e.message || e));
  } finally { setBusy(false); }
}

/* re-layout only (options changed) -- detection results are reused */
async function relayout() {
  if (!S.units.length || S.busy) return;
  setBusy(true, 'Re-arranging\u2026');
  try {
    const plan = planLayout(); S.plan = plan;
    S.outBlob = await buildPDF(plan);
    await renderPreview(plan);
    paintResults(plan);
  } catch (e) { console.error(e); fail('Layout failed: ' + (e.message||e)); }
  finally { setBusy(false); }
}

function paintResults(plan) {
  const n = S.units.length, sheets = plan.sheets.length;
  const withInv = S.invoice === 'with';
  const paired = S.units.filter(u => u.invoice).length;
  show($('resultBox'), true);
  $('headline').innerHTML =
    `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
     ${n} label${n>1?'s':''} <span class="arrow">\u2192</span> ${sheets} ${plan.perPage===1?'label page':'A4 page'}${sheets>1?'s':''}`;
  $('summary').innerHTML = [
    ['Labels', n],
    ['Output pages', sheets],
    [plan.perPage === 1 ? 'Per page' : 'Per A4 sheet', plan.perPage],
    ['Invoices', withInv ? `${paired}/${n}` : '\u2014']
  ].map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');

  /* detection table */
  show($('detCard'), true);
  $('detSub').textContent = S.platform === 'auto' && S.mixed
    ? S.mixed.map(p => PROFILES[p].name).join(' + ') + ' rules, applied per file'
    : `${activeProfile().name} rules \u00b7 ${activeProfile().note}`;
  $('detBody').innerHTML = S.units.map((u, i) => {
    const r = clampRect(pad(u.label.rect), u.label.page);
    return `<tr><td>${i+1}</td><td>p${u.label.pageNo}</td>
      <td class="mono">${Math.round(pt2mm(r.w))}\u00d7${Math.round(pt2mm(r.h))} mm</td>
      <td>${u.invoice ? '<span class="tag ok">paired</span>' : '<span class="tag no">none</span>'}</td>
      <td class="mono">${u.ref}</td></tr>`;
  }).join('');
  /* Say plainly how small the invoice ends up, and what would fix it. An
     A4 invoice packed 4-up cannot stay readable however the slider is set --
     only a bigger unit can do that, so the advice has to distinguish them. */
  const note = $('invNote');
  const slot = plan.sheets[0] && plan.sheets[0].slots.find(s => s.sh.I);
  if (withInv && slot) {
    const sh = slot.sh, sc = slot.w;
    const ih = sh.ih * sc, iw = Math.min(sc, ih * sh.iAR);
    const u = slot.u, f = iw / u.invoice.rect.w, src = u.invoice.bodyPt || 0;
    const pts = src * f;
    const bestF = sc / u.invoice.rect.w;          // widest it could ever be drawn
    const READABLE = 4.0;   // practical floor for printed body text
    const canSlide = src * bestF >= READABLE;
    let msg = `Invoice prints at <b>${Math.round(f*100)}%</b> of the original ` +
      `(${Math.round(pt2mm(iw))}\u00d7${Math.round(pt2mm(ih))} mm` +
      (src ? `, body text \u2248 ${pts.toFixed(1)} pt` : '') +
      `), label at <b>${Math.round(sc / u.label.rect.w * 100)}%</b>.`;
    if (src && pts < READABLE) {
      msg += ' <b>That text is too small to read.</b> ';
      msg += canSlide ? 'Raise "Invoice size" in advanced controls.'
        : plan.perPage > 1
          ? `It cannot get bigger at ${plan.perPage} units per sheet \u2014 force fewer ` +
            'units per A4 page in advanced controls, or use Label mode.'
          : 'This invoice is too dense to shrink and still be read \u2014 Label mode ' +
            'prints it at full size.';
    }
    note.innerHTML = msg;
    note.style.color = (src && pts < READABLE) ? 'var(--warn)' : 'var(--ink-3)';
    show(note, true);
  } else show(note, false);

  const missing = n - paired;
  const warn = withInv && missing > 0;
  show($('detWarn'), warn);
  if (warn) $('detWarnMsg').innerHTML =
    `<b>${missing} of ${n}</b> shipments have no invoice section in the source PDF \u2014 those units print label-only so nothing is lost or mispaired.`;

  $('dlBtn').disabled = false; $('printBtn').disabled = false;
  $('dockSum').innerHTML =
    `<b>${n}</b> label${n>1?'s':''} \u2192 <b>${sheets}</b> page${sheets>1?'s':''} \u00b7 ${plan.perPage} per sheet${withInv?` \u00b7 ${paired} invoice${paired!==1?'s':''} paired`:''} \u00b7 ${fmtSize(S.outBlob.size)}`;
}

/* ===================================================================
   8 \u00b7 UI WIRING
   \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
const PLATFORMS = [
  { id:'flipkart', nm:'Flipkart', ds:'Label + invoice', color:'#2874f0',
    mark:'<svg width="22" height="22" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="4" fill="#2874f0"/><path d="M8 8h8M8 12h5" stroke="#fff" stroke-width="2" stroke-linecap="round"/><path d="M15.5 15.5l2.2 2.2" stroke="#f9d423" stroke-width="2" stroke-linecap="round"/></svg>' },
  { id:'meesho', nm:'Meesho', ds:'Label + tax invoice', color:'#f43397',
    mark:'<svg width="22" height="22" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="4" fill="#f43397"/><path d="M7 16V9l2.6 4L12 9l2.4 4L17 9v7" stroke="#fff" stroke-width="1.9" stroke-linejoin="round" fill="none" stroke-linecap="round"/></svg>' },
  { id:'amazon', nm:'Amazon', ds:'Easy Ship / FBA', color:'#ff9900',
    mark:'<svg width="22" height="22" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="4" fill="#232f3e"/><path d="M7 14.5c3 2 7 2 10 0" stroke="#ff9900" stroke-width="1.9" stroke-linecap="round" fill="none"/><path d="M8 10.5h8" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/></svg>' },
  { id:'auto', nm:'Auto Detect', ds:'Reads the PDF', color:'#1248a6',
    mark:'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#1248a6" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="6.2"/><path d="M20 20l-3.6-3.6"/><path d="M11 8.4v5.2M8.4 11h5.2"/></svg>' }
];
function paintPlatforms() {
  $('platGrid').innerHTML = PLATFORMS.map(p => `
    <button class="plat" data-p="${p.id}" aria-pressed="${S.platform===p.id}">
      <span class="tick"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg></span>
      <span class="mark">${p.mark}</span>
      <span class="nm">${p.nm}</span>
      <span class="ds">${p.id==='auto' && S.mixed ? 'per-file rules'
        : p.id==='auto' && S.detected ? PROFILES[S.detected].name+' found' : p.ds}</span>
    </button>`).join('');
  $('platGrid').querySelectorAll('.plat').forEach(b =>
    b.onclick = () => { S.platform = b.dataset.p; paintPlatforms(); onRulesChanged(); });
  $('platHint').textContent = S.platform === 'auto' && S.mixed
    ? 'Mixed batch: ' + listOf(S.mixed.map(p => PROFILES[p].name)) +
      ' were found, and each file is cropped with its own rules.'
    : activeProfile().note +
      (S.platform === 'auto' && S.detected ? ' Auto-detected from the document text.' : '');
}
function bindSeg(id, key, after) {
  $(id).querySelectorAll('button').forEach(b => b.onclick = () => {
    S[key] = b.dataset.v;
    $(id).querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b));
    after && after();
  });
}
function modeHint() {
  const a4 = S.mode === 'a4', wi = S.invoice === 'with';
  $('modeHint').textContent = a4
    ? (wi ? 'Each label keeps its full size with its own invoice scaled beneath it; 3\u20134 shipment units are packed per A4 sheet, pairing and order preserved.'
          : 'Labels are packed as large as they will go \u2014 the grid is chosen from the real label dimensions, not a fixed template.')
    : (wi ? 'One shipment per page, sized to the label itself (100% scale) with the invoice beneath \u2014 for 4\u00d76 thermal printers.'
          : 'One label per page at its original size \u2014 ideal for thermal/label printers.');
  $('runLabel').textContent = S.units.length ? 'Re-run detection' : 'Detect & build layout';
}
function onRulesChanged() {           // detection rules changed \u2192 full re-run
  modeHint();
  if (S.units.length) run();
}
function onLayoutChanged() { modeHint(); if (S.units.length) relayout(); }

/* dropzone */
const drop = $('drop');
['dragenter','dragover'].forEach(t => drop.addEventListener(t, e => {
  e.preventDefault(); drop.classList.add('over'); }));
['dragleave','drop'].forEach(t => drop.addEventListener(t, e => {
  e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => e.dataTransfer.files.length && loadFiles(e.dataTransfer.files));
drop.onclick = () => $('fileInput').click();
drop.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fileInput').click(); } };
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => e.preventDefault());
$('fileInput').onchange = e => e.target.files.length && loadFiles(e.target.files);
$('changeBtn').onclick = () => $('fileInput').click();
$('resetBtn').onclick = () => location.reload();

bindSeg('segInvoice', 'invoice', onLayoutChanged);
bindSeg('segMode', 'mode', onLayoutChanged);
$('runBtn').onclick = run;

/* advanced controls */
const sliders = [['optMargin','margin','valMargin',v=>v+' mm'],
                 ['optGap','gap','valGap',v=>v+' mm'],
                 ['optInv','invShare','valInv',v=>v+'%'],
                 ['optPad','pad','valPad',v=>v+' pt']];
let slideTimer;
sliders.forEach(([id,key,vid,fmt]) => {
  const input = $(id);
  input.oninput = () => { S.opt[key] = +input.value; $(vid).textContent = fmt(input.value);
    clearTimeout(slideTimer); slideTimer = setTimeout(onLayoutChanged, 260); };
  $(vid).textContent = fmt(input.value);
});
$('optGuides').onclick = () => { S.opt.guides = !S.opt.guides;
  $('optGuides').setAttribute('aria-pressed', S.opt.guides); onLayoutChanged(); };
$('optForce').onchange = e => { S.opt.force = e.target.value; onLayoutChanged(); };

/* preview paging */
$('pvPrev').onclick = () => { if (S.plan) { pvIndex = (pvIndex - 1 + S.plan.sheets.length) % S.plan.sheets.length; renderPreview(S.plan); } };
$('pvNext').onclick = () => { if (S.plan) { pvIndex = (pvIndex + 1) % S.plan.sheets.length; renderPreview(S.plan); } };

/* download / print */
$('dlBtn').onclick = () => {
  if (!S.outBlob) return;
  const base = (S.files[0]?.name || 'labels').replace(/\.pdf$/i, '');
  const tag = S.mode === 'a4' ? 'A4' : 'label';
  const a = el('a'); a.href = URL.createObjectURL(S.outBlob);
  a.download = `${base}-${tag}-${S.units.length}labels.pdf`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
};
$('printBtn').onclick = () => {
  if (!S.outBlob) return;
  const url = URL.createObjectURL(S.outBlob);
  const f = el('iframe', '', { position:'fixed', right:'0', bottom:'0', width:'0', height:'0', border:'0' });
  f.src = url;
  f.onload = () => { try { f.contentWindow.focus(); f.contentWindow.print(); }
                     catch { window.open(url, '_blank'); } };
  document.body.appendChild(f);
};

/* progress + busy */
function setBusy(on, msg) {
  S.busy = on;
  show($('progress'), on);
  $('runBtn').disabled = on || !S.pages.length;
  $('pBar').classList.toggle('indet', on);
  if (on) { $('pMsg').textContent = msg || 'Working\u2026'; $('pPct').textContent = ''; }
  $('runBtn').innerHTML = on
    ? '<span class="spinner"></span> Processing\u2026'
    : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4.5 12.5h6L11 22l8.5-10.5h-6L13 2z"/></svg><span id="runLabel"></span>';
  if (!on) modeHint();
}
function progress(frac, msg) {
  const bar = $('pBar'); bar.classList.remove('indet');
  bar.firstElementChild.style.width = Math.round(Math.min(1, frac) * 100) + '%';
  $('pMsg').textContent = msg; $('pPct').textContent = Math.round(Math.min(1, frac) * 100) + '%';
}
function resetResults() {
  S.units = []; S.plan = null; S.outBlob = null; pvIndex = 0;
  show($('resultBox'), false); show($('detCard'), false);
  show($('sheets'), false); show($('pvEmpty'), true);
  $('dlBtn').disabled = true; $('printBtn').disabled = true;
}
/* Opened by double-click, the browser blocks the worker and the font data
   fetch, and pdf.js would simply stall. Say so instead of hanging. */
if (location.protocol === 'file:') {
  fail('Open ShipTrim through a local web server, not by double-clicking the file \u2014 ' +
       'browsers block the PDF engine on file:// URLs. Run "python3 -m http.server 4178" ' +
       'in this folder, then visit http://localhost:4178');
  $('drop').style.pointerEvents = 'none';
  $('drop').style.opacity = '.5';
}

modeHint(); paintPlatforms();

/* -- debug/automation hook: load a PDF by URL --------------------- */
window.ShipTrim = {
  S, run, relayout, planLayout,
  _internals: { analysePage, stripRegions, activeProfile, textIn, score, LABEL_KW, INVOICE_KW },
  async loadUrl(url, name) {
    const r = await fetch(url); const b = await r.blob();
    await loadFiles([new File([b], name || url.split('/').pop(), { type:'application/pdf' })]);
  }
};
