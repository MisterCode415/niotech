import sanitizeHtml from 'sanitize-html';

/**
 * Marketing HTML is written by business-unit admins and rendered on the public storefront, in
 * the same origin as the patient session. Anything executable there is a path to a patient's
 * token and PHI, so the page is reduced to inert markup: layout, text, images, links, CSS, and
 * the radio/checkbox + label controls the CSS-only interactive templates rely on.
 */

const ALLOWED_TAGS = [
  'a', 'abbr', 'address', 'article', 'aside', 'b', 'blockquote', 'br', 'caption', 'cite',
  'code', 'col', 'colgroup', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'figcaption',
  'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img', 'input',
  'ins', 'kbd', 'label', 'li', 'main', 'mark', 'nav', 'ol', 'p', 'pre', 'q', 's', 'section',
  'small', 'span', 'strong', 'style', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot',
  'th', 'thead', 'tr', 'u', 'ul',
];

/** CSS can fetch resources and (in old engines) run code. Keep https/data-image urls only. */
export function cleanCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, '')
    .replace(/expression\s*\(/gi, 'blocked(')
    .replace(/javascript\s*:/gi, 'blocked:')
    .replace(/vbscript\s*:/gi, 'blocked:')
    .replace(/behavior\s*:/gi, 'blocked:')
    .replace(/-moz-binding\s*:/gi, 'blocked:')
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, _quote: string, target: string) =>
      /^(https:|data:image\/(png|jpe?g|gif|webp);)/i.test(target.trim()) ? match : 'none',
    );
}

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: {
    '*': ['class', 'id', 'style', 'title', 'lang', 'dir', 'role', 'aria-label', 'aria-hidden'],
    a: ['href', 'target', 'rel', 'name'],
    img: ['src', 'alt', 'width', 'height', 'loading'],
    input: ['type', 'name', 'id', 'value', 'checked', 'disabled'],
    label: ['for'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan', 'scope'],
    details: ['open'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['https', 'data'] },
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  allowProtocolRelative: false,
  // <style> is intentionally allowed; its text is scrubbed by textFilter below.
  allowVulnerableTags: true,
  textFilter: (text, tagName) => (tagName === 'style' ? cleanCss(text) : text),
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, rel: 'noopener noreferrer' },
    }),
    input: (tagName, attribs) => {
      // Only inert, CSS-selectable controls; text fields would invite credential phishing.
      const type = (attribs.type ?? '').toLowerCase();
      const next: sanitizeHtml.Attributes =
        type === 'radio' || type === 'checkbox'
          ? { ...attribs, type }
          : { type: 'checkbox', disabled: 'disabled' };
      return { tagName, attribs: next };
    },
    '*': (tagName, attribs) => {
      const next = { ...attribs };
      if (typeof next.style === 'string') next.style = cleanCss(next.style);
      return { tagName, attribs: next };
    },
  },
};

export function sanitizeMarketingHtml(html: string): string {
  return sanitizeHtml(html, OPTIONS);
}
