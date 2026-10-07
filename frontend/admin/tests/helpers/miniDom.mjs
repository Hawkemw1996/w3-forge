// =============================================================================
// W3 Core v0.12.10 — tests/helpers/miniDom.mjs
// =============================================================================
//
// A deliberately small, dependency-free DOM implementation that is sufficient
// for `react-dom/client` (React 18) to mount real components, run effects,
// commit DOM mutations and dispatch user events (click / input / submit) inside
// Node's built-in test runner.
//
// Why not jsdom / happy-dom / @testing-library?
//   Adding dependencies is a restricted-category change in this repository.
//   This shim lets the Command Center ship *rendered-component* regression
//   tests (real React rendering, real event dispatch) with zero new packages.
//   It is intentionally minimal: only the surface React DOM and the components
//   under test actually touch is implemented. It is not a browser.
//
// Public API:
//   installMiniDom()  -> installs window/document globals, returns { window, document, uninstall }
//   textOf(node)      -> concatenated text content of a subtree
//   query(root, sel)  -> minimal selector support: tag, #id, [data-testid="…"], [attr="…"], .class
//   queryAll(root, sel)
//   fire(node, type, init) -> dispatch a bubbling DOM event
//
// =============================================================================

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const COMMENT_NODE = 8;
const DOCUMENT_NODE = 9;
const DOCUMENT_FRAGMENT_NODE = 11;

const HTML_NS = 'http://www.w3.org/1999/xhtml';

class MiniEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = !!init.bubbles;
    this.cancelable = !!init.cancelable;
    this.composed = !!init.composed;
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this.eventPhase = 0;
    this.timeStamp = Date.now();
    this.isTrusted = false;
    this._stopped = false;
    this._stoppedImmediate = false;
    for (const [k, v] of Object.entries(init)) {
      if (!(k in this)) this[k] = v;
    }
  }
  initEvent(type, bubbles = false, cancelable = false) {
    this.type = type;
    this.bubbles = !!bubbles;
    this.cancelable = !!cancelable;
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() { this._stopped = true; }
  stopImmediatePropagation() { this._stopped = true; this._stoppedImmediate = true; }
}

function reportListenerError(target, err) {
  const win = target instanceof MiniWindow
    ? target
    : (target.nodeType === DOCUMENT_NODE ? target.defaultView : (target.ownerDocument ? target.ownerDocument.defaultView : null));
  if (win) {
    const errorEvent = new MiniEvent('error', { cancelable: true });
    errorEvent.error = err;
    errorEvent.message = err && err.message ? err.message : String(err);
    const handled = win._listeners.has('error|b') && win._listeners.get('error|b').length > 0;
    if (handled) {
      win._invoke(errorEvent, false);
      return;
    }
  }
  throw err;
}

class MiniEventTarget {
  constructor() { this._listeners = new Map(); }
  addEventListener(type, listener, options) {
    if (typeof listener !== 'function' && !(listener && typeof listener.handleEvent === 'function')) return;
    const capture = typeof options === 'boolean' ? options : !!(options && options.capture);
    const key = `${type}|${capture ? 'c' : 'b'}`;
    if (!this._listeners.has(key)) this._listeners.set(key, []);
    const list = this._listeners.get(key);
    if (!list.some((l) => l.listener === listener)) list.push({ listener, once: !!(options && options.once) });
  }
  removeEventListener(type, listener, options) {
    const capture = typeof options === 'boolean' ? options : !!(options && options.capture);
    const key = `${type}|${capture ? 'c' : 'b'}`;
    const list = this._listeners.get(key);
    if (!list) return;
    const idx = list.findIndex((l) => l.listener === listener);
    if (idx >= 0) list.splice(idx, 1);
  }
  _invoke(event, capture) {
    const key = `${event.type}|${capture ? 'c' : 'b'}`;
    const list = this._listeners.get(key);
    if (!list || list.length === 0) return;
    for (const entry of [...list]) {
      if (event._stoppedImmediate) break;
      event.currentTarget = this;
      if (entry.once) this.removeEventListener(event.type, entry.listener, capture);
      try {
        if (typeof entry.listener === 'function') entry.listener.call(this, event);
        else entry.listener.handleEvent(event);
      } catch (err) {
        // Browsers report listener exceptions to window.onerror / the window
        // 'error' event and continue dispatch. React's development-mode
        // invokeGuardedCallback relies on exactly this behaviour to route render
        // errors to error boundaries, so mirror it here.
        reportListenerError(this, err);
      }
    }
  }
  dispatchEvent(event) {
    event.target = this;
    const path = [];
    let n = this.parentNode;
    while (n) { path.push(n); n = n.parentNode; }
    // Window sits at the end of the propagation path for document events.
    const doc = this.nodeType === DOCUMENT_NODE ? this : this.ownerDocument;
    if (doc && doc.defaultView && !path.includes(doc.defaultView)) path.push(doc.defaultView);
    // Capture phase (root → target).
    event.eventPhase = 1;
    for (let i = path.length - 1; i >= 0; i--) {
      if (event._stopped) break;
      path[i]._invoke(event, true);
    }
    // At target.
    if (!event._stopped) {
      event.eventPhase = 2;
      this._invoke(event, true);
      if (!event._stoppedImmediate) this._invoke(event, false);
    }
    // Bubble phase (target → root).
    if (event.bubbles) {
      event.eventPhase = 3;
      for (const node of path) {
        if (event._stopped) break;
        node._invoke(event, false);
      }
    }
    event.currentTarget = null;
    return !event.defaultPrevented;
  }
}

class MiniNode extends MiniEventTarget {
  constructor(nodeType, ownerDocument) {
    super();
    this.nodeType = nodeType;
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
  }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[i + 1] ?? null;
  }
  get previousSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[i - 1] ?? null;
  }
  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === ELEMENT_NODE ? this.parentNode : null;
  }
  get isConnected() {
    let n = this;
    while (n) { if (n.nodeType === DOCUMENT_NODE) return true; n = n.parentNode; }
    return false;
  }
  appendChild(child) { return this.insertBefore(child, null); }
  insertBefore(child, ref) {
    if (child.nodeType === DOCUMENT_FRAGMENT_NODE) {
      for (const c of [...child.childNodes]) this.insertBefore(c, ref);
      return child;
    }
    if (child.parentNode) child.parentNode.removeChild(child);
    if (ref) {
      const i = this.childNodes.indexOf(ref);
      if (i < 0) throw new Error('insertBefore: reference node is not a child');
      this.childNodes.splice(i, 0, child);
    } else {
      this.childNodes.push(child);
    }
    child.parentNode = this;
    return child;
  }
  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i < 0) throw new Error('removeChild: node is not a child');
    this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  replaceChild(newChild, oldChild) {
    this.insertBefore(newChild, oldChild);
    this.removeChild(oldChild);
    return oldChild;
  }
  contains(other) {
    let n = other;
    while (n) { if (n === this) return true; n = n.parentNode; }
    return false;
  }
  hasChildNodes() { return this.childNodes.length > 0; }
  get textContent() {
    if (this.nodeType === TEXT_NODE || this.nodeType === COMMENT_NODE) return this.nodeValue;
    let out = '';
    for (const c of this.childNodes) if (c.nodeType !== COMMENT_NODE) out += c.textContent;
    return out;
  }
  set textContent(value) {
    if (this.nodeType === TEXT_NODE || this.nodeType === COMMENT_NODE) { this.nodeValue = String(value); return; }
    for (const c of [...this.childNodes]) this.removeChild(c);
    const text = value == null ? '' : String(value);
    if (text !== '') this.appendChild(this.ownerDocument.createTextNode(text));
  }
  compareDocumentPosition(other) {
    if (this.contains(other)) return 20; // CONTAINED_BY | FOLLOWING
    if (other.contains(this)) return 10; // CONTAINS | PRECEDING
    return 1;
  }
}

class MiniText extends MiniNode {
  constructor(text, ownerDocument) {
    super(TEXT_NODE, ownerDocument);
    this.nodeValue = String(text);
    this.nodeName = '#text';
  }
  get data() { return this.nodeValue; }
  set data(v) { this.nodeValue = String(v); }
}

class MiniComment extends MiniNode {
  constructor(text, ownerDocument) {
    super(COMMENT_NODE, ownerDocument);
    this.nodeValue = String(text);
    this.nodeName = '#comment';
  }
}

class MiniStyle {
  constructor() { this._props = new Map(); }
  setProperty(name, value) { if (value === '' || value == null) this._props.delete(name); else this._props.set(name, String(value)); }
  getPropertyValue(name) { return this._props.get(name) ?? ''; }
  removeProperty(name) { this._props.delete(name); }
  get cssText() { return [...this._props].map(([k, v]) => `${k}: ${v};`).join(' '); }
}
// Regular style properties are assigned directly (style.color = 'red').
const styleProxyHandler = {
  set(target, prop, value) {
    if (typeof prop === 'string' && !(prop in target) && !prop.startsWith('_')) target.setProperty(prop, value);
    else target[prop] = value;
    return true;
  },
  get(target, prop) {
    if (prop in target) {
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    }
    return typeof prop === 'string' ? target.getPropertyValue(prop) : undefined;
  }
};

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

class MiniElement extends MiniNode {
  constructor(tagName, ownerDocument, namespaceURI = HTML_NS) {
    super(ELEMENT_NODE, ownerDocument);
    this.namespaceURI = namespaceURI;
    this.localName = tagName;
    this.tagName = namespaceURI === HTML_NS ? tagName.toUpperCase() : tagName;
    this.nodeName = this.tagName;
    this.attributes = new Map();
    this.style = new Proxy(new MiniStyle(), styleProxyHandler);
    // Form-control state (plain properties are what React DOM writes).
    this._value = '';
    this.defaultValue = '';
    this.checked = false;
    this.defaultChecked = false;
    this.selected = false;
    this.defaultSelected = false;
    this.disabled = false;
    this.multiple = false;
    this.name = '';
  }
  get value() {
    if (this.localName === 'option') {
      return this.attributes.has('value') ? this.attributes.get('value') : this.textContent;
    }
    if (this.localName === 'select') {
      const selected = this.options.find((o) => o.selected);
      return selected ? selected.value : (this.options[0] ? this.options[0].value : '');
    }
    return this._value;
  }
  set value(v) {
    if (this.localName === 'select') {
      const target = String(v);
      for (const o of this.options) o.selected = o.value === target;
      return;
    }
    this._value = v == null ? '' : String(v);
  }
  get id() { return this.getAttribute('id') ?? ''; }
  set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') ?? ''; }
  set className(v) { this.setAttribute('class', v); }
  get classList() {
    const self = this;
    return {
      contains(c) { return self.className.split(/\s+/).includes(c); },
      add(...cs) { self.className = [...new Set([...self.className.split(/\s+/).filter(Boolean), ...cs])].join(' '); },
      remove(...cs) { self.className = self.className.split(/\s+/).filter((c) => c && !cs.includes(c)).join(' '); }
    };
  }
  get children() { return this.childNodes.filter((c) => c.nodeType === ELEMENT_NODE); }
  get firstElementChild() { return this.children[0] ?? null; }
  get contentEditable() { return this.getAttribute('contenteditable') ?? 'inherit'; }
  get isContentEditable() { return this.getAttribute('contenteditable') === 'true'; }
  get options() {
    const out = [];
    const walk = (n) => { for (const c of n.children) { if (c.localName === 'option') out.push(c); else if (c.localName === 'optgroup') walk(c); } };
    walk(this);
    return out;
  }
  get selectedIndex() { return this.options.findIndex((o) => o.selected); }
  get form() { let n = this.parentNode; while (n) { if (n.localName === 'form') return n; n = n.parentNode; } return null; }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'disabled') this.disabled = true;
  }
  setAttributeNS(_ns, name, value) { this.setAttribute(name, value); }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === 'disabled') this.disabled = false;
  }
  removeAttributeNS(_ns, name) { this.removeAttribute(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  getAttributeNames() { return [...this.attributes.keys()]; }
  focus() { this.ownerDocument._activeElement = this; }
  blur() { if (this.ownerDocument._activeElement === this) this.ownerDocument._activeElement = null; }
  click() { fire(this, 'click'); }
  getBoundingClientRect() { return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  getClientRects() { return []; }
  scrollIntoView() {}
  matches(selector) { return matchesSimpleSelector(this, selector); }
  closest(selector) { let n = this; while (n && n.nodeType === ELEMENT_NODE) { if (matchesSimpleSelector(n, selector)) return n; n = n.parentNode; } return null; }
  querySelector(selector) { return query(this, selector); }
  querySelectorAll(selector) { return queryAll(this, selector); }
  get innerHTML() { return this.childNodes.map(serialize).join(''); }
  set innerHTML(html) {
    for (const c of [...this.childNodes]) this.removeChild(c);
    if (html) this.appendChild(this.ownerDocument.createTextNode(String(html)));
  }
  get outerHTML() { return serialize(this); }
  get textContentAll() { return this.textContent; }
}

function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function serialize(node) {
  if (node.nodeType === TEXT_NODE) return escapeHtml(node.nodeValue);
  if (node.nodeType === COMMENT_NODE) return `<!--${node.nodeValue}-->`;
  if (node.nodeType !== ELEMENT_NODE) return node.childNodes.map(serialize).join('');
  const attrs = [...node.attributes].map(([k, v]) => ` ${k}="${escapeHtml(v)}"`).join('');
  const css = node.style.cssText;
  const styleAttr = css ? ` style="${escapeHtml(css)}"` : '';
  const open = `<${node.localName}${attrs}${styleAttr}>`;
  if (VOID_TAGS.has(node.localName)) return open;
  return `${open}${node.childNodes.map(serialize).join('')}</${node.localName}>`;
}

class MiniDocumentFragment extends MiniNode {
  constructor(ownerDocument) { super(DOCUMENT_FRAGMENT_NODE, ownerDocument); this.nodeName = '#document-fragment'; }
}

class MiniDocument extends MiniNode {
  constructor() {
    super(DOCUMENT_NODE, null);
    this.ownerDocument = this;
    this.nodeName = '#document';
    this.defaultView = null;
    this._activeElement = null;
    this.documentElement = new MiniElement('html', this);
    this.head = new MiniElement('head', this);
    this.body = new MiniElement('body', this);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    super.appendChild(this.documentElement);
    this.readyState = 'complete';
    this.visibilityState = 'visible';
    this.hidden = false;
    this.title = '';
    this.cookie = '';
  }
  get activeElement() { return this._activeElement && this._activeElement.isConnected ? this._activeElement : this.body; }
  createElement(tag) { return new MiniElement(String(tag).toLowerCase(), this); }
  createElementNS(ns, tag) { return new MiniElement(tag, this, ns || HTML_NS); }
  createTextNode(text) { return new MiniText(text, this); }
  createComment(text) { return new MiniComment(text, this); }
  createDocumentFragment() { return new MiniDocumentFragment(this); }
  createEvent() { return new MiniEvent('generic', { bubbles: false, cancelable: false }); }
  getElementById(id) { return query(this, `#${id}`); }
  querySelector(selector) { return query(this.documentElement, selector); }
  querySelectorAll(selector) { return queryAll(this.documentElement, selector); }
  hasFocus() { return true; }
  getSelection() { return null; }
}

class MiniWindow extends MiniEventTarget {
  constructor(document) {
    super();
    this.document = document;
    this.window = this;
    this.self = this;
    this.parent = this;
    this.top = this;
    this.event = undefined;
    this.navigator = { userAgent: 'node', language: 'en-US', onLine: true };
    this.location = { href: 'http://localhost/command-center/relationships', origin: 'http://localhost', pathname: '/command-center/relationships', search: '', hash: '', protocol: 'http:', host: 'localhost' };
    this.history = { state: null, pushState() {}, replaceState() {}, back() {}, go() {}, length: 1 };
    this.innerWidth = 1280;
    this.innerHeight = 800;
    this.devicePixelRatio = 1;
    this.HTMLIFrameElement = class HTMLIFrameElement {};
    this.HTMLElement = MiniElement;
    this.Element = MiniElement;
    this.Node = MiniNode;
    this.Text = MiniText;
    this.Event = MiniEvent;
    this.CustomEvent = MiniEvent;
    this.MouseEvent = MiniEvent;
    this.KeyboardEvent = MiniEvent;
    this.InputEvent = MiniEvent;
    this.FocusEvent = MiniEvent;
    this.getComputedStyle = () => new Proxy(new MiniStyle(), styleProxyHandler);
    this.matchMedia = () => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    this.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
    this.cancelAnimationFrame = (id) => clearTimeout(id);
    this.setTimeout = setTimeout;
    this.clearTimeout = clearTimeout;
    this.setInterval = setInterval;
    this.clearInterval = clearInterval;
    this.scrollTo = () => {};
    this.scroll = () => {};
    this.alert = () => {};
    this.confirm = () => true;
    this.localStorage = memoryStorage();
    this.sessionStorage = memoryStorage();
  }
}

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; }
  };
}

// -----------------------------------------------------------------------------
// Minimal selector support
// -----------------------------------------------------------------------------

function matchesSimpleSelector(el, selector) {
  // Supports: tag, #id, .class, [attr], [attr="value"], and combinations without descendant combinators.
  const parts = selector.trim().split(/\s*,\s*/);
  return parts.some((part) => matchesCompound(el, part));
}
function matchesCompound(el, compound) {
  const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]/g;
  let m; let any = false;
  while ((m = re.exec(compound)) !== null) {
    any = true;
    if (m[1] !== undefined && el.localName !== m[1].toLowerCase()) return false;
    if (m[2] !== undefined && el.getAttribute('id') !== m[2]) return false;
    if (m[3] !== undefined && !el.className.split(/\s+/).includes(m[3])) return false;
    if (m[4] !== undefined) {
      if (!el.hasAttribute(m[4])) return false;
      if (m[5] !== undefined && el.getAttribute(m[4]) !== m[5]) return false;
    }
  }
  return any;
}
function* walkElements(root) {
  for (const c of root.childNodes) {
    if (c.nodeType === ELEMENT_NODE) { yield c; yield* walkElements(c); }
  }
}
export function queryAll(root, selector) {
  const out = [];
  for (const el of walkElements(root)) if (matchesSimpleSelector(el, selector)) out.push(el);
  return out;
}
export function query(root, selector) {
  for (const el of walkElements(root)) if (matchesSimpleSelector(el, selector)) return el;
  return null;
}
export function byTestId(root, id) { return query(root, `[data-testid="${id}"]`); }
export function allByTestId(root, id) { return queryAll(root, `[data-testid="${id}"]`); }
export function textOf(node) { return node ? node.textContent : ''; }

export function fire(node, type, init = {}) {
  const event = new MiniEvent(type, { bubbles: true, cancelable: true, ...init });
  const win = node.ownerDocument ? node.ownerDocument.defaultView : null;
  if (win) win.event = event;
  try {
    return node.dispatchEvent(event);
  } finally {
    if (win) win.event = undefined;
  }
}

/** Set a form control's value and dispatch the `input` event React listens for. */
export function setValue(node, value) {
  node.value = value;
  fire(node, 'input');
  fire(node, 'change');
}

// -----------------------------------------------------------------------------
// Install / uninstall globals
// -----------------------------------------------------------------------------

export function installMiniDom() {
  const document = new MiniDocument();
  const window = new MiniWindow(document);
  document.defaultView = window;

  const previous = {};
  const globalsToSet = {
    window,
    document,
    navigator: window.navigator,
    HTMLElement: MiniElement,
    HTMLIFrameElement: window.HTMLIFrameElement,
    Element: MiniElement,
    Node: MiniNode,
    Text: MiniText,
    Event: MiniEvent,
    CustomEvent: MiniEvent,
    MouseEvent: MiniEvent,
    KeyboardEvent: MiniEvent,
    getComputedStyle: window.getComputedStyle,
    matchMedia: window.matchMedia,
    requestAnimationFrame: window.requestAnimationFrame,
    cancelAnimationFrame: window.cancelAnimationFrame,
    localStorage: window.localStorage,
    sessionStorage: window.sessionStorage,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  for (const [key, value] of Object.entries(globalsToSet)) {
    previous[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  // `self` is a getter on globalThis in Node; leave it alone.

  const root = document.createElement('div');
  root.setAttribute('id', 'root');
  document.body.appendChild(root);

  function uninstall() {
    for (const [key, desc] of Object.entries(previous)) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else delete globalThis[key];
    }
  }

  return { window, document, root, uninstall };
}

export const nodeTypes = { ELEMENT_NODE, TEXT_NODE, COMMENT_NODE, DOCUMENT_NODE, DOCUMENT_FRAGMENT_NODE };
