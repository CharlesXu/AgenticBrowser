// A page-scoped SDK shared by MCP and Node scripts. No browser-wide connection.
import { readConnection, SpaceClient } from './space-client.ts';
import { writeFile, mkdir, copyFile, stat, unlink } from 'node:fs/promises';
import { isAbsolute, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const expression = (fn, arg) =>
  `(${typeof fn === 'function' ? fn.toString() : fn})(${JSON.stringify(arg) ?? 'undefined'})`;
function value(result) {
  if (result.dialog) throw Error('page_dialog_opened');
  if (result.exceptionDetails)
    throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
async function save(path, bytes) {
  if (!isAbsolute(path)) throw Error('absolute_path_required');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  return path;
}

export class TaskSpace {
  constructor(client, control) {
    this.client = client;
    this.control = control;
    this.labels = new Map();
    this.nextLabel = 1;
    this.closed = false;
  }
  static async connect(file) {
    const task = new TaskSpace(new SpaceClient(await readConnection(file)));
    task.control = await task.client.request('claim');
    try {
      await task.pages();
      return task;
    } catch (error) {
      await task.client.request('release', task.control).catch(() => {});
      throw error;
    }
  }
  async observe() {
    return this.client.request('observe', this.control);
  }
  async request(action, data = {}) {
    if (this.closed) throw Error('task_finished');
    const seen = await this.observe();
    return this.client.request(action, { ...this.control, tab: seen.tab, ...data });
  }
  async pages() {
    return (await this.request('tabs')).tabs.map((tab) => this.pageFor(tab.tab));
  }
  async tabs() {
    return (await this.request('tabs')).tabs;
  }
  pageFor(tab) {
    let page = [...this.labels.values()].find((p) => p.targetId === tab);
    if (!page) {
      page = new Page(this, tab, `p${this.nextLabel++}`);
      this.labels.set(page.label, page);
    }
    return page;
  }
  page(label) {
    const page = this.labels.get(label);
    if (!page) throw Error('unknown_page_label');
    return page;
  }
  async adopt(page, { as } = {}) {
    if (page.task !== this || !(await this.tabs()).some((t) => t.tab === page.targetId))
      throw Error('page_not_in_space');
    if (as) {
      if (this.labels.has(as) && this.labels.get(as) !== page) throw Error('label_in_use');
      this.labels.delete(page.label);
      page.label = as;
      this.labels.set(as, page);
    }
    return page;
  }
  release(label) {
    const page = this.page(label);
    this.labels.delete(label);
    return page;
  }
  async userPage() {
    return this.pageFor((await this.observe()).tab);
  }
  async newPage() {
    await this.request('newTab');
    return this.userPage();
  }
  async handOff() {
    return this.client.request('handOff', this.control);
  }
  async resume() {
    this.control = await this.client.request('resume', { lease: this.control.lease });
    for (const page of this.labels.values()) {
      page.refs.clear();
      page.modifiers = 0;
      page.buttons = 0;
    }
    return this.observe();
  }
  async waitForControl({ timeout = 30000 } = {}) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if ((await this.observe()).owner === 'awaiting-resume') return this.resume();
      await delay(100);
    }
    throw Error('control_wait_timeout');
  }
  async finish({ keep = 'all' } = {}) {
    if (this.closed) throw Error('task_finished');
    if (keep !== 'all') {
      if (!Array.isArray(keep)) throw Error('invalid_keep');
      for (const page of [...this.labels.values()])
        if (!keep.includes(page.label) && (await this.tabs()).some((t) => t.tab === page.targetId))
          await page.close();
    }
    await this.client.request('release', this.control);
    this.closed = true;
  }
}

// Runs inside an isolated world. A selector must resolve to one element.
function locate({ selector, visible = true }) {
  const roots = [document];
  for (let i = 0; i < roots.length; i++)
    for (const el of roots[i].querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot);
  const norm = (s) =>
    String(s ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  const shown = (e) => {
    const r = e.getBoundingClientRect(),
      s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const name = (e) =>
    norm(
      e.getAttribute('aria-label') ||
        [...(e.labels || [])].map((l) => l.textContent).join(' ') ||
        e.innerText ||
        e.value ||
        e.getAttribute('alt'),
    );
  let matches = [],
    nth,
    sel = selector;
  const tail = sel.match(/\s*>>\s*nth=(-?\d+)$/);
  if (tail) {
    nth = Number(tail[1]);
    sel = sel.slice(0, tail.index);
  }
  if (sel.startsWith('xpath=')) {
    const result = document.evaluate(
      sel.slice(6),
      document,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null,
    );
    for (let i = 0; i < result.snapshotLength; i++) matches.push(result.snapshotItem(i));
  } else if (sel.startsWith('text=')) {
    const text = sel.slice(5),
      exact = /^(["']).*\1$/.test(text),
      wanted = norm(exact ? text.slice(1, -1) : text);
    const test = (e) =>
      exact
        ? norm(e.textContent) === wanted
        : norm(e.textContent).toLowerCase().includes(wanted.toLowerCase());
    matches = roots
      .flatMap((r) => [...r.querySelectorAll('*')])
      .filter((e) => test(e) && ![...e.children].some(test));
  } else if (sel.startsWith('loc=role:')) {
    const m = sel.slice(9).match(/^([\w-]+)(?:\[name(\*?=)["'](.*)["']\])?$/);
    if (!m) throw Error('unsupported_role_selector');
    const implicit = (e) =>
      ({
        BUTTON: 'button',
        A: e.hasAttribute('href') ? 'link' : '',
        TEXTAREA: 'textbox',
        SELECT: e.multiple ? 'listbox' : 'combobox',
        INPUT: ['button', 'submit', 'reset'].includes(e.type)
          ? 'button'
          : e.type === 'checkbox'
            ? 'checkbox'
            : e.type === 'radio'
              ? 'radio'
              : 'textbox',
        IMG: 'img',
      })[e.tagName] || '';
    matches = roots
      .flatMap((r) => [...r.querySelectorAll('*')])
      .filter(
        (e) =>
          (e.getAttribute('role') || implicit(e)) === m[1] &&
          (!m[2] || (m[2] === '*=' ? name(e).includes(m[3]) : name(e) === m[3])),
      );
  } else if (sel.startsWith('loc=href:')) {
    const href = sel.slice(9);
    matches = roots
      .flatMap((r) => [...r.querySelectorAll('a[href]')])
      .filter((e) => e.getAttribute('href') === href || e.href === href);
  } else {
    sel = sel.replace(/^(?:loc=css:|css=)/, '');
    let filter;
    const text = sel.match(/:(has-text|text-is)\(["'](.*)["']\)$/);
    if (text) {
      sel = sel.slice(0, text.index) || '*';
      filter = (e) =>
        text[1] === 'text-is'
          ? norm(e.textContent) === text[2]
          : norm(e.textContent).toLowerCase().includes(text[2].toLowerCase());
    }
    matches = roots
      .flatMap((r) => [...r.querySelectorAll(sel)])
      .filter((e) => !filter || filter(e));
  }
  matches = [...new Set(matches)].filter((e) => e instanceof Element && (!visible || shown(e)));
  if (nth !== undefined) matches = matches.length ? [matches.at(nth)].filter(Boolean) : [];
  if (matches.length > 1) throw Error('ambiguous_selector');
  return matches[0] || null;
}

export class Page {
  constructor(task, tab, label) {
    this.task = task;
    this.targetId = tab;
    this.label = label;
    this.refs = new Map();
    this.eventBuffer = [];
    this.mousePosition = { x: 0, y: 0 };
    this.buttons = 0;
    this.modifiers = 0;
    this.mouse = {
      move: (x, y) => this.mouseEvent('mouseMoved', x, y),
      click: (x, y, o = {}) => this.mouseClick(x, y, o),
      down: (o = {}) =>
        this.mouseEvent('mousePressed', this.mousePosition.x, this.mousePosition.y, o),
      up: (o = {}) =>
        this.mouseEvent('mouseReleased', this.mousePosition.x, this.mousePosition.y, o),
      wheel: (dx, dy) =>
        this.mouseEvent('mouseWheel', this.mousePosition.x, this.mousePosition.y, {
          deltaX: dx,
          deltaY: dy,
        }),
    };
    this.keyboard = {
      down: (key) => this.key(key, true),
      up: (key) => this.key(key, false),
      press: (key) => this.pressKeys(key),
      type: async (text) => {
        for (const char of text) {
          if (char.codePointAt(0) > 127) await this.insertText(char);
          else {
            await this.key(char, true);
            await this.key(char, false);
          }
        }
      },
      insertText: (text) => this.insertText(text),
      paste: (data) => this.paste(data),
    };
  }
  async selected() {
    const seen = await this.task.observe();
    if (seen.tab !== this.targetId)
      await this.task.request('selectTab', { targetTab: this.targetId });
    return { ...this.task.control, tab: this.targetId };
  }
  async request(action, data = {}) {
    return this.task.client.request(action, { ...(await this.selected()), ...data });
  }
  async protocol(method, params = {}, session = '') {
    const r = await this.request('protocol', { method, params, session });
    if (r.error) throw Error(`cdp: ${r.error.message}`);
    return r.result || {};
  }
  async cdp(method, params = {}, options = {}) {
    this.refs.clear();
    return this.protocol(method, params, options.session || '');
  }
  async evaluate(fn, arg) {
    const r = await this.protocol('Runtime.evaluate', {
      expression: typeof fn === 'string' ? fn : expression(fn, arg),
      returnByValue: true,
      awaitPromise: true,
      timeout: 3000,
    });
    return value(r);
  }
  async call(object, fn, arg) {
    return this.protocol(
      'Runtime.callFunctionOn',
      {
        objectId: object.objectId,
        functionDeclaration: fn.toString(),
        arguments: [{ value: arg }],
        returnByValue: true,
        awaitPromise: true,
      },
      object.session,
    );
  }
  async info() {
    const tab = (await this.task.tabs()).find((t) => t.tab === this.targetId);
    if (!tab) throw Error('page_closed');
    await this.collectEvents();
    return { ...tab, label: this.label, dialog: this.dialogState };
  }
  async url() {
    return (await this.info()).url;
  }
  async title() {
    return (await this.info()).title;
  }
  async goto(url) {
    if (!/^https?:\/\//i.test(url)) throw Error('http_url_required');
    this.refs.clear();
    const current = (await this.task.tabs()).find((t) => t.tab === this.targetId);
    const before = current?.url
      ? (await this.protocol('Page.getFrameTree')).frameTree.frame.loaderId
      : '';
    await this.request('navigate', { url });
    await this.wait(async () => {
      const frame = (await this.protocol('Page.getFrameTree')).frameTree.frame;
      return frame.loaderId !== before;
    });
    return this.waitForLoadState();
  }
  async reload() {
    this.refs.clear();
    const before = (await this.protocol('Page.getFrameTree')).frameTree.frame.loaderId;
    await this.protocol('Page.reload');
    await this.wait(
      async () => (await this.protocol('Page.getFrameTree')).frameTree.frame.loaderId !== before,
    );
    return this.waitForLoadState();
  }
  async close() {
    await this.task.request('closeTab', { targetTab: this.targetId });
  }
  async collectEvents() {
    const batch = await this.request('events');
    this.sessions = batch.sessions;
    for (const event of batch.events) {
      if (event.method === 'Page.javascriptDialogOpening') this.dialogState = event.params;
      if (event.method === 'Page.javascriptDialogClosed') this.dialogState = undefined;
    }
    this.eventBuffer.push(...batch.events);
    this.eventBuffer = this.eventBuffer.slice(-256);
    return batch;
  }
  async events() {
    await this.collectEvents();
    return this.eventBuffer.splice(0);
  }
  async frames() {
    await this.collectEvents();
    const frames = [],
      seen = new Set(),
      childIds = new Set(Object.values(this.sessions).map((s) => s.targetId));
    for (const session of ['', ...Object.keys(this.sessions)]) {
      const tree = (await this.protocol('Page.getFrameTree', {}, session)).frameTree;
      const walk = (node) => {
        if (!node || seen.has(node.frame.id) || (!session && childIds.has(node.frame.id))) return;
        seen.add(node.frame.id);
        frames.push({
          session,
          id: node.frame.id,
          url: node.frame.url,
          parentId: node.frame.parentId,
        });
        for (const child of node.childFrames || []) walk(child);
      };
      walk(tree);
    }
    return frames;
  }
  async find(selector, { visible = true, optional = false } = {}) {
    if (selector.startsWith('@')) {
      const ref = this.refs.get(selector);
      if (!ref) throw Error('stale_reference');
      const check = await this.protocol(
        'Runtime.callFunctionOn',
        {
          objectId: ref.documentObject,
          functionDeclaration: 'function(){return this===document;}',
          returnByValue: true,
        },
        ref.session,
      );
      if (check.exceptionDetails || check.result?.value !== true) throw Error('stale_reference');
      const result = await this.protocol(
        'DOM.resolveNode',
        { backendNodeId: ref.backend, executionContextId: ref.context },
        ref.session,
      );
      if (!result.object?.objectId) throw Error('stale_reference');
      return { ...ref, objectId: result.object.objectId };
    }
    for (const frame of await this.frames()) {
      const { executionContextId: context } = await this.protocol(
        'Page.createIsolatedWorld',
        { frameId: frame.id, worldName: 'agentic-page' },
        frame.session,
      );
      const r = await this.protocol(
        'Runtime.evaluate',
        { expression: expression(locate, { selector, visible }), contextId: context },
        frame.session,
      );
      if (r.exceptionDetails)
        throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      if (r.result?.objectId) return { ...frame, context, objectId: r.result.objectId };
    }
    if (!optional) throw Error('element_not_found');
    return null;
  }
  async snapshot() {
    this.refs.clear();
    const nodes = [],
      nonce = randomUUID().slice(0, 8);
    let index = 0,
      truncated = false;
    const frames = await this.frames();
    for (const frame of frames) {
      const context = (
        await this.protocol(
          'Page.createIsolatedWorld',
          { frameId: frame.id, worldName: 'agentic-page' },
          frame.session,
        )
      ).executionContextId;
      const documentObject = (
        await this.protocol(
          'Runtime.evaluate',
          { expression: 'document', contextId: context },
          frame.session,
        )
      ).result.objectId;
      const tree = await this.protocol(
        'Accessibility.getFullAXTree',
        { frameId: frame.id },
        frame.session,
      );
      for (const node of tree.nodes || []) {
        if (node.ignored) continue;
        if (nodes.length >= 1000) {
          truncated = true;
          break;
        }
        let ref;
        if (node.backendDOMNodeId) {
          ref = `@${nonce}-${++index}`;
          this.refs.set(ref, { ...frame, backend: node.backendDOMNodeId, context, documentObject });
        }
        nodes.push({
          ref,
          frame: frame.id,
          role: node.role?.value,
          name: node.name?.value,
          value: node.value?.value,
          properties: node.properties,
        });
      }
    }
    return { nodes, truncated, scope: 'all frames; accessibility tree' };
  }
  async point(target) {
    await this.protocol(
      'DOM.scrollIntoViewIfNeeded',
      { objectId: target.objectId },
      target.session,
    );
    const quads = (
      await this.protocol('DOM.getContentQuads', { objectId: target.objectId }, target.session)
    ).quads;
    const q = quads?.[0];
    if (!q) throw Error('element_not_visible');
    let x = (q[0] + q[2] + q[4] + q[6]) / 4,
      y = (q[1] + q[3] + q[5] + q[7]) / 4;
    let session = target.session;
    const visited = new Set();
    while (session) {
      if (visited.has(session)) throw Error('invalid_frame_chain');
      visited.add(session);
      const id = this.sessions[session]?.targetId;
      let found = false;
      for (const parent of ['', ...Object.keys(this.sessions)]) {
        if (parent === session) continue;
        let owner;
        try {
          owner = await this.protocol('DOM.getFrameOwner', { frameId: id }, parent);
        } catch {
          continue;
        }
        const box = (
          await this.protocol('DOM.getBoxModel', { backendNodeId: owner.backendNodeId }, parent)
        ).model;
        if (!box) continue;
        x += box.content[0];
        y += box.content[1];
        session = parent;
        found = true;
        break;
      }
      if (!found) throw Error('frame_offset_unavailable');
    }
    return { x, y };
  }
  async actionable(selector) {
    const target = await this.find(selector);
    const ok = value(
      await this.call(target, function () {
        if (!this.isConnected || this.disabled) return false;
        this.scrollIntoView({ block: 'center', inline: 'center' });
        const r = this.getBoundingClientRect(),
          e = this.getRootNode().elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return !!e && (e === this || this.contains(e));
      }),
    );
    if (!ok) throw Error('element_not_actionable');
    return target;
  }
  async click(selector, options = {}) {
    const target = await this.actionable(selector),
      p = await this.point(target);
    await this.mouseClick(p.x, p.y, options);
    return { dispatched: true };
  }
  async dblclick(selector) {
    return this.click(selector, { clickCount: 2 });
  }
  async hover(selector) {
    const p = await this.point(await this.actionable(selector));
    return this.mouse.move(p.x, p.y);
  }
  async dragAndDrop(source, destination) {
    const a = await this.point(await this.actionable(source)),
      b = await this.point(await this.actionable(destination));
    await this.mouse.move(a.x, a.y);
    await this.mouse.down();
    try {
      for (let i = 1; i <= 8; i++)
        await this.mouse.move(a.x + ((b.x - a.x) * i) / 8, a.y + ((b.y - a.y) * i) / 8);
    } finally {
      await this.mouse.up();
    }
  }
  async focus(selector) {
    const target = await this.find(selector);
    const ok = value(
      await this.call(target, function () {
        this.focus();
        return this.getRootNode().activeElement === this;
      }),
    );
    if (!ok) throw Error('focus_failed');
  }
  async fill(selector, text) {
    const target = await this.find(selector);
    const ok = value(
      await this.call(target, function () {
        if (!this.isConnected || this.disabled || this.readOnly) return false;
        this.scrollIntoView({ block: 'center' });
        this.focus();
        if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) {
          try {
            this.select();
          } catch {
            return false;
          }
        } else if (this.isContentEditable) {
          const range = document.createRange();
          range.selectNodeContents(this);
          const selection = getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        } else return false;
        return this.getRootNode().activeElement === this;
      }),
    );
    if (!ok) throw Error('element_not_editable');
    await this.insertText(text);
    return { dispatched: true };
  }
  async selectOption(selector, options) {
    const target = await this.find(selector);
    return value(
      await this.call(
        target,
        function (options) {
          if (!(this instanceof HTMLSelectElement) || this.disabled)
            throw Error('element_not_select');
          const wanted = options == null ? [] : Array.isArray(options) ? options : [options];
          if (!this.multiple && wanted.length > 1) throw Error('select_not_multiple');
          const matches = wanted.map((w) =>
            [...this.options].find((o, i) =>
              typeof w === 'string'
                ? o.value === w || o.label === w
                : w.value !== undefined
                  ? o.value === w.value
                  : w.label !== undefined
                    ? o.label === w.label
                    : i === w.index,
            ),
          );
          if (matches.some((o) => !o || o.disabled)) throw Error('option_not_found');
          for (const o of this.options) o.selected = matches.includes(o);
          if (!matches.length) this.selectedIndex = -1;
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
          return matches.map((o) => o.value);
        },
        options,
      ),
    );
  }
  async press(selector, key) {
    await this.focus(selector);
    await this.pressKeys(key);
  }
  async paste(data) {
    if (typeof data === 'string') return this.insertText(data);
    if (!data || typeof data.text !== 'string') throw Error('paste_text_required');
    if (!data.html) return this.insertText(data.text);
    return this.evaluate(({ text, html }) => {
      let element = document.activeElement;
      while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
      if (!element?.isContentEditable) throw Error('rich_paste_requires_contenteditable');
      if (!document.execCommand('insertHTML', false, html)) throw Error('rich_paste_failed');
      return { inserted: true, clipboardChanged: false };
    }, data);
  }
  async insertText(text) {
    return this.protocol('Input.insertText', { text });
  }
  async key(key, down) {
    const aliases = {
      ControlOrMeta: process.platform === 'darwin' ? 'Meta' : 'Control',
      Control: 'Control',
      Meta: 'Meta',
      Alt: 'Alt',
      Shift: 'Shift',
    };
    key = aliases[key] || key;
    const bits = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
    if (bits[key]) this.modifiers = down ? this.modifiers | bits[key] : this.modifiers & ~bits[key];
    const codes = {
      Enter: 13,
      Tab: 9,
      Escape: 27,
      Backspace: 8,
      Delete: 46,
      ArrowLeft: 37,
      ArrowUp: 38,
      ArrowRight: 39,
      ArrowDown: 40,
      Home: 36,
      End: 35,
      PageUp: 33,
      PageDown: 34,
      Control: 17,
      Meta: 91,
      Alt: 18,
      Shift: 16,
    };
    const params = {
      type: down ? 'keyDown' : 'keyUp',
      key,
      windowsVirtualKeyCode: codes[key] || key.toUpperCase().charCodeAt(0),
      modifiers: this.modifiers,
    };
    if (down && process.platform === 'darwin' && this.modifiers & 4) {
      const commands = {
        a: 'selectAll',
        c: 'copy',
        x: 'cut',
        v: 'paste',
        z: this.modifiers & 8 ? 'redo' : 'undo',
      };
      const command = commands[key.toLowerCase()];
      if (command) params.commands = [command];
    }
    if (down && (key.length === 1 || key === 'Enter') && !(this.modifiers & 6))
      params.text = key === 'Enter' ? '\r' : key;
    return this.protocol('Input.dispatchKeyEvent', params);
  }
  async pressKeys(chord) {
    const keys = chord.split('+');
    try {
      for (const key of keys) await this.key(key, true);
    } finally {
      for (const key of keys.reverse()) await this.key(key, false);
    }
  }
  async mouseEvent(type, x, y, o = {}) {
    const button = o.button || 'left',
      bit = { left: 1, right: 2, middle: 4 }[button] || 0;
    if (type === 'mousePressed') this.buttons |= bit;
    if (type === 'mouseReleased') this.buttons &= ~bit;
    this.mousePosition = { x, y };
    return this.protocol('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: type === 'mouseMoved' ? 'none' : button,
      buttons: this.buttons,
      clickCount: o.clickCount || 1,
      ...(type === 'mouseWheel' ? { deltaX: o.deltaX, deltaY: o.deltaY } : {}),
      modifiers: this.modifiers,
    });
  }
  async mouseClick(x, y, o = {}) {
    await this.mouse.move(x, y);
    for (let count = 1; count <= (o.clickCount || 1); count++) {
      await this.mouseEvent('mousePressed', x, y, { ...o, clickCount: count });
      await this.mouseEvent('mouseReleased', x, y, { ...o, clickCount: count });
    }
  }
  async wait(test, { timeout = 10000 } = {}) {
    if (!Number.isFinite(timeout) || timeout < 0 || timeout > 60000) throw Error('invalid_timeout');
    const end = Date.now() + timeout;
    do {
      try {
        const result = await test();
        if (result) return result;
      } catch (error) {
        // Navigation can replace a frame between observation and its query.
        // Retry only these transient read errors, never ownership failures.
        if (!/^cdp: (No frame for given id found|Cannot find context with specified id|Cannot find default execution context|Execution context was destroyed)/.test(error.message))
          throw error;
      }
      await delay(80);
    } while (Date.now() < end);
    throw Error('wait_timeout');
  }
  async waitForSelector(selector, { state = 'visible', timeout = 10000 } = {}) {
    if (!['visible', 'hidden', 'attached', 'detached'].includes(state))
      throw Error('invalid_wait_state');
    return this.wait(
      async () => {
        const target = await this.find(selector, {
          visible: ['visible', 'hidden'].includes(state),
          optional: true,
        });
        return ['hidden', 'detached'].includes(state) ? !target : !!target;
      },
      { timeout },
    );
  }
  async waitForFunction(fn, arg, options = {}) {
    return this.wait(() => this.evaluate(fn, arg), options);
  }
  async waitForURL(url, options = {}) {
    return this.wait(async () => {
      const actual = await this.url();
      return url instanceof RegExp ? url.test(actual) : actual === url;
    }, options);
  }
  async waitForLoadState(state = 'load', options = {}) {
    if (!['load', 'domcontentloaded'].includes(state)) throw Error('unsupported_load_state');
    await this.wait(async () => {
      const tab = (await this.task.tabs()).find((t) => t.tab === this.targetId);
      return tab && (/^(https?:)/.test(tab.url) || tab.url === 'about:blank');
    }, options);
    return this.waitForFunction(
      (state) =>
        state === 'load' ? document.readyState === 'complete' : document.readyState !== 'loading',
      state,
      options,
    );
  }
  async screenshot({ path, fullPage = false, clip } = {}) {
    const params = { format: 'png', captureBeyondViewport: fullPage };
    if (clip) params.clip = { ...clip, scale: 1 };
    else if (fullPage) {
      const { cssContentSize: s } = await this.protocol('Page.getLayoutMetrics');
      params.clip = { x: 0, y: 0, width: s.width, height: s.height, scale: 1 };
    }
    const { data } = await this.protocol('Page.captureScreenshot', params);
    if (path === false) return { png: data };
    return save(path || join(tmpdir(), `agentic-${randomUUID()}.png`), Buffer.from(data, 'base64'));
  }
  async acceptDialog(promptText) {
    const params = { accept: true };
    if (promptText !== undefined) params.promptText = promptText;
    return this.dialog(params);
  }
  async dismissDialog() {
    return this.dialog({ accept: false });
  }
  async dialog(params) {
    await this.protocol('Page.handleJavaScriptDialog', params);
    this.dialogState = undefined;
    this.eventBuffer = this.eventBuffer.filter((e) => e.method !== 'Page.javascriptDialogOpening');
  }
  async setInputFiles(selector, paths) {
    return this.setFiles(await this.find(selector, { visible: false }), paths);
  }
  async setFiles(target, paths) {
    paths = typeof paths === 'string' ? [paths] : paths;
    for (const path of paths) {
      if (!isAbsolute(path) || !(await stat(path)).isFile())
        throw Error('existing_absolute_file_required');
    }
    await this.protocol(
      'DOM.setFileInputFiles',
      {
        files: paths,
        ...(target.objectId ? { objectId: target.objectId } : { backendNodeId: target.backend }),
      },
      target.session,
    );
    return { dispatched: true };
  }
  async armFileChooser() {
    this.eventBuffer = this.eventBuffer.filter((e) => e.method !== 'Page.fileChooserOpened');
    return this.protocol('Page.setInterceptFileChooserDialog', { enabled: true });
  }
  async takeFileChooser(options = {}) {
    const event = await this.waitForEvent('filechooser', options);
    return {
      setFiles: (paths) =>
        this.setFiles(
          { backend: event.params.backendNodeId, session: event.sessionId || '' },
          paths,
        ),
    };
  }
  async waitForFileChooser(options = {}) {
    await this.armFileChooser();
    try {
      const event = await this.waitForEvent('filechooser', options);
      return {
        setFiles: (paths) =>
          this.setFiles(
            { backend: event.params.backendNodeId, session: event.sessionId || '' },
            paths,
          ),
      };
    } finally {
      await this.protocol('Page.setInterceptFileChooserDialog', { enabled: false });
    }
  }
  async downloads() {
    return (await this.request('downloads')).downloads.map((d) => new Download(this, d));
  }
  async waitForEvent(name, options = {}) {
    if (name === 'popup') {
      const initial = new Set((await this.task.tabs()).map((t) => t.tab));
      return this.wait(async () => {
        const tab = (await this.task.tabs()).find((t) => !initial.has(t.tab));
        return tab && this.task.pageFor(tab.tab);
      }, options);
    }
    if (name === 'download') {
      const initial = new Set((await this.request('downloads')).downloads.map((d) => d.id));
      const d = await this.wait(
        async () => (await this.request('downloads')).downloads.find((d) => !initial.has(d.id)),
        options,
      );
      return new Download(this, d);
    }
    const method = {
      dialog: 'Page.javascriptDialogOpening',
      filechooser: 'Page.fileChooserOpened',
      load: 'Page.loadEventFired',
    }[name];
    if (!method) throw Error('unsupported_event');
    return this.wait(async () => {
      await this.collectEvents();
      const i = this.eventBuffer.findIndex((e) => e.method === method);
      return i < 0 ? null : this.eventBuffer.splice(i, 1)[0];
    }, options);
  }
  async fetch(url, options = {}) {
    const { saveAs, ...rest } = options;
    const response = await this.evaluate(
      async ({ url, options }) => {
        const response = await fetch(url, {
          ...options,
          signal: AbortSignal.timeout(options.timeout || 2500),
        });
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > 4 * 1024 * 1024) throw Error('response_too_large');
        let binary = '';
        for (let i = 0; i < bytes.length; i += 8192)
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        return {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          url: response.url,
          headers: Object.fromEntries(response.headers),
          base64: btoa(binary),
        };
      },
      { url, options: rest },
    );
    const bytes = Buffer.from(response.base64, 'base64');
    delete response.base64;
    return {
      ...response,
      ...(saveAs ? { path: await save(saveAs, bytes) } : { body: bytes.toString('utf8') }),
    };
  }
}
class Download {
  constructor(page, info) {
    this.page = page;
    this.info = info;
  }
  url() {
    return this.info.url;
  }
  suggestedFilename() {
    return this.info.filename;
  }
  async state() {
    const d = (await this.page.request('downloads')).downloads.find((d) => d.id === this.info.id);
    if (!d) throw Error('download_unavailable');
    this.info = d;
    return d;
  }
  async path() {
    return this.page.wait(
      async () => {
        const d = await this.state();
        if (d.state === 2 || d.state === 3) throw Error(`download_failed_${d.failure}`);
        return d.path;
      },
      { timeout: 60000 },
    );
  }
  async failure() {
    const d = await this.state();
    return d.state === 2 ? 'cancelled' : d.state === 3 ? String(d.failure) : null;
  }
  async cancel() {
    return this.page.request('downloads', { cancel: this.info.id });
  }
  async delete() {
    const path = await this.path();
    await unlink(path);
  }
  async saveAs(path) {
    if (!isAbsolute(path)) throw Error('absolute_path_required');
    const source = await this.path();
    await mkdir(dirname(path), { recursive: true });
    await copyFile(source, path, 1);
    return path;
  }
}
