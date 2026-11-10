// D15: `source.sample` hands the agent the structure of a page, never its text. `reduceStructure`
// walks the DOM and keeps tags, ids, classes and attribute names; `formatStructure` prints it
// one node per line. The outline carries no content: no text (only its length), no attribute
// value except the method and action path of a form, the rel of a link and the type and name of
// an input; ids and classes that name a user of the page or look like a token are dropped.

export interface StructNode {
  tag: string;
  id?: string;
  classes: string[];
  /** `[data-x]` and `[datetime]` (names only), `method=`, `action=`, `rel=`, `type=`, `name=`. */
  attrs: string[];
  /** Length of the node's own text, whitespace collapsed. */
  text: number;
  /** Length of the run of same-tag, same-class siblings this node starts; the run keeps two entries. */
  repeat?: number;
  children: StructNode[];
}

export const SAMPLE_LIMITS = { maxNodes: 1500, maxDepth: 14 };

/**
 * The reduced structure of `doc` (the page's own `document` when omitted), from `body` down.
 * Self-contained: it runs inside the page with `page.evaluate(reduceStructure, SAMPLE_LIMITS)`
 * or as the string `(${reduceStructure})(limits)`, so it imports nothing, calls no helper and
 * declares no named inner function (tsx and vitest wrap those in a `__name` call the page lacks).
 *
 * Skips `script`, `style`, `noscript`, `svg`, `iframe` and `template`. Stops after
 * `limits.maxNodes` nodes and below `limits.maxDepth` (body is depth 0). Of a run of siblings with
 * the same tag and (filtered) classes it keeps two entries, the first with `repeat` set to the
 * run length.
 *
 * Usernames are read from the attributes and profile links that carry them (`data-author`,
 * `data-user-card`, `.username`, `/members/<name>`, a form posting to a profile and the like; a
 * list page such as `/members/list/` names nobody). An id, class, custom element name, data
 * attribute name, input name or rel token is dropped when one of its words, with leading and
 * trailing digits taken off (`bob123`, `42bob`), is such a name, when it contains a name of 5 or
 * more letters, or when it holds a long hex or mixed letter-and-digit run (a token). Ids and
 * classes are cut to 40 characters. A form action keeps only its path, and of the path only
 * segments that are one lowercase word of at most 20 letters (not a word of the page title or a
 * username) or a pair of words from a fixed list (`add-reply`); every other segment becomes `*`,
 * so slugs and ids never show (`/threads/*` + `/add-reply`).
 *
 * The username filter is a heuristic: a name that stands only in a class or id, with no carrier
 * attribute, profile link or `.username` element on the page, is not recognised, and neither is a
 * name glued to a word (`userbob`) unless it has 5 or more letters.
 */
export function reduceStructure(limits: { maxNodes: number; maxDepth: number }, doc?: Document): StructNode {
  const d: Document = doc ?? document;
  const maxNodes = Math.max(1, Math.min(5000, Math.floor(Number(limits?.maxNodes)) || 1));
  const maxDepth = Math.max(0, Math.min(64, Math.floor(Number(limits?.maxDepth)) || 0));
  const SKIP = ['script', 'style', 'noscript', 'svg', 'iframe', 'template'];
  const MAX_TOKEN = 40;
  const INPUT_TYPES = ['button', 'checkbox', 'color', 'date', 'datetime-local', 'email', 'file', 'hidden', 'image', 'month', 'number', 'password', 'radio', 'range', 'reset', 'search', 'submit', 'tel', 'text', 'time', 'url', 'week'];
  const ACTION_WORDS = ['add', 'reply', 'search', 'login', 'post', 'vote', 'watch', 'preview'];
  const PROFILE = /\/(?:members?|u|users?|profiles?|people|memberlist\.php)(?:\/|\?[^#]*?\bu(?:sername)?=)([^/?#&]+)/i;
  // What follows /members/ on a page that lists people instead of showing one.
  const NOT_PROFILE = /^(?:list|index|index\.php|online|search|find|directory|all|new|top|staff|page-?\d*|\d+)$/i;

  // Names of the page's users: values of the attributes that carry them, profile paths and the
  // text of profile links. They are only compared with; they never leave the page.
  const names = new Set<string>();
  const rawNames: string[] = [];
  const carriers = d.querySelectorAll('[data-author],[data-user-card],[data-username],[data-user],[data-member],.username,a[href],form[action]');
  const seen = Math.min(carriers.length, 20000);
  for (let i = 0; i < seen; i++) {
    const el = carriers[i]!;
    for (const attr of ['data-author', 'data-user-card', 'data-username', 'data-user', 'data-member']) {
      const v = el.getAttribute(attr);
      if (v !== null) rawNames.push(v);
    }
    const tagName = el.localName.toLowerCase();
    const target = tagName === 'a' ? el.getAttribute('href') : tagName === 'form' ? el.getAttribute('action') : null;
    let profile = target === null ? null : PROFILE.exec(target);
    if (profile !== null && NOT_PROFILE.test(profile[1]!)) profile = null;
    if (profile !== null) {
      let seg = profile[1]!;
      try {
        seg = decodeURIComponent(seg);
      } catch {
        // Kept as written.
      }
      rawNames.push(seg, seg.replace(/^\d+[-.]|[-.]\d+$/g, ''));
    }
    const isUsername = (el.getAttribute('class') ?? '').split(/\s+/).includes('username');
    if ((profile !== null && tagName === 'a') || isUsername) rawNames.push((el.textContent ?? '').slice(0, 100));
  }
  for (const raw of rawNames) {
    const lower = raw.trim().toLowerCase();
    if (lower === '' || lower.length > 100) continue;
    const joined = lower.replace(/[^\p{L}\p{N}]+/gu, '');
    if (joined.length >= 2) names.add(joined);
    const bare = joined.replace(/^\d+|\d+$/g, '');
    if (bare.length >= 2) names.add(bare);
    for (const w of lower.split(/[^\p{L}\p{N}]+/u)) {
      const core = w.replace(/^\d+|\d+$/g, '');
      if (w.length >= 3 && !/^\d+$/.test(w)) names.add(w);
      if (core.length >= 3) names.add(core);
    }
  }
  const longNames = [...names].filter((n) => n.length >= 5);
  // Words of the page title and headings: a one-word slug in a form action must not show them.
  const titleWords = new Set<string>();
  const headings = [d.title ?? '', ...Array.from(d.querySelectorAll('h1')).slice(0, 20).map((h) => h.textContent ?? '')];
  for (const h of headings) for (const w of h.toLowerCase().split(/[^a-z]+/)) if (w.length >= 3 && !ACTION_WORDS.includes(w)) titleWords.add(w);

  const root = d.body ?? d.documentElement;
  if (root === null) return { tag: 'body', classes: [], attrs: [], text: 0, children: [] };

  // Nodes are built when their parent is expanded (so runs compare filtered classes) and
  // emitted, counted and attached in document order as they leave the stack.
  const holder: StructNode = { tag: 'body', classes: [], attrs: [], text: 0, children: [] };
  const stack: [Element, number, StructNode, StructNode][] = [];
  let expand: Element[] | null = [root];
  let expandDepth = 0;
  let expandParent = holder;
  let count = 0;
  for (;;) {
    if (expand !== null) {
      const built: [Element, StructNode][] = [];
      for (const el of expand) {
        const tag = el.localName.toLowerCase();
        if (SKIP.includes(tag)) continue;
        const node: StructNode = { tag, classes: [], attrs: [], text: 0, children: [] };

        // Every name-like value of the element goes through one filter: [kind, value].
        const candidates: [string, string][] = [];
        if (!/^[a-z][a-z0-9]{0,31}$/.test(tag)) candidates.push(['tag', tag]);
        const id = el.getAttribute('id');
        if (id !== null && id.trim() !== '') candidates.push(['id', id.trim()]);
        for (const c of (el.getAttribute('class') ?? '').split(/\s+/)) if (c !== '') candidates.push(['class', c]);
        const special: string[] = [];
        if (tag === 'form') {
          const method = (el.getAttribute('method') ?? '').trim().toLowerCase();
          if (method === 'get' || method === 'post' || method === 'dialog') special.push(`method=${method}`);
          const action = (el.getAttribute('action') ?? '').trim();
          if (action !== '') {
            let pathname = '';
            try {
              pathname = new URL(action, 'http://sample.invalid/').pathname;
            } catch {
              pathname = '';
            }
            if (pathname !== '') candidates.push(['action', pathname]);
          }
        }
        if (tag === 'a' || tag === 'link') {
          for (const r of (el.getAttribute('rel') ?? '').toLowerCase().split(/\s+/).slice(0, 5)) if (r !== '') candidates.push(['rel', r]);
        }
        if (tag === 'input') {
          const type = (el.getAttribute('type') ?? '').trim().toLowerCase();
          if (INPUT_TYPES.includes(type)) special.push(`type=${type}`);
          const name = el.getAttribute('name');
          if (name !== null && name !== '') candidates.push(['name', name]);
        }
        if (el.hasAttribute('datetime')) candidates.push(['datetime', 'datetime']);
        const attrNames = el.getAttributeNames();
        for (let i = 0; i < attrNames.length && i < 200; i++) {
          const a = attrNames[i]!.toLowerCase();
          if (a.startsWith('data-') && a.length > 5) candidates.push(['data', a.slice(5)]);
        }

        let action: string[] | null = null;
        const rels: string[] = [];
        const dataAttrs: string[] = [];
        let datetime = false;
        let inputName: string | null = null;
        for (const [kind, value] of candidates) {
          // An action path is checked one segment at a time; a refused segment becomes "*".
          const parts = kind === 'action' ? value.split('/').slice(0, 20) : [value];
          const kept: string[] = [];
          for (const part of parts) {
            let ok = part.length <= 200;
            if (ok && kind === 'action')
              ok =
                part === '' ||
                ACTION_WORDS.includes(part) ||
                (/^[a-z]{1,20}$/.test(part) && !titleWords.has(part)) ||
                (/^[a-z]+-[a-z]+$/.test(part) && part.split('-').every((w) => ACTION_WORDS.includes(w)));
            else if (ok && kind === 'name') ok = /^[A-Za-z0-9_[\]-]+$/.test(part);
            else if (ok && kind === 'rel') ok = /^[a-z][a-z-]{0,23}$/.test(part);
            else if (ok && kind === 'tag') ok = /^[a-z][a-z0-9-]{0,31}$/.test(part);
            else if (ok) ok = /^[A-Za-z0-9_-]+$/.test(part);
            if (ok && /[0-9a-f]{16,}/i.test(part)) ok = false;
            if (ok) {
              for (const chunk of part.split(/[-_.[\]]+/)) {
                if (chunk.length >= 32 || (chunk.length >= 16 && /\d/.test(chunk) && /[A-Za-z]/.test(chunk))) ok = false;
              }
            }
            if (ok && part !== '') {
              const lower = part.toLowerCase();
              const joined = lower.replace(/[^a-z0-9]+/g, '');
              for (const w of lower.split(/[^a-z0-9]+/)) {
                if (w === '') continue;
                const core = w.replace(/^\d+|\d+$/g, '');
                if (names.has(w) || (core.length >= 2 && names.has(core))) ok = false;
              }
              if (names.has(joined) || names.has(joined.replace(/^\d+|\d+$/g, ''))) ok = false;
              for (const n of longNames) if (joined.includes(n)) ok = false;
            }
            if (kind === 'action') kept.push(ok ? part : '*');
            else if (ok) kept.push(part);
          }
          if (kind === 'action') action = kept;
          else if (kind === 'tag') node.tag = kept.length > 0 ? kept[0]! : '?';
          else if (kept.length === 0) continue;
          else if (kind === 'id') node.id = kept[0]!.slice(0, MAX_TOKEN);
          else if (kind === 'class') node.classes.push(kept[0]!.slice(0, MAX_TOKEN));
          else if (kind === 'name') inputName = kept[0]!.slice(0, MAX_TOKEN);
          else if (kind === 'rel') rels.push(kept[0]!);
          else if (kind === 'datetime') datetime = true;
          else if (kind === 'data') dataAttrs.push(`[data-${kept[0]!.slice(0, MAX_TOKEN)}]`);
        }
        if (action !== null) special.push(`action=${action.join('/').slice(0, 200)}`);
        if (rels.length > 0) special.push(`rel=${rels.join(',')}`);
        if (inputName !== null) special.push(`name=${inputName}`);
        node.classes = node.classes.slice(0, 20);
        node.attrs = [...special, ...(datetime ? ['[datetime]'] : []), ...dataAttrs.slice(0, 20)];

        // The element's own text nodes joined, whitespace collapsed and trimmed: only its length leaves.
        let own = '';
        for (const child of Array.from(el.childNodes)) if (child.nodeType === 3) own += child.nodeValue ?? '';
        node.text = own.replace(/\s+/g, ' ').trim().length;
        built.push([el, node]);
      }

      const sigs = built.map(([, n]) => `${n.tag} ${n.classes.join(' ')}`);
      const next: [Element, number, StructNode, StructNode][] = [];
      let i = 0;
      while (i < built.length) {
        let j = i + 1;
        while (j < built.length && sigs[j] === sigs[i]) j++;
        if (j - i >= 2) built[i]![1].repeat = j - i;
        next.push([built[i]![0], expandDepth, built[i]![1], expandParent]);
        if (j - i >= 2) next.push([built[i + 1]![0], expandDepth, built[i + 1]![1], expandParent]);
        i = j;
      }
      for (let k = next.length - 1; k >= 0; k--) stack.push(next[k]!);
      expand = null;
    }
    if (stack.length === 0 || count >= maxNodes) break;
    const [el, depth, node, parent] = stack.pop()!;
    count++;
    parent.children.push(node);
    if (depth < maxDepth) {
      expand = Array.from(el.children);
      expandDepth = depth + 1;
      expandParent = node;
    }
  }
  return holder.children[0] ?? { tag: 'body', classes: [], attrs: [], text: 0, children: [] };
}

const TAG = /^[a-z][a-z0-9-]{0,31}$/;
const NAME = /^[A-Za-z0-9_-]{1,40}$/;
const ATTR =
  /^(?:\[data-[A-Za-z0-9_-]{1,40}\]|\[datetime\]|method=(?:get|post|dialog)|action=[A-Za-z0-9_.~*/-]{0,200}|rel=[a-z,-]{1,130}|type=[a-z-]{1,20}|name=[A-Za-z0-9_[\]-]{1,40})$/;
const MAX_LINES = 5000;
const MAX_FORMAT_DEPTH = 64;

/**
 * One line per node, two spaces per depth: `article#post-7.message.message--post [data-author] text=0 x20`.
 * Prints only well-formed names: a tree that comes back from a page (whose scripts could have
 * tampered with the walk) cannot slip text into the outline. At most 5000 lines.
 */
export function formatStructure(node: StructNode): string {
  const lines: string[] = [];
  const stack: [unknown, number][] = [[node, 0]];
  while (stack.length > 0 && lines.length < MAX_LINES) {
    const [raw, depth] = stack.pop()!;
    if (typeof raw !== 'object' || raw === null) continue;
    const n = raw as Partial<Record<keyof StructNode, unknown>>;
    let label = typeof n.tag === 'string' && TAG.test(n.tag) ? n.tag : '?';
    if (typeof n.id === 'string' && NAME.test(n.id)) label += `#${n.id}`;
    if (Array.isArray(n.classes)) for (const c of n.classes.slice(0, 20)) if (typeof c === 'string' && NAME.test(c)) label += `.${c}`;
    const attrs = Array.isArray(n.attrs) ? n.attrs.slice(0, 40).filter((a): a is string => typeof a === 'string' && ATTR.test(a)) : [];
    const text = typeof n.text === 'number' && Number.isSafeInteger(n.text) && n.text >= 0 ? n.text : 0;
    const repeat = typeof n.repeat === 'number' && Number.isSafeInteger(n.repeat) && n.repeat >= 2 ? ` x${n.repeat}` : '';
    lines.push(`${'  '.repeat(depth)}${[label, ...attrs].join(' ')} text=${text}${repeat}`);
    if (depth >= MAX_FORMAT_DEPTH || !Array.isArray(n.children)) continue;
    for (let k = n.children.length - 1; k >= 0; k--) stack.push([n.children[k], depth + 1]);
  }
  return lines.join('\n');
}
