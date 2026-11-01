// The page sweep's layout check (plan 213 C1). capture-ui-pages.mjs runs
// `layoutCheckSource` in the renderer after every shot and gets back what
// would break a streamer on a small window or display:
//   overflow    a region that scrolls sideways (the page or a pane in it)
//   off-screen  a control left or right of the window
//   clipped     a control cut by an ancestor that hides its overflow
//   unreachable a control below the window with nothing to scroll it into view
//   overlap     two controls drawn over each other (what each shows on
//               screen, after its scroll containers clip it; a control laid
//               over another on purpose, absolutely positioned, is skipped)
//   narrow      a page section sharing its row, squeezed under
//               NARROW_SECTION_PX (the Studio's inspector is its own layout,
//               20 rem by design, plan 174 S3.3)
// and, as information only, `truncated`: text cut with an ellipsis.

/** The plan's three window sizes: the 960×660 minimum, a laptop, and roomy. */
export const UI_SWEEP_SIZES = Object.freeze([
  Object.freeze({ width: 960, height: 660 }),
  Object.freeze({ width: 1100, height: 720 }),
  Object.freeze({ width: 1280, height: 800 })
])

/** A page section beside another and narrower than this is two columns too many. */
export const NARROW_SECTION_PX = 400

/** Kinds that fail `--gate`. `truncated` is reported but never fails. */
export const BREAKING_KINDS = Object.freeze([
  'overflow',
  'off-screen',
  'clipped',
  'unreachable',
  'overlap',
  'narrow'
])

/** `960x660,1280x800` → sizes; throws on anything else. */
export function parseSizes(value) {
  return value.split(',').map((part) => {
    const match = /^(\d{3,4})x(\d{3,4})$/.exec(part.trim())
    if (!match) {
      throw new Error(`A size is WIDTHxHEIGHT, got ${JSON.stringify(part)}`)
    }
    return { width: Number(match[1]), height: Number(match[2]) }
  })
}

/** The findings that fail the sweep. */
export function breakingFindings(findings) {
  return findings.filter((finding) => BREAKING_KINDS.includes(finding.kind))
}

// Runs in the renderer through the smoke server's `eval-js` (an async
// function body). Kept as plain ES so it needs no transform.
export const layoutCheckSource = `
const NARROW = ${NARROW_SECTION_PX};
const vw = window.innerWidth;
const vh = window.innerHeight;
const root = document.querySelector('main') ?? document.body;
const findings = [];
const describe = (el) => {
  const label = el.getAttribute('aria-label') || el.getAttribute('data-slot') || el.getAttribute('data-testid') || '';
  const text = (el.innerText || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 48);
  return el.tagName.toLowerCase() + (label ? '[' + label + ']' : '') + (text ? ' "' + text + '"' : '');
};
const hidden = (el) => {
  if (el.closest('[aria-hidden="true"], [inert], [hidden]')) return true;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 1 || rect.height <= 1) return true;
  for (let node = el; node && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return true;
    if (style.clipPath && style.clipPath !== 'none') return true;
  }
  return false;
};
const round = (n) => Math.round(n);
// What a control shows: its box clipped by every ancestor that clips.
const visibleRect = (el) => {
  const r = el.getBoundingClientRect();
  let left = r.left, top = r.top, right = r.right, bottom = r.bottom;
  for (let node = el.parentElement; node && node !== document.documentElement; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
    const box = node.getBoundingClientRect();
    left = Math.max(left, box.left); right = Math.min(right, box.right);
    top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom);
  }
  return { left, top, right, bottom };
};
// Laid over its neighbours on purpose: a card's corner action, a pinned row.
const overlay = (el) => {
  for (let node = el; node && node !== root; node = node.parentElement) {
    const position = getComputedStyle(node).position;
    if (position === 'absolute' || position === 'fixed' || position === 'sticky') return true;
  }
  return false;
};

for (const el of [document.documentElement, ...root.querySelectorAll('*')]) {
  const style = getComputedStyle(el);
  const scrolls = style.overflowX === 'auto' || style.overflowX === 'scroll' || el === document.documentElement;
  if (scrolls && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && !hidden(el)) {
    findings.push({ kind: 'overflow', what: describe(el), by: el.scrollWidth - el.clientWidth });
  }
}

const controls = [...root.querySelectorAll(
  'button, input:not([type="hidden"]), select, textarea, a[href], [role="switch"], [role="combobox"], [role="tab"], [role="slider"], [role="checkbox"], [role="radio"]'
)].filter((el) => !hidden(el));

for (const el of controls) {
  const rect = el.getBoundingClientRect();
  if (rect.right > vw + 0.5 || rect.left < -0.5) {
    findings.push({ kind: 'off-screen', what: describe(el), left: round(rect.left), right: round(rect.right) });
    continue;
  }
  let scrollsY = false;
  for (let node = el.parentElement; node && node !== document.documentElement; node = node.parentElement) {
    const style = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    if ((style.overflowX === 'hidden' || style.overflowX === 'clip') &&
        (rect.right > box.right + 1 || rect.left < box.left - 1)) {
      findings.push({ kind: 'clipped', what: describe(el), by: describe(node), axis: 'x' });
      break;
    }
    if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
      scrollsY = true;
      break;
    }
    if ((style.overflowY === 'hidden' || style.overflowY === 'clip') &&
        (rect.bottom > box.bottom + 1 || rect.top < box.top - 1)) {
      findings.push({ kind: 'clipped', what: describe(el), by: describe(node), axis: 'y' });
      break;
    }
  }
  if (!scrollsY && rect.bottom > vh + 0.5) {
    findings.push({ kind: 'unreachable', what: describe(el), bottom: round(rect.bottom) });
  }
}

const placed = controls.filter((el) => !overlay(el)).map((el) => ({ el, rect: visibleRect(el) }));
for (let i = 0; i < placed.length; i += 1) {
  const { el: a, rect: ra } = placed[i];
  for (let j = i + 1; j < placed.length; j += 1) {
    const { el: b, rect: rb } = placed[j];
    if (a.contains(b) || b.contains(a)) continue;
    const x = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
    const y = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
    if (x > 4 && y > 4) {
      findings.push({ kind: 'overlap', what: describe(a), with: describe(b), x: round(x), y: round(y) });
    }
  }
}

for (const el of root.querySelectorAll('[data-slot="panel-section"]')) {
  if (hidden(el) || el.closest('[class~="@container/studio"]')) continue;
  const width = el.getBoundingClientRect().width;
  const page = (root.querySelector('[data-slot="pane-body"]') ?? root).getBoundingClientRect().width;
  if (width < NARROW && width < page - 2) {
    const title = el.querySelector('[data-slot="panel-section-header"]');
    findings.push({ kind: 'narrow', what: describe(title ?? el), width: round(width) });
  }
}

for (const el of root.querySelectorAll('*')) {
  if (el.children.length > 0 || hidden(el)) continue;
  const style = getComputedStyle(el);
  if (style.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1) {
    findings.push({ kind: 'truncated', what: describe(el) });
  }
}
return { width: vw, height: vh, findings };
`
