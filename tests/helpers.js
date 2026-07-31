/**
 * Test helpers: load ES6 modules into a vm sandbox for use in Node.js tests.
 *
 * Since the source files now use ES6 import/export, we use Babel to
 * transpile them to CJS before executing in the vm context.
 */
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');

const ROOT = path.join(__dirname, '..');

const BABEL_OPTS = {
  presets: [['@babel/preset-env', {
    targets: { node: 'current' },
    modules: 'commonjs'
  }]],
  babelrc: false,
  configFile: false
};

/** Transpile a file from ES6 → CJS. */
function transpile(filePath) {
  const code = fs.readFileSync(filePath, 'utf8');
  return babel.transformSync(code, { ...BABEL_OPTS, filename: filePath }).code;
}

/**
 * A tiny require() that:
 *  - resolves local files relative to ROOT, transpiles them, and runs them
 *    in the shared vm context.
 *  - caches results so each file is loaded only once per sandbox.
 */
function makeRequire(ctx, cache) {
  function localRequire(id) {
    if (cache[id] !== undefined) return cache[id];

    // Relative imports → resolve from ROOT
    if (!id.startsWith('.') && !id.startsWith('/')) {
      throw new Error(`require('${id}') not supported in sandbox`);
    }
    const filePath = require.resolve(path.resolve(ROOT, id));

    // Create a fresh exports object, expose it as module+exports in the context,
    // then execute the transpiled code.
    const modExports = {};
    cache[id] = modExports; // set before running to handle circular deps

    const cjs = transpile(filePath);
    const script = new vm.Script(
      `(function(require, module, exports){ ${cjs}\n})(localRequire, localModule, localModule.exports);`
    );
    ctx.localRequire = localRequire;
    ctx.localModule = { exports: modExports };
    script.runInContext(ctx);

    // Copy whatever was placed on module.exports back
    Object.assign(modExports, ctx.localModule.exports);
    cache[id] = modExports;
    return modExports;
  }
  return localRequire;
}

/**
 * @param {object} extraGlobals 額外注入 vm context 的全域變數（如 document/window mock）。
 * @param {object} moduleMocks  以 require id（如 './katago-service.js'）為 key 預先塞進模組
 *                              cache 的假模組，讓 sandbox 內其他檔案 require 到它時直接拿到
 *                              mock、不會真的去讀來源檔——用於像 katago-service.js 這種內部
 *                              import 了 .ts（本測試 Babel 設定無法轉譯）且依賴真實瀏覽器
 *                              Worker 的檔案，讓依賴它的模組（如 ai-controller.js）仍可測試。
 */
function createSandbox(extraGlobals = {}, moduleMocks = {}) {
  const cache = { ...moduleMocks };
  const ctx = vm.createContext({
    // Minimal browser-like globals
    document: {
      getElementById: () => null,
      createElement: () => ({ style: {} }),
      querySelector: () => null
    },
    window: null,
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Math, Array, Object, Set, Map, JSON, Promise,
    requestAnimationFrame: (fn) => { fn(0); return 0; },
    // Stubs for missing properties
    localRequire: null,
    localModule: null,
    ...extraGlobals
  });
  ctx.window = ctx;
  ctx.localRequire = makeRequire(ctx, cache);
  return { ctx, localRequire: ctx.localRequire };
}

/**
 * Load a source file into a sandbox context and return its exports merged
 * into the context object (for convenience: ctx.GoRules etc.).
 */
function loadIntoContext(ctx, localRequire, relPath) {
  const exports = localRequire(relPath);
  // Expose named exports directly on ctx so tests can do ctx.GoRules etc.
  for (const [k, v] of Object.entries(exports)) {
    if (k !== '__esModule') ctx[k] = v;
  }
  return exports;
}

/** Returns a sandbox with GoRules loaded. */
function sandboxWithRules() {
  const { ctx, localRequire } = createSandbox();
  loadIntoContext(ctx, localRequire, './rules.js');
  return ctx;
}

/** Returns a sandbox with GoRules + GameState loaded. */
function sandboxWithGameState() {
  const { ctx, localRequire } = createSandbox();
  loadIntoContext(ctx, localRequire, './rules.js');
  loadIntoContext(ctx, localRequire, './game-state.js');
  return ctx;
}

/** Returns a sandbox with GoRules + GoHints loaded. */
function sandboxWithHints() {
  const { ctx, localRequire } = createSandbox();
  loadIntoContext(ctx, localRequire, './rules.js');
  loadIntoContext(ctx, localRequire, './hints.js');
  return ctx;
}

/** Returns a sandbox with GoTimer loaded (no DOM needed for pure functions). */
function sandboxWithTimer() {
  const { ctx, localRequire } = createSandbox();
  loadIntoContext(ctx, localRequire, './timer.js');
  return ctx;
}

/** Returns a sandbox with GoRules + Tsumego loaded. */
function sandboxWithTsumego() {
  const { ctx, localRequire } = createSandbox();
  loadIntoContext(ctx, localRequire, './rules.js');
  loadIntoContext(ctx, localRequire, './tsumego.js');
  return ctx;
}

/** Returns a sandbox with TsumegoProgress loaded (pure reducers; no DOM needed). */
function sandboxWithTsumegoProgress() {
  const { ctx, localRequire } = createSandbox();
  loadIntoContext(ctx, localRequire, './tsumego-progress.js');
  return ctx;
}

/** Returns a sandbox with GameStats loaded（純 reducer；localStorage 為 in-memory mock，
 *  測試可經 ctx.localStorage 直接檢查/操作 mock 狀態）。 */
function sandboxWithStats() {
  const localStorage = createMockLocalStorage();
  const { ctx, localRequire } = createSandbox({ localStorage });
  loadIntoContext(ctx, localRequire, './stats.js');
  return ctx;
}

/**
 * Returns a sandbox with KataGo 的 root 加權純函式載入。
 * rootWeighting.js 是零相依純函式（不碰 DOM、不 import tfjs、無模組層級狀態），
 * 且刻意寫成純 JavaScript，故可直接被本測試 sandbox 載入。
 */
function sandboxWithRootWeighting() {
  const { ctx, localRequire } = createSandbox();
  loadIntoContext(ctx, localRequire, './katago-engine/engine/katago/rootWeighting.js');
  return ctx;
}

/** Returns a sandbox with GoRules + GoReview loaded. */
function sandboxWithReview() {
  const { ctx, localRequire } = createSandbox();
  loadIntoContext(ctx, localRequire, './rules.js');
  loadIntoContext(ctx, localRequire, './review.js');
  return ctx;
}

/** Returns a sandbox with AdaptiveDifficulty loaded (pure logic; no DOM needed). */
function sandboxWithAdaptive() {
  const { ctx, localRequire } = createSandbox();
  loadIntoContext(ctx, localRequire, './adaptive-difficulty.js');
  return ctx;
}

/** Returns a sandbox with AdaptiveChess loaded (pure logic; no DOM needed). */
function sandboxWithAdaptiveChess() {
  const { ctx, localRequire } = createSandbox();
  loadIntoContext(ctx, localRequire, './adaptive-chess.js');
  return ctx;
}

/** Returns a sandbox with Gomoku rules + AI loaded (pure logic; no DOM needed). */
function sandboxWithGomoku() {
  const { ctx, localRequire } = createSandbox();
  loadIntoContext(ctx, localRequire, './rules.js');
  loadIntoContext(ctx, localRequire, './gomoku-rules.js');
  loadIntoContext(ctx, localRequire, './gomoku-ai.js');
  return ctx;
}

/** Returns a sandbox with Connect6 rules + AI loaded (pure logic; no DOM needed). */
function sandboxWithConnect6() {
  const { ctx, localRequire } = createSandbox();
  loadIntoContext(ctx, localRequire, './rules.js');
  loadIntoContext(ctx, localRequire, './gomoku-rules.js');
  loadIntoContext(ctx, localRequire, './gomoku-ai.js');
  loadIntoContext(ctx, localRequire, './connect6-rules.js');
  loadIntoContext(ctx, localRequire, './connect6-ai.js');
  return ctx;
}

/** Returns a sandbox with Othello rules + AI loaded (pure logic; no DOM needed). */
function sandboxWithOthello() {
  const { ctx, localRequire } = createSandbox();
  loadIntoContext(ctx, localRequire, './rules.js');
  loadIntoContext(ctx, localRequire, './othello-rules.js');
  loadIntoContext(ctx, localRequire, './othello-ai.js');
  return ctx;
}

/**
 * Returns a sandbox with AdaptiveChess + XiangqiEngine loaded（純模組載入，不預設任何
 * Stockfish mock）。呼叫端測試前需自行設定 `ctx.Stockfish = mockFactory`
 *（沿用 xiangqi-engine.js 既有的 `window.Stockfish` 注入點，無需改動來源檔案的測試專用 API）。
 */
function sandboxWithXiangqiEngine() {
  const { ctx, localRequire } = createSandbox();
  loadIntoContext(ctx, localRequire, './adaptive-chess.js');
  loadIntoContext(ctx, localRequire, './xiangqi-engine.js');
  return ctx;
}

/** Returns a sandbox with sgf-export loaded（File 由 node 20+ 全域提供給 vm context）。 */
function sandboxWithSgfExport() {
  const { ctx, localRequire } = createSandbox({ File: globalThis.File, Blob: globalThis.Blob });
  loadIntoContext(ctx, localRequire, './sgf-export.js');
  return ctx;
}

/** Returns a sandbox with position-estimate loaded（純邏輯；無 DOM 需求）。 */
function sandboxWithPositionEstimate() {
  const { ctx, localRequire } = createSandbox();
  loadIntoContext(ctx, localRequire, './position-estimate.js');
  return ctx;
}

/** Returns a sandbox with sgf.js loaded（純字串工具）。 */
function sandboxWithSgf() {
  const { ctx, localRequire } = createSandbox();
  loadIntoContext(ctx, localRequire, './sgf.js');
  return ctx;
}

/** Returns a sandbox with canvas-dpr loaded（devicePixelRatio 從 ctx 頂層讀，測試可直接改）。 */
function sandboxWithCanvasDpr() {
  const { ctx, localRequire } = createSandbox({ devicePixelRatio: 1 });
  loadIntoContext(ctx, localRequire, './canvas-dpr.js');
  return ctx;
}

/** Returns a sandbox with entitlements loaded（純邏輯；storage 由呼叫端注入）。 */
function sandboxWithEntitlements() {
  const { ctx, localRequire } = createSandbox();
  loadIntoContext(ctx, localRequire, './entitlements.js');
  return ctx;
}

/** 極簡 in-memory localStorage mock（audio-manager / stats 等需要 localStorage 的測試共用）。 */
function createMockLocalStorage() {
  let store = {};
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { store = {}; }
  };
}

/** 極簡 event-target mock：addEventListener/removeEventListener/dispatchEvent，document／window 共用邏輯
 *  （各自獨立的 listeners registry，互不影響——比照真實瀏覽器 document 與 window 是不同物件）。 */
function createMockEventTarget(extra = {}) {
  const listeners = {};
  return {
    ...extra,
    addEventListener(type, fn, opts) {
      const entry = { fn, once: !!(opts && opts.once) };
      (listeners[type] = listeners[type] || []).push(entry);
    },
    removeEventListener(type, fn) {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter((entry) => entry.fn !== fn);
    },
    dispatchEvent(evt) {
      const entries = (listeners[evt.type] || []).slice();
      for (const entry of entries) {
        entry.fn(evt);
        if (entry.once) {
          listeners[evt.type] = (listeners[evt.type] || []).filter((e) => e !== entry);
        }
      }
      return true;
    }
  };
}

/** 極簡 document mock（audio-manager 需要監聽解鎖手勢與 visibilitychange，皆掛在 document 上）。 */
function createMockDocumentForAudio() {
  return createMockEventTarget({
    getElementById: () => null,
    createElement: () => ({ style: {} }),
    querySelector: () => null,
    visibilityState: 'visible'
  });
}

/** 極簡 CustomEvent polyfill（vm context 沒有瀏覽器內建的 CustomEvent）。 */
class MockCustomEvent {
  constructor(type, opts = {}) {
    this.type = type;
    this.detail = opts ? opts.detail : undefined;
  }
}

/**
 * Returns a sandbox with AudioManager loaded, plus mock localStorage/document/CustomEvent
 * so audio-manager.js's設定持久化與事件廣播邏輯可在 node（無 jsdom）下測試。
 * 呼叫端可用回傳的 ctx.localStorage / ctx.document 直接檢查/操作 mock 狀態。
 */
function sandboxWithAudioManager() {
  const localStorage = createMockLocalStorage();
  const document = createMockDocumentForAudio();
  // window 是獨立於 document 的另一個 event target（pagehide 只在 window 上發射，見 audio-manager.js
  // handlePageHide 的掛法）；createSandbox 內部把 ctx.window 設回 ctx 自身，故這裡把
  // addEventListener/removeEventListener/dispatchEvent 直接放在 extraGlobals（= ctx 的頂層屬性），
  // 讓 `window.addEventListener(...)` 能解析到這組獨立於 document 的 listeners。
  const windowTarget = createMockEventTarget();
  const { ctx, localRequire } = createSandbox({
    localStorage,
    document,
    CustomEvent: MockCustomEvent,
    navigator: {},
    addEventListener: windowTarget.addEventListener,
    removeEventListener: windowTarget.removeEventListener,
    dispatchEvent: windowTarget.dispatchEvent
  });
  loadIntoContext(ctx, localRequire, './sound.js'); // 先曝露 GoSound，方便測試 spy fallback 呼叫
  loadIntoContext(ctx, localRequire, './audio-manager.js');
  ctx.localStorage = localStorage;
  return ctx;
}

/**
 * Returns a sandbox with ai-controller.js loaded (`makeAiController`), with
 * './katago-service.js' pre-mocked to `mockKataGo`（呼叫端提供 ensureReady/genmoveCandidates/
 * reset 等假實作）。katago-service.js 本身 import 了 katago-engine/.../client.ts——本專案
 * 測試用的 Babel 設定只有 @babel/preset-env（無 TypeScript 支援），且 client.ts 依賴真實
 * 瀏覽器 Worker，兩者都無法在 vm sandbox 裡真的載入，所以一律 mock 掉，讓
 * ai-controller.js 的重試／watchdog／恢復邏輯可離線測試。
 * './adaptive-difficulty.js' 是純邏輯、無 DOM 依賴，直接載入真實檔案。
 */
function sandboxWithAiController(mockKataGo = {}) {
  const { ctx, localRequire } = createSandbox({}, { './katago-service.js': mockKataGo });
  loadIntoContext(ctx, localRequire, './adaptive-difficulty.js');
  loadIntoContext(ctx, localRequire, './ai-controller.js');
  return ctx;
}

function createMainLifecycleElement(id = '') {
  const listeners = {};
  const children = [];
  const classNames = new Set();
  const el = {
    id,
    style: {},
    children,
    className: '',
    textContent: '',
    innerHTML: '',
    value: '',
    checked: false,
    disabled: false,
    width: id === 'board' ? 600 : 0,
    height: id === 'board' ? 600 : 0,
    clientWidth: 0,
    scrollWidth: 0,
    scrollLeft: 0,
    parentElement: null,
    classList: {
      add: (...names) => names.forEach((name) => classNames.add(name)),
      remove: (...names) => names.forEach((name) => classNames.delete(name)),
      toggle: (name, force) => {
        if (force === true) classNames.add(name);
        else if (force === false) classNames.delete(name);
        else if (classNames.has(name)) classNames.delete(name);
        else classNames.add(name);
        return classNames.has(name);
      },
      contains: (name) => classNames.has(name)
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    dispatchEvent(event) {
      for (const fn of listeners[event.type] || []) fn(event);
      return true;
    },
    appendChild(child) {
      children.push(child);
      child.parentElement = el;
      return child;
    },
    append(...items) {
      items.forEach((item) => {
        if (item && typeof item === 'object') item.parentElement = el;
        children.push(item);
      });
    },
    after() {},
    remove() {},
    replaceWith() {},
    setAttribute() {},
    getContext: () => ({}),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 600 }),
    querySelector: () => children.find((child) => child && typeof child === 'object') || null,
    querySelectorAll: () => [],
    scrollBy() {},
    setPointerCapture() {},
    releasePointerCapture() {}
  };
  return el;
}

/**
 * Returns a sandbox with 真實 ui.js 載入，供渲染層（純 DOM 的 8 個 export）單元測試。
 *
 * ui.js 模組層級沒有任何 canvas 副作用，5 個 import 也都只 export 函式，所以
 * require 本身完全不需要 canvas；只要不呼叫 drawBoard/drawStone/resizeCanvas/
 * drawWinrateGraph 這 4 個需要 2D context 的 export 就不會碰到 canvas。
 *
 * 注意：updateHUD/updateReviewInfo/updateScoringDisplay 內有多處
 * `getElementById(...).textContent =` 是**沒有 null guard** 的，所以這裡的
 * getElementById 必須永不回傳 null——改以 id 為 key 記憶化建立元素 mock，
 * 測試再從回傳的 elements 讀取寫入結果。
 */
function sandboxWithGoUI() {
  const elements = {};
  const getElement = (id) => {
    if (!elements[id]) elements[id] = createMainLifecycleElement(id);
    return elements[id];
  };
  const document = createMockEventTarget({
    getElementById: getElement,
    createElement: (tag) => createMainLifecycleElement(tag),
    querySelector: () => null,
    querySelectorAll: () => []
  });
  const { ctx, localRequire } = createSandbox({
    document,
    devicePixelRatio: 1,
    matchMedia: () => ({ matches: false })
  });
  loadIntoContext(ctx, localRequire, './rules.js');
  loadIntoContext(ctx, localRequire, './ui.js');
  return { ctx, elements, GoUI: ctx.GoUI };
}

/**
 * 載入真實 main.js 與 GameState，僅替換引擎、音訊、商店與其他棋類等外部邊界。
 * 用於驗證圍棋主流程在瀏覽器生命週期中的可觀察狀態與控制項結果。
 *
 * @param {boolean} useRealTimer 只決定一件事：要不要載入真實的 './timer.js'
 *   （false 時換成 noop mock）。**不再控制假 scheduler**——`clock.advance/tick/
 *   runTimeouts` 依賴的假 Date / setTimeout / setInterval 一律安裝，見下方注入處。
 *   名稱刻意不改：改名會讓仍傳舊名的呼叫點被解構預設值靜默忽略，正是這裡要根治的問題類型。
 */
function sandboxWithMainLifecycle({
  storage = {},
  sharedStorage = null,
  hash = '#home',
  confirmResult = true,
  useRealTimer = false,
  now = 1_000_000
} = {}) {
  const localStorage = sharedStorage || createMockLocalStorage();
  Object.entries(storage).forEach(([key, value]) => localStorage.setItem(key, value));

  let currentNow = now;
  let nextIntervalId = 1;
  const intervals = new Map();
  const timeouts = new Map();
  class LifecycleDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [currentNow]));
    }
    static now() {
      return currentNow;
    }
  }
  const clock = {
    advance(ms) {
      currentNow += ms;
    },
    tick() {
      for (const callback of Array.from(intervals.values())) callback();
    },
    runTimeouts() {
      const pending = Array.from(timeouts.entries());
      for (const [id, callback] of pending) {
        timeouts.delete(id);
        callback();
      }
    }
  };

  const elements = {};
  const elementDefaults = {
    boardSize: { value: '9' },
    gameMode: { value: 'pvc' },
    playerColor: { value: '1' },
    aiLevelMode: { value: 'auto' },
    aiManualLevel: { value: '1' },
    timerToggle: { checked: false },
    timerMinutes: { value: '10' },
    gameRules: { value: 'chinese' },
    handicap: { value: '0' },
    emotionToggle: { checked: false },
    reviewToggle: { checked: true },
    undoToggle: { checked: true }
  };
  const getElement = (id) => {
    if (!elements[id]) {
      elements[id] = createMainLifecycleElement(id);
      Object.assign(elements[id], elementDefaults[id] || {});
      if (id === 'homeMenu') elements[id].parentElement = createMainLifecycleElement('homeScreen');
    }
    return elements[id];
  };
  const document = createMockEventTarget({
    title: '',
    getElementById: getElement,
    createElement: (tag) => createMainLifecycleElement(tag),
    querySelector: (selector) => selector === 'h1' ? getElement('pageTitle') : null,
    querySelectorAll: () => []
  });
  const windowTarget = createMockEventTarget();
  const confirm = jest.fn(() => confirmResult);
  const location = { hash, hostname: 'example.test', port: '' };

  const noop = () => {};
  const requestAIMove = jest.fn();
  const appRef = { app: null };
  // 記錄 main.js 每次交給 UI 層的狀態。真實 ui.js 的 updateHUD() 是 #mobileTurn 回合徽章
  // 的唯一寫入點，而 sandbox 把 ui.js 整組換成 noop，UI 層等於零覆蓋。這裡改成記錄器，
  // 讓測試能觀察「main.js 有沒有在狀態變動後把最新回合送進 UI 層」這條真實資料流。
  // 注意：updateHUD() 收到的是 GameState 的活物件，留存參照之後會讀到「當下」而非
  // 「呼叫當時」的值，因此在呼叫點就抄下決定徽章內容的欄位（與 ui.js updateHUD 的
  // 判斷輸入相同），否則斷言會恆真、失去鑑別力。
  const hudUpdates = [];
  const moduleMocks = {
    './sound.js': { GoSound: {} },
    './hints.js': { GoHints: { getCaptureHints: () => [] } },
    './sgf-export.js': { shareOrDownloadSgf: async () => 'downloaded' },
    './go-settings.js': { openGoSettings: noop, closeGoSettings: noop, toggleGoSettings: noop },
    './ai-controller.js': { makeAiController: () => ({ requestAIMove }) },
    // main.js 啟動時會把 app context 交給 registerEventHandlers()。真實的 event handler
    // 需要 canvas 事件，測不了；但 app 物件本身是子模組（棋盤點擊、AI controller）唯一的
    // 進入點，攔下來讓測試能直接呼叫 app.toggleDeadGroup() 這類「只有 DOM 事件會走到」的
    // 路徑，不必為了測試在 window 上多曝露函式。
    './event-handlers.js': { registerEventHandlers: (appContext) => { appRef.app = appContext; } },
    './gomoku-mode.js': { enterGomokuMode: noop },
    './connect6-mode.js': { enterConnect6Mode: noop },
    './othello-mode.js': { enterOthelloMode: noop },
    './tsumego-progress.js': { loadProgress: () => ({}), totalSolved: () => 0 },
    './ink-fx.js': { playTitleReveal: noop, startAmbient: noop, playTransition: (fn) => fn() },
    './katago-service.js': {
      ensureReady: async () => {},
      suggest: async () => ({}),
      evaluate: async () => ({}),
      scoreGame: async () => ({ ownership: null })
    },
    './entitlements.js': {
      isPremium: () => true,
      remainingQuota: () => 1,
      consumeQuota: noop
    },
    './store-service.js': {
      storeAvailable: () => false,
      getFullVersionPrice: async () => '',
      purchaseFullVersion: async () => ({ ok: true }),
      restoreFullVersion: async () => ({ owned: true, message: '' }),
      syncEntitlements: async () => {}
    },
    './audio-manager.js': { initAudio: noop, loadSfxPack: noop, playSfx: noop },
    './audio-settings-ui.js': { renderAudioControls: noop, initAudioMuteButtons: noop },
    './stats.js': {
      recordGame: (state) => state,
      totals: () => ({ wins: 0, losses: 0, draws: 0 }),
      formatRecord: () => '',
      loadStats: () => ({}),
      saveStats: noop
    }
  };
  if (!useRealTimer) {
    moduleMocks['./timer.js'] = {
      GoTimer: {
        init: noop,
        start: noop,
        switch: noop,
        stop: noop,
        sync: noop,
        updateDisplay: noop
      }
    };
  }

  const { ctx, localRequire } = createSandbox({
    localStorage,
    document,
    navigator: {},
    location,
    fetch: async () => ({ ok: false }),
    confirm,
    matchMedia: () => ({ matches: false }),
    addEventListener: windowTarget.addEventListener,
    removeEventListener: windowTarget.removeEventListener,
    dispatchEvent: windowTarget.dispatchEvent,
    __IOS_STORE__: false,
    // 假 scheduler（Date / setInterval / setTimeout）一律安裝，不看任何旗標。
    // 過去它綁在 useRealTimer 上，漏帶旗標的 sandbox 會拿到真的 setTimeout，於是
    // clock.runTimeouts() 靜默變成 no-op，`aiCalls: 0` 這類斷言空洞通過卻全綠。
    // 恆常安裝直接消除這個失效模式（空佇列的 no-op 才是唯一剩下的合法情境），
    // 順帶讓 main.js 排的計時器不再洩漏到 jest worker 的 event loop。
    Date: LifecycleDate,
    setInterval: (callback) => {
      const id = nextIntervalId++;
      intervals.set(id, callback);
      return id;
    },
    clearInterval: (id) => {
      intervals.delete(id);
    },
    setTimeout: (callback) => {
      const id = nextIntervalId++;
      timeouts.set(id, callback);
      return id;
    },
    clearTimeout: (id) => {
      timeouts.delete(id);
    }
  }, moduleMocks);

  // 載入**真實** ui.js，只就地覆寫兩個需要 canvas 2D context 的繪圖函式。
  // ui.js 的 12 個 export 中，8 個是純 DOM 操作、與繪圖那群幾乎零耦合（唯一共用的
  // 只有 rules.js 的 BLACK/WHITE 常數），模組層級也沒有任何 canvas 副作用，所以
  // require 本身不需要 canvas。過去這裡把整組 ui.js 換成 noop，導致 #mobileTurn
  // 徽章、狀態列、提子數這些渲染邏輯零覆蓋（終局徽章顯示錯誤的一方就是這樣漏到
  // 瀏覽器 smoke 才被抓到）。drawBoard/drawWinrateGraph 繼續交給瀏覽器 smoke——
  // 對它們能寫的單元斷言只有繪圖指令清單，等於把實作重講一遍，改個 padding 就整批紅燈。
  const realUI = localRequire('./ui.js');
  // 就地 mutate，不重新指派 realUI.GoUI（不依賴 Babel 的 live-binding 語意）。
  realUI.GoUI.drawBoard = noop;
  realUI.GoUI.drawWinrateGraph = noop;
  // updateHUD 是「包一層」而非換掉：既有測試斷言的 hudUpdates 資料流記錄器要留著，
  // 同時讓真實的 updateHUD 真的把文字寫進 DOM mock，兩種斷言得以並存。
  // 注意：updateHUD() 收到的是 GameState 的活物件，留存參照之後會讀到「當下」而非
  // 「呼叫當時」的值，因此在呼叫點就抄下決定徽章內容的欄位，否則斷言會恆真、失去鑑別力。
  const realUpdateHUD = realUI.GoUI.updateHUD;
  realUI.GoUI.updateHUD = (state) => {
    hudUpdates.push({
      currentPlayer: state.currentPlayer,
      gameOver: !!state.gameOver,
      isAIThinking: !!state.isAIThinking,
      moveCount: state.moveHistory.length
    });
    realUpdateHUD(state);
  };

  loadIntoContext(ctx, localRequire, './main.js');
  const gameState = localRequire('./game-state.js');
  return { ctx, GameState: gameState, elements, localStorage, confirm, clock, requestAIMove, hudUpdates, app: appRef.app };
}

module.exports = { sandboxWithGoUI, sandboxWithRules, sandboxWithGameState, sandboxWithHints, sandboxWithTimer, sandboxWithTsumego, sandboxWithTsumegoProgress, sandboxWithStats, sandboxWithReview, sandboxWithAdaptive, sandboxWithAdaptiveChess, sandboxWithGomoku, sandboxWithConnect6, sandboxWithOthello, sandboxWithAudioManager, sandboxWithXiangqiEngine, sandboxWithAiController, sandboxWithSgfExport, sandboxWithPositionEstimate, sandboxWithEntitlements, sandboxWithSgf, sandboxWithCanvasDpr, sandboxWithMainLifecycle, sandboxWithRootWeighting, createMockLocalStorage };
