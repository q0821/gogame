# 圍棋核心狀態單一來源 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 `game-state.js` 成為圍棋核心對局狀態的唯一來源，移除 `main.js` 的狀態鏡像與同步函式，同時維持既有行為與儲存格式。

**Architecture:** 保留目前原生 JavaScript 的命令式 render 流程，所有核心狀態讀取改為直接取得 `GameState.getState()`，所有寫入改用語意明確的 `GameState` 操作。Canvas、hover、動畫、分析結果與其他暫時性 UI 狀態繼續留在 `main.js`，不導入 Proxy、訂閱式 store 或新套件。

**Tech Stack:** 原生 JavaScript ES Modules、Vite 8、Jest 30、Canvas、Capacitor 7、KataGo、TensorFlow.js

## Global Constraints

- 不改變 `gogame_state` 的 `localStorage` 格式。
- 不改變棋規、AI 強度、自適應難度演算法、UI、HTML ID 或全域操作函式名稱。
- 不修改其他棋類的獨立狀態管理。
- 不新增狀態管理套件、Proxy 或事件訂閱機制。
- 暫時性 UI 狀態必須繼續留在 `main.js`。
- 每個非同步邊界完成後，重新讀取最新 `GameState`。
- 每個任務完成後執行指定測試，測試通過才 commit。
- commit 訊息不得加入 Codex、Co-Authored-By 或其他生成工具尾註。
- 驗證建置使用 `npx vite build`，不要執行會改寫版本檔案的 `npm run build`。
- 不順手重構本計畫未點名的程式碼。

---

## File Map

- Modify: `game-state.js`
  - 保存唯一核心狀態。
  - 提供語意明確的讀寫操作。
  - 最終移除泛用的 `sync()`。
- Modify: `main.js`
  - 直接讀取 `GameState`。
  - 保留 UI 暫存狀態與命令式 render。
  - 移除核心狀態鏡像與 `applyStateFromStore()`。
- Modify: `timer.js`
  - 保留 wall-clock 計時邏輯。
  - 改用 callback 讀寫核心計時狀態。
- Modify: `ai-controller.js`
  - 經由 `app` façade 設定 AI 狀態。
  - 不直接操作 `GameState`。
- Modify: `event-handlers.js`
  - 經由 `app.toggleDeadGroup()` 修改死子。
  - 不直接操作 `GameState`。
- Modify: `tests/game-state.test.js`
  - 驗證新狀態 API、clone 邊界與舊 snapshot 相容性。
- Modify: `tests/timer.test.js`
  - 驗證 callback 計時介面與 wall-clock 行為。
- Modify: `tests/ai-controller.test.js`
  - 驗證 façade、watchdog 與 AI 鎖定狀態。
- Reference: `docs/superpowers/specs/2026-07-28-go-single-state-source-design.md`
  - 本計畫的已核准設計來源。

---

### Task 1: 新增 `GameState` 語意寫入 API

**Files:**

- Modify: `game-state.js:165-210`
- Modify: `game-state.js:363-369`
- Test: `tests/game-state.test.js:420-470`

**Interfaces:**

- Produces: `GameState.setAIThinking(value)`
- Produces: `GameState.setAiLevel(level)`
- Produces: `GameState.setTimerSeconds(seconds)`
- Produces: `GameState.setDeadStones(stones)`
- Produces: `GameState.markGameOver()`
- Retains temporarily: `GameState.sync(partialState)`，供尚未遷移的正式程式碼使用

- [ ] **Step 1: 先加入新 API 的失敗測試**

在 `tests/game-state.test.js` 的 snapshot 測試後、既有 `sync` 測試前加入：

```js
describe('semantic state mutations', () => {
  beforeEach(() => GameState.resetState({ size: 9, aiLevel: 4 }));

  test('setAIThinking 只更新思考狀態', () => {
    const boardBefore = GameState.getState().board;
    GameState.setAIThinking(true);
    expect(GameState.getState().isAIThinking).toBe(true);
    expect(GameState.getState().board).toBe(boardBefore);
  });

  test('setAiLevel 更新目前棋局等級', () => {
    GameState.setAiLevel(7);
    expect(GameState.getState().aiLevel).toBe(7);
  });

  test('setTimerSeconds 複製輸入，外部後續修改不影響 store', () => {
    const seconds = { [BLACK]: 123, [WHITE]: 456 };
    GameState.setTimerSeconds(seconds);
    seconds[BLACK] = 0;
    expect(GameState.getState().timerSeconds).toEqual({ [BLACK]: 123, [WHITE]: 456 });
  });

  test('setDeadStones 建立自己的 Set', () => {
    const stones = new Set([5, 10]);
    GameState.setDeadStones(stones);
    stones.add(20);
    const stored = GameState.getState().deadStones;
    expect(stored.has(5)).toBe(true);
    expect(stored.has(10)).toBe(true);
    expect(stored.has(20)).toBe(false);
  });

  test('markGameOver 結束棋局並釋放 AI 鎖', () => {
    GameState.setAIThinking(true);
    GameState.markGameOver();
    expect(GameState.getState().gameOver).toBe(true);
    expect(GameState.getState().isAIThinking).toBe(false);
  });
});
```

- [ ] **Step 2: 執行測試，確認因 API 尚未存在而失敗**

Run:

```bash
npx jest tests/game-state.test.js --runInBand
```

Expected: FAIL，錯誤指出 `setAIThinking`、`setAiLevel`、`setTimerSeconds`、`setDeadStones` 或 `markGameOver` 不是函式。

- [ ] **Step 3: 在 `game-state.js` 實作最小語意 API**

將以下函式加在 `sync()` 前面：

```js
export function setAIThinking(value) {
  const current = ensureState();
  current.isAIThinking = !!value;
  return current;
}

export function setAiLevel(level) {
  const current = ensureState();
  current.aiLevel = level;
  return current;
}

export function setTimerSeconds(seconds = {}) {
  const current = ensureState();
  current.timerSeconds = {
    [BLACK]: seconds[BLACK] ?? seconds[1] ?? current.timerSeconds[BLACK],
    [WHITE]: seconds[WHITE] ?? seconds[2] ?? current.timerSeconds[WHITE]
  };
  return current;
}

export function setDeadStones(stones = []) {
  const current = ensureState();
  current.deadStones = new Set(stones);
  return current;
}

export function markGameOver() {
  const current = ensureState();
  current.gameOver = true;
  current.isAIThinking = false;
  return current;
}
```

把它們加入檔尾 `GameState` export：

```js
export const GameState = {
  createInitialState, resetState, getState, getSnapshot, restoreSnapshot,
  sync, setAIThinking, setAiLevel, setTimerSeconds, setDeadStones, markGameOver,
  applyMove, applyPass, undo, startGame,
  beginScoring, cancelScoring, confirmScoring, toggleDeadGroup,
  enterReview, exitReview, reviewGo
};
```

- [ ] **Step 4: 補舊 snapshot 相容性測試**

在 `restoreSnapshot` 測試區加入：

```js
test('restoreSnapshot 可載入缺少新欄位的舊資料', () => {
  const oldSnapshot = {
    size: 9,
    board: GoRules.createBoard(9),
    currentPlayer: BLACK,
    captures: { 1: 0, 2: 0 },
    moveHistory: []
  };
  GameState.restoreSnapshot(oldSnapshot);
  const state = GameState.getState();
  expect(state.timerSeconds).toEqual({ [BLACK]: 600, [WHITE]: 600 });
  expect(state.isAIThinking).toBe(false);
  expect(typeof state.deadStones.has).toBe('function');
});
```

- [ ] **Step 5: 執行狀態測試**

Run:

```bash
npx jest tests/game-state.test.js --runInBand
```

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add game-state.js tests/game-state.test.js
git commit -m "refactor(go): 新增明確狀態寫入介面"
```

---

### Task 2: 將計時器改成 callback 狀態介面

**Files:**

- Modify: `timer.js:10-92`
- Modify: `main.js:872-896`
- Modify: `tests/timer.test.js:38-115`

**Interfaces:**

- Consumes: `GameState.getState()`
- Consumes: `GameState.setTimerSeconds(seconds)`
- Produces: `GoTimer.init(minutes, setTimerSeconds)`
- Produces: `GoTimer.start({ getTimerSeconds, setTimerSeconds, getCurrentPlayer, onTimeout })`
- Produces: `GoTimer.switch(options)`
- Produces: `GoTimer.sync()`
- Retains: `GoTimer.stop()`
- Retains: `GoTimer.updateDisplay(timerSeconds)`
- Retains: `GoTimer.formatTime(seconds)`

- [ ] **Step 1: 將 timer 測試改成 callback harness**

在 `tests/timer.test.js` 的 `clocked()` 後加入：

```js
function timerStore(initial = { 1: 600, 2: 600 }) {
  let seconds = { ...initial };
  const writes = [];
  return {
    getTimerSeconds: () => seconds,
    setTimerSeconds: (next) => {
      writes.push(next);
      seconds = { ...next };
    },
    get seconds() { return seconds; },
    writes
  };
}
```

將各 wall-clock 測試改成物件介面。例如第一個測試改為：

```js
test('依真實流逝扣秒（非 tick 次數）', () => {
  const { GoTimer, advance, tick } = clocked();
  const store = timerStore();
  GoTimer.start({
    getTimerSeconds: store.getTimerSeconds,
    setTimerSeconds: store.setTimerSeconds,
    getCurrentPlayer: () => 1,
    onTimeout: () => {}
  });
  advance(5000);
  tick();
  expect(GoTimer.formatTime(store.seconds[1])).toBe('09:55');
  expect(store.seconds[2]).toBe(600);
});
```

其他測試使用同一介面改寫，並新增：

```js
test('更新使用新物件寫回，不直接修改讀取到的物件', () => {
  const { GoTimer, advance, tick } = clocked();
  const original = { 1: 600, 2: 600 };
  const store = timerStore(original);
  GoTimer.start({
    getTimerSeconds: store.getTimerSeconds,
    setTimerSeconds: store.setTimerSeconds,
    getCurrentPlayer: () => 1,
    onTimeout: () => {}
  });
  advance(1000);
  tick();
  expect(original).toEqual({ 1: 600, 2: 600 });
  expect(store.writes.length).toBeGreaterThan(0);
  expect(store.seconds[1]).toBe(599);
});

test('sync() 定格最新秒數但保持 interval 運作', () => {
  const { GoTimer, advance, hasInterval } = clocked();
  const store = timerStore();
  GoTimer.start({
    getTimerSeconds: store.getTimerSeconds,
    setTimerSeconds: store.setTimerSeconds,
    getCurrentPlayer: () => 1,
    onTimeout: () => {}
  });
  advance(7000);
  GoTimer.sync();
  expect(Math.round(store.seconds[1])).toBe(593);
  expect(hasInterval()).toBe(true);
});
```

- [ ] **Step 2: 執行 timer 測試，確認舊介面無法通過**

Run:

```bash
npx jest tests/timer.test.js --runInBand
```

Expected: FAIL，因現有 `GoTimer.start()` 仍接受可變秒數物件，也沒有 `sync()`。

- [ ] **Step 3: 改寫 `timer.js` 的狀態存取**

將 `secondsRef`、`timeoutCb`、`getPlayer` 改成：

```js
let getTimerSeconds = null;
let setTimerSeconds = null;
let timeoutCb = null;
let getPlayer = null;
```

將 `syncRemaining()` 改成建立新物件並透過 callback 寫回：

```js
function syncRemaining() {
  if (activePlayer == null || !getTimerSeconds || !setTimerSeconds) return null;
  const remaining = Math.max(0, turnStartRemaining - elapsed());
  const current = getTimerSeconds();
  const next = { ...current, [activePlayer]: remaining };
  setTimerSeconds(next);
  return { remaining, seconds: next };
}
```

將 `tick()` 改成：

```js
function tick() {
  if (activePlayer == null) return;
  const synced = syncRemaining();
  if (!synced) return;
  GoTimer.updateDisplay(synced.seconds);
  if (synced.remaining <= 0) {
    const timedOut = activePlayer;
    GoTimer.stop();
    timeoutCb && timeoutCb(timedOut);
  }
}
```

將公開 API 改為：

```js
export const GoTimer = {
  init(minutes, writeSeconds) {
    const secs = (minutes || 10) * 60;
    const next = { 1: secs, 2: secs };
    writeSeconds(next);
    GoTimer.updateDisplay(next);
  },

  start(options) {
    GoTimer.stop();
    getTimerSeconds = options.getTimerSeconds;
    setTimerSeconds = options.setTimerSeconds;
    getPlayer = options.getCurrentPlayer;
    timeoutCb = options.onTimeout;
    activePlayer = getPlayer();
    turnStartTs = Date.now();
    turnStartRemaining = getTimerSeconds()[activePlayer];
    GoTimer.updateDisplay(getTimerSeconds());
    displayInterval = setInterval(tick, TICK_MS);
  },

  switch(options) {
    GoTimer.start(options);
  },

  sync() {
    return syncRemaining();
  },

  stop() {
    if (activePlayer != null) {
      syncRemaining();
      activePlayer = null;
    }
    if (displayInterval) {
      clearInterval(displayInterval);
      displayInterval = null;
    }
  },

  updateDisplay(timerSeconds) {
    const bEl = document.getElementById('blackTimer');
    const wEl = document.getElementById('whiteTimer');
    if (!bEl || !wEl) return;
    bEl.textContent = GoTimer.formatTime(timerSeconds[1]);
    wEl.textContent = GoTimer.formatTime(timerSeconds[2]);
    bEl.classList.toggle('urgent', timerSeconds[1] < 60);
    wEl.classList.toggle('urgent', timerSeconds[2] < 60);
  },

  formatTime(s) {
    const t = Math.max(0, Math.ceil(s));
    return `${Math.floor(t / 60).toString().padStart(2, '0')}:${(t % 60).toString().padStart(2, '0')}`;
  }
};
```

- [ ] **Step 4: 讓 `main.js` 使用新的 timer 介面**

在 timer 區段新增：

```js
function timerOptions() {
  return {
    getTimerSeconds: () => GameState.getState().timerSeconds,
    setTimerSeconds: (seconds) => {
      GameState.setTimerSeconds(seconds);
      timerSeconds = { ...GameState.getState().timerSeconds };
    },
    getCurrentPlayer: () => GameState.getState().currentPlayer,
    onTimeout: _timerOnTimeout
  };
}
```

暫時只更新 `main.js` 的 `timerSeconds` 鏡像，讓尚未遷移的儲存流程仍能運作。不要在 250 ms 的 timer tick 內呼叫 `applyStateFromStore()`，避免每次 tick 深層複製棋盤與棋譜。Task 6 會移除這個暫時鏡像賦值。

更新 timer 包裝函式：

```js
function initTimer() {
  const minutes = parseInt(document.getElementById('timerMinutes').value);
  GoTimer.init(minutes, timerOptions().setTimerSeconds);
}

function startTimer() {
  if (!GameState.getState().timerEnabled) return;
  GoTimer.start(timerOptions());
}

function switchTimer() {
  if (!GameState.getState().timerEnabled) return;
  GoTimer.switch(timerOptions());
}

function stopTimer() {
  GoTimer.stop();
}

function updateTimerDisplay() {
  GoTimer.updateDisplay(GameState.getState().timerSeconds);
}
```

- [ ] **Step 5: 執行 timer 與完整測試**

Run:

```bash
npx jest tests/timer.test.js --runInBand
npm test -- --runInBand
```

Expected: PASS，現有背景節流、換手與超時行為保持不變。

- [ ] **Step 6: 驗證 Web bundle**

Run:

```bash
npx vite build
```

Expected: exit code 0，`dist/` 產生成功，來源檔案沒有被版本產生器改寫。

- [ ] **Step 7: Commit**

```bash
git add timer.js main.js tests/timer.test.js
git commit -m "refactor(go): 讓計時器經由狀態介面寫入"
```

---

### Task 3: 隔離 AI 與事件處理器的 store 依賴

**Files:**

- Modify: `ai-controller.js:58-120`
- Modify: `event-handlers.js:27-38`
- Modify: `main.js:108-165`
- Modify: `tests/ai-controller.test.js:20-65`

**Interfaces:**

- Consumes: `GameState.setAIThinking(value)`
- Consumes: `GameState.toggleDeadGroup(groupStones)`
- Produces for submodules: `app.setAIThinking(value)`
- Produces for submodules: `app.toggleDeadGroup(groupStones)`
- Removes from submodules: `app.GameState`
- Removes from submodules: `app.applyStateFromStore`

- [ ] **Step 1: 先修改 AI controller 測試 façade**

在 `makeApp()` 中把：

```js
const calls = { sync: [], placeStone: [], doPassCount: 0, setStatus: [] };
```

改成：

```js
const calls = { setAIThinking: [], placeStone: [], doPassCount: 0, setStatus: [] };
```

移除 `GameState` 與 `applyStateFromStore` mock，加入：

```js
setAIThinking(value) {
  calls.setAIThinking.push(value);
  state.isAIThinking = value;
},
```

在正常路徑測試補上：

```js
expect(calls.setAIThinking).toEqual([true, false]);
```

在 watchdog 測試補上：

```js
expect(calls.setAIThinking[0]).toBe(true);
expect(calls.setAIThinking[calls.setAIThinking.length - 1]).toBe(false);
```

- [ ] **Step 2: 執行 AI 測試，確認舊 controller 仍依賴 `app.GameState`**

Run:

```bash
npx jest tests/ai-controller.test.js --runInBand
```

Expected: FAIL，錯誤指出 `app.GameState` 不存在，或 `setAIThinking` 未被呼叫。

- [ ] **Step 3: 修改 `ai-controller.js`**

將 AI 開始時的：

```js
app.GameState.sync({ isAIThinking: true });
app.applyStateFromStore();
```

改成：

```js
app.setAIThinking(true);
```

將正常完成與錯誤恢復路徑中的：

```js
app.GameState.sync({ isAIThinking: false });
app.applyStateFromStore();
```

改成：

```js
app.setAIThinking(false);
```

刪除成功路徑中只為同步鏡像而存在的：

```js
app.applyStateFromStore();
```

保留既有 `syncStatus()`、`updateUI()`、watchdog、retry 與 reset 流程。

- [ ] **Step 4: 修改 `event-handlers.js`**

將數目模式的操作改成：

```js
const result = app.toggleDeadGroup(group.stones);
if (!result.ok) return;
app.updateScoringDisplay();
app.drawBoard();
```

不得在 `event-handlers.js` 中留下 `app.GameState` 或 `app.applyStateFromStore`。

- [ ] **Step 5: 在 `main.js` 提供暫時相容 façade**

將 `app` 的模組參照與同步函式移除，改成：

```js
setAIThinking: (value) => {
  GameState.setAIThinking(value);
  applyStateFromStore();
},
toggleDeadGroup: (stones) => {
  const result = GameState.toggleDeadGroup(stones);
  applyStateFromStore();
  return result;
},
```

這裡暫時呼叫 `applyStateFromStore()`，只為了讓尚未完成的 `main.js` 鏡像在此階段保持一致。Task 6 必須移除這兩個同步呼叫。

- [ ] **Step 6: 執行測試與靜態檢查**

Run:

```bash
npx jest tests/ai-controller.test.js --runInBand
npm test -- --runInBand
rg "app\.(GameState|applyStateFromStore)" ai-controller.js event-handlers.js
```

Expected:

- Jest 全部 PASS。
- `rg` 沒有結果。

- [ ] **Step 7: Commit**

```bash
git add ai-controller.js event-handlers.js main.js tests/ai-controller.test.js
git commit -m "refactor(go): 隔離子模組與狀態儲存"
```

---

### Task 4: 將 `main.js` 的讀取路徑改為直接讀取 `GameState`

**Files:**

- Modify: `main.js:46-170`
- Modify: `main.js:213-420`
- Modify: `main.js:930-1082`
- Modify: `main.js:1417-1429`

**Interfaces:**

- Consumes: `GameState.getState()`
- Produces internally: `getGoState()`
- Keeps temporarily: 核心狀態鏡像宣告與 `applyStateFromStore()`，供尚未遷移的寫入流程使用

- [ ] **Step 1: 新增唯一讀取 helper**

在：

```js
const GameState = GameStateModule;
```

後加入：

```js
function getGoState() {
  return GameState.getState();
}
```

- [ ] **Step 2: 將規則 wrapper 與 busy 判斷改為讀取 store**

改成：

```js
function inBounds(x, y) {
  return _inBounds(getGoState().size, x, y);
}

function getNeighbors(x, y) {
  return _getNeighbors(getGoState().size, x, y);
}

function getGroup(b, x, y) {
  return _getGroup(b, getGoState().size, x, y);
}

function tryPlaceStone(b, x, y, player, ko) {
  return _tryPlaceStone(b, getGoState().size, x, y, player, ko);
}

function getLegalMoves(b, player, ko) {
  return _getLegalMoves(b, getGoState().size, player, ko);
}

function isGameBlocked() {
  const state = getGoState();
  return state.gameOver || state.isReviewing || state.isScoring;
}

function isGameBusy() {
  return isGameBlocked() || getGoState().isAIThinking;
}
```

- [ ] **Step 3: 將 `app` getter 改為 store getter**

所有核心狀態 getter 改為：

```js
get size()              { return getGoState().size; },
get board()             { return getGoState().board; },
get currentPlayer()     { return getGoState().currentPlayer; },
get captures()          { return getGoState().captures; },
get moveHistory()       { return getGoState().moveHistory; },
get koPoint()           { return getGoState().koPoint; },
get passCount()         { return getGoState().passCount; },
get gameOver()          { return getGoState().gameOver; },
get gameMode()          { return getGoState().gameMode; },
get playerColor()       { return getGoState().playerColor; },
get aiLevel()           { return getGoState().aiLevel; },
get isAIThinking()      { return getGoState().isAIThinking; },
get timerEnabled()      { return getGoState().timerEnabled; },
get timerSeconds()      { return getGoState().timerSeconds; },
get gameRules()         { return getGoState().gameRules; },
get komi()              { return getGoState().komi; },
get isReviewing()       { return getGoState().isReviewing; },
get currentReviewMove() { return getGoState().currentReviewMove; },
get isScoring()         { return getGoState().isScoring; },
get deadStones()        { return getGoState().deadStones; },
```

- [ ] **Step 4: 改寫提示、形勢判斷與 render**

每個函式開頭取得狀態。例如 `requestMoveHint()`：

```js
const state = getGoState();
if (isGameBusy() || _suggestBusy) return;
if (state.gameMode === 'pvc' && state.currentPlayer !== state.playerColor) return;
```

傳給 KataGo 時使用同一個當下狀態：

```js
const result = await KataGo.suggest({
  board: state.board,
  size: state.size,
  currentPlayer: state.currentPlayer,
  moveHistory: state.moveHistory,
  komi: state.komi,
  gameRules: state.gameRules,
  onStatus: setStatus,
}, { visits: 24 });
```

將 `getCaptureHints()` 改成：

```js
function getCaptureHints(board, player) {
  const state = getGoState();
  return GoHints.getCaptureHints(board, state.size, player, state.koPoint);
}
```

在 `requestMoveHint()` 與 `requestPositionEstimate()` 發出非同步請求前記錄：

```js
const requestMoveCount = state.moveHistory.length;
const requestPlayer = state.currentPlayer;
```

請求完成後、套用 `suggestMove` 或 `liveOwnership` 前重新讀取：

```js
const latest = getGoState();
if (
  latest.moveHistory.length !== requestMoveCount
  || latest.currentPlayer !== requestPlayer
  || latest.gameOver
) {
  return;
}
```

這個 guard 只阻止過期分析結果覆蓋新盤面，不改變有效請求的顯示與文案。

刪除 `getCurrentStateSnapshot()`。`buildBoardViewState()` 改為：

```js
function buildBoardViewState() {
  const state = getGoState();
  const displayBoard = state.isReviewing
    ? GoReview.getReviewBoard(state.moveHistory, state.currentReviewMove, state.size)
    : state.board;
  const scoreData = state.isScoring
    ? calculateScore(
        state.board,
        state.size,
        state.deadStones,
        state.captures,
        state.gameRules,
        state.komi
      )
    : null;
  const captureHints = showingHint
    && !state.gameOver
    && !state.isReviewing
    && !state.isScoring
    && !state.isAIThinking
      ? getCaptureHints(state.board, state.currentPlayer)
      : [];
  const lastMove = state.isReviewing
    ? GoReview.getReviewLastMove(state.moveHistory, state.currentReviewMove)
    : state.lastMove;

  return {
    ...state,
    displayBoard,
    lastMove,
    scoreData,
    showingHint,
    captureHints,
    suggestMove,
    emotionEnabled,
    hoverPos,
    invalidFlash,
    ownership: (
      state.isReviewing
      && reviewOwnershipOn
      && reviewAnalysis
      && reviewAnalysis[state.currentReviewMove]
    )
      ? reviewAnalysis[state.currentReviewMove].ownership
      : (!state.isReviewing && !state.isScoring ? liveOwnership : null),
  };
}
```

- [ ] **Step 5: 改寫 UI 與覆盤讀取**

`updateUI()`：

```js
function updateUI() {
  const state = getGoState();
  const overlay = document.getElementById('aiThinkingOverlay');
  if (overlay) overlay.style.display = state.isAIThinking ? 'flex' : 'none';
  GoUI.updateHUD(state);
}
```

`syncStatus()`：

```js
function syncStatus(message = '') {
  GoUI.syncStatus(getGoState(), message);
}
```

`updateReviewInfo()` 與 `onWinrateGraphClick()` 都在函式入口取得 `state`，改用 `state.currentReviewMove`、`state.moveHistory` 與 `state.size`。

- [ ] **Step 6: 改寫 inline handler getter**

```js
Object.defineProperty(window, 'currentReviewMove', {
  get() { return getGoState().currentReviewMove; },
  configurable: true
});

Object.defineProperty(window, 'moveHistory', {
  get() { return getGoState().moveHistory; },
  configurable: true
});
```

- [ ] **Step 7: 執行全套測試與 bundle 驗證**

Run:

```bash
npm test -- --runInBand
npx vite build
```

Expected: PASS，Vite build exit code 0。

- [ ] **Step 8: 檢查本階段沒有直接寫入 store 回傳值**

Run:

```bash
rg "getGoState\(\)\.[A-Za-z0-9_]+\s*=" main.js
```

Expected: 沒有結果。

- [ ] **Step 9: Commit**

```bash
git add main.js
git commit -m "refactor(go): 直接讀取核心對局狀態"
```

---

### Task 5: 遷移操作、數目、覆盤與非同步流程

**Files:**

- Modify: `main.js:435-1065`

**Interfaces:**

- Consumes: `GameState.setAIThinking(value)`
- Consumes: `GameState.setAiLevel(level)`
- Consumes: `GameState.setDeadStones(stones)`
- Consumes: `GameState.markGameOver()`
- Consumes: `GameState` 既有領域操作
- Retains temporarily: `applyStateFromStore()`，只供尚未遷移的新局與載入流程使用

- [ ] **Step 1: 遷移落子、虛手、悔棋與認輸**

每個操作在 mutation 前後分別讀取需要的狀態。

`placeStone()` 的主要結構改為：

```js
function placeStone(x, y) {
  const before = getGoState();
  if (isGameBlocked()) return false;
  if (before.isAIThinking && before.gameMode === 'pvc') return false;

  const result = GameState.applyMove(x, y);
  if (!result.ok) {
    flashInvalid(x, y);
    showToast(invalidMoveReasonText(result.reason));
    playSfx('invalid-move');
    return false;
  }

  showingHint = false;
  suggestMove = null;
  liveOwnership = null;

  const after = getGoState();
  updateUI();
  const willRequestAI = after.gameMode === 'pvc'
    && after.currentPlayer !== after.playerColor
    && !after.gameOver;
  syncStatus(willRequestAI ? 'AI 思考中...' : '');
  drawBoard();
  playSfx('stone-place');
  if (result.captured > 0) setTimeout(() => playSfx('stone-capture'), 80);
  if (after.timerEnabled) switchTimer();
  saveGame();
  if (willRequestAI) {
    setTimeout(() => aiController.requestAIMove(), AI_MOVE_DELAY_MS);
  }
  return true;
}
```

`doPass()` 改為：

```js
function doPass() {
  if (isGameBusy()) return;

  showingHint = false;
  suggestMove = null;
  liveOwnership = null;

  const result = GameState.applyPass();
  if (!result.ok) return;
  playSfx('pass');

  if (result.endedByDoublePass) {
    endGameByScoring();
    return;
  }

  const state = getGoState();
  updateUI();
  const willRequestAI = state.gameMode === 'pvc'
    && state.currentPlayer !== state.playerColor
    && !state.gameOver;
  const aiJustPassed = state.gameMode === 'pvc'
    && !willRequestAI
    && state.currentPlayer === state.playerColor
    && !state.gameOver;

  if (aiJustPassed) {
    setStatus('AI 虛手了 \u2014 你也虛手即可數目，或按「申請數目」直接計算結果');
    showToast('電腦虛手（Pass）');
  } else {
    syncStatus(willRequestAI ? 'AI 思考中...' : '');
    if (state.passCount === 1) {
      showToast('再虛手一次將進入數目');
    }
  }

  drawBoard();
  if (state.timerEnabled) switchTimer();
  saveGame();
  if (willRequestAI) {
    setTimeout(() => aiController.requestAIMove(), AI_MOVE_DELAY_MS);
  }
}
```

`doUndo()` 使用：

```js
const state = getGoState();
if (state.boardHistory.length === 0) return;
const result = GameState.undo({ gameMode: state.gameMode });
```

`doResign()` 使用 mutation 前取得的 `state.currentPlayer` 與 `state.playerColor`。

- [ ] **Step 2: 遷移自適應難度**

將 `saveAiLevel()` 改成接收明確參數：

```js
function saveAiLevel(level) {
  try { localStorage.setItem(AI_LEVEL_KEY, String(level)); } catch (_) {}
}
```

`applyResultToLevel()`：

```js
function applyResultToLevel(humanMargin) {
  const state = getGoState();
  if (state.gameMode !== 'pvc') return;
  const result = nextLevelForMode(state.aiLevel, humanMargin, aiLevelMode);
  GameState.setAiLevel(result.level);
  saveAiLevel(result.level);
  updateAiLevelDisplay();
  if (result.change === 'up') {
    _pendingLevelMsg = `你贏得漂亮！電腦升到第 ${result.level} 級（${kyuLabel(result.level)}）`;
  } else if (result.change === 'down') {
    _pendingLevelMsg = `電腦降到第 ${result.level} 級（${kyuLabel(result.level)}），調整步調再來`;
  } else if (aiLevelMode === 'manual') {
    _pendingLevelMsg = `電腦固定第 ${result.level} 級（${kyuLabel(result.level)}，手動選級）`;
  } else {
    _pendingLevelMsg = `電腦維持第 ${result.level} 級（${kyuLabel(result.level)}）`;
  }
}
```

`resetAiLevel()` 使用 `GameState.setAiLevel(MIN_LEVEL)`，並將 `MIN_LEVEL` 傳給 `saveAiLevel()`。

`updateAiLevelDisplay()` 與 `initAiLevelControls()` 直接讀取 `getGoState().aiLevel`。

- [ ] **Step 3: 遷移數目流程**

`deadStonesFromOwnership()`、`showScoringResultModal()`、`updateScoringDisplay()`、`countNeutralEmpty()`、`applyUnfinishedWarning()` 與 `confirmScoring()` 都在函式入口取得 `state`。

KataGo 數目完成後，重新確認模式：

```js
const latest = getGoState();
if (!latest.isScoring) return;
```

將：

```js
GameState.sync({ deadStones: Array.from(dead) });
applyStateFromStore();
```

改為：

```js
GameState.setDeadStones(dead);
```

將 `endGame()` 開頭的：

```js
gameOver = true;
```

改為：

```js
GameState.markGameOver();
const state = getGoState();
```

後續摘要、戰績與畫面判斷全部使用 `state`。

- [ ] **Step 4: 遷移覆盤與練習模式**

移除 `enterReview()`、`exitReview()`、`reviewGo()`、`replayFromHere()`、`returnToOriginal()` 中所有 `applyStateFromStore()`。

每個操作後重新讀取 `state`。`analyzeReview()` 在每次 `await KataGo.evaluate()` 後確認：

```js
if (!getGoState().isReviewing) return;
```

不得將分析開始前的 `state` 物件用於分析完成後的模式判斷。

- [ ] **Step 5: 遷移 SGF 與 timeout**

`exportSGF()` 只讀取一次當下狀態：

```js
const state = getGoState();
const handicapStones = state.handicap >= 2
  ? handicapPoints(state.size, state.handicap)
  : [];
const sgf = buildSGF(state.moveHistory, state.size, state.komi, handicapStones);
```

`_timerOnTimeout()` 使用最新的 `playerColor`：

```js
const state = getGoState();
applyResultToLevel(winner === state.playerColor ? 30 : -30);
```

- [ ] **Step 6: 移除 façade 中暫時同步鏡像的行為**

`app` 中的操作改為：

```js
setAIThinking: (value) => GameState.setAIThinking(value),
toggleDeadGroup: (stones) => GameState.toggleDeadGroup(stones),
```

- [ ] **Step 7: 執行完整測試與建置**

Run:

```bash
npm test -- --runInBand
npx vite build
```

Expected: PASS，Vite build exit code 0。

- [ ] **Step 8: 檢查已遷移區段沒有鏡像同步**

Run:

```bash
rg -n "applyStateFromStore|GameState\.sync" main.js
```

Expected: 只剩新局、儲存、載入附近的暫時使用，不得出現在操作、數目、覆盤或 AI 流程。

- [ ] **Step 9: Commit**

```bash
git add main.js
git commit -m "refactor(go): 遷移核心操作至單一狀態來源"
```

---

### Task 6: 遷移初始化與持久化，移除鏡像和 `sync()`

**Files:**

- Modify: `main.js:46-76`
- Modify: `main.js:1084-1255`
- Modify: `game-state.js:165-210`
- Modify: `game-state.js:363-369`
- Modify: `tests/game-state.test.js:115-155`
- Modify: `tests/game-state.test.js:205-220`
- Modify: `tests/game-state.test.js:430-460`

**Interfaces:**

- Removes: `main.js` 核心狀態鏡像
- Removes: `applyStateFromStore()`
- Removes: `GameState.sync(partialState)`
- Preserves: `getSnapshot()` 格式
- Preserves: `restoreSnapshot(snapshot)` 相容性

- [ ] **Step 1: 先將測試 fixture 移出 `sync()`**

自殺手測試改成：

```js
const board = GoRules.createBoard(9);
board[0][1] = WHITE;
board[1][0] = WHITE;
GameState.resetState({ size: 9, board, currentPlayer: BLACK });
```

打劫測試改成：

```js
GameState.resetState({ size: 7, board: b, currentPlayer: BLACK });
```

虛手清除劫點測試改成：

```js
GameState.resetState({ size: 9, koPoint: [3, 3] });
```

刪除完整的 `describe('sync', ...)` 測試區塊。

- [ ] **Step 2: 暫時執行狀態測試，確認正式程式碼尚未受影響**

Run:

```bash
npx jest tests/game-state.test.js --runInBand
```

Expected: PASS。此時 `sync()` 尚未從來源移除。

- [ ] **Step 3: 將 `startNewGame()` 改成局部設定物件**

不得再對核心欄位賦值。將 `startNewGame()` 開頭的設定蒐集區改成：

```js
const rawSize = parseInt(document.getElementById('boardSize').value);
const selectedSize = VALID_BOARD_SIZES.includes(rawSize) ? rawSize : 19;

const rawMode = document.getElementById('gameMode').value;
const selectedMode = VALID_GAME_MODES.includes(rawMode) ? rawMode : 'pvc';

let selectedPlayerColor = parseInt(document.getElementById('playerColor').value);
const levelModeElement = document.getElementById('aiLevelMode');
aiLevelMode = (
  levelModeElement
  && levelModeElement.value === 'manual'
  && premiumUnlocked()
) ? 'manual' : 'auto';
saveAiLevelMode();

let selectedAiLevel;
if (aiLevelMode === 'manual') {
  const manualLevel = parseInt(document.getElementById('aiManualLevel')?.value);
  selectedAiLevel = levelConfig(
    Number.isFinite(manualLevel) ? manualLevel : MIN_LEVEL
  ).level;
  saveAiLevel(selectedAiLevel);
} else {
  selectedAiLevel = loadAiLevel();
}

const selectedTimerEnabled = document.getElementById('timerToggle').checked;
const selectedRules = document.getElementById('gameRules').value;
let selectedKomi = selectedRules === 'japanese' ? 6.5 : 7.5;

const handicapElement = document.getElementById('handicap');
let handicap = handicapElement ? parseInt(handicapElement.value) || 0 : 0;
if (selectedMode !== 'pvc' || handicap < 2) handicap = 0;

let handicapBoard;
let handicapFirstPlayer;
if (handicap >= 2) {
  selectedPlayerColor = BLACK;
  handicapBoard = placeHandicap(selectedSize, handicap);
  handicapFirstPlayer = WHITE;
  selectedKomi = 0.5;
}

const nextGame = {
  size: selectedSize,
  gameMode: selectedMode,
  playerColor: selectedPlayerColor,
  aiLevel: selectedAiLevel,
  timerEnabled: selectedTimerEnabled,
  timerSeconds: { [BLACK]: 600, [WHITE]: 600 },
  gameRules: selectedRules,
  komi: selectedKomi,
  handicap,
  board: handicapBoard,
  currentPlayer: handicapFirstPlayer,
};
```

接著：

```js
GameState.startGame(nextGame);
updateAiLevelDisplay();
```

之後直接讀取：

```js
const state = getGoState();
```

不得再呼叫 `applyStateFromStore()`。

在本任務結束前執行：

```bash
rg -n "saveAiLevel\(\)" main.js
```

Expected: 沒有零參數的 `saveAiLevel()` 呼叫。

- [ ] **Step 4: 遷移 `saveGame()`**

改成：

```js
function saveGame() {
  const state = getGoState();
  if (state.isReviewing || state.isScoring) return;
  if (state.timerEnabled) GoTimer.sync();
  const snapshot = GameState.getSnapshot();
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(snapshot));
  } catch (_) {}
}
```

- [ ] **Step 5: 遷移 `loadGame()`**

恢復後立即使用 store：

```js
GameState.restoreSnapshot(saved);
GameState.setAiLevel(loadAiLevel());
const state = getGoState();
```

`GameState.setAiLevel(loadAiLevel())` 必須保留目前行為。現有程式在載入後會以跨對局的 `gogame_ai_level` 更新實際對戰等級，不能因移除鏡像而改成使用舊 snapshot 內的等級。

所有表單同步、恢復訊息、AI 排程與計時判斷改用 `state`。

- [ ] **Step 6: 移除 `main.js` 核心鏡像**

刪除：

```js
let komi = 7.5;
let gameRules = 'chinese';
let size = 19;
let board = [];
let currentPlayer = BLACK;
let captures = { [BLACK]: 0, [WHITE]: 0 };
let moveHistory = [];
let boardHistory = [];
let koPoint = null;
let passCount = 0;
let gameOver = false;
let gameMode = 'pvc';
let playerColor = BLACK;
let aiLevel = loadAiLevel();
let isAIThinking = false;
let timerEnabled = false;
let timerSeconds = { [BLACK]: 600, [WHITE]: 600 };
let isReviewing = false;
let currentReviewMove = 0;
let isScoring = false;
let deadStones = new Set();
let lastMove = null;
```

刪除完整的 `applyStateFromStore()`。

將 Task 2 的暫時 timer setter：

```js
setTimerSeconds: (seconds) => {
  GameState.setTimerSeconds(seconds);
  timerSeconds = { ...GameState.getState().timerSeconds };
},
```

改成最終形式：

```js
setTimerSeconds: (seconds) => GameState.setTimerSeconds(seconds),
```

初始化 `GameState` 後，將跨對局 AI 等級套入初始 store：

```js
GameState.setAiLevel(loadAiLevel());
```

- [ ] **Step 7: 從 `game-state.js` 移除 `sync()`**

刪除 `sync(partialState)` 函式，並從 `GameState` export 物件移除 `sync`。

- [ ] **Step 8: 執行靜態完成檢查**

Run:

```bash
rg "applyStateFromStore" main.js ai-controller.js event-handlers.js
rg "GameState\.sync" main.js ai-controller.js event-handlers.js tests
rg "^let (komi|gameRules|size|board|currentPlayer|captures|moveHistory|boardHistory|koPoint|passCount|gameOver|gameMode|playerColor|aiLevel|isAIThinking|timerEnabled|timerSeconds|isReviewing|currentReviewMove|isScoring|deadStones|lastMove)\b" main.js
rg "^[[:space:]]*(komi|gameRules|size|board|currentPlayer|captures|moveHistory|boardHistory|koPoint|passCount|gameOver|gameMode|playerColor|aiLevel|isAIThinking|timerEnabled|timerSeconds|isReviewing|currentReviewMove|isScoring|deadStones|lastMove)[[:space:]]*=" main.js
rg "getGoState\(\)\.[A-Za-z0-9_]+\s*=" main.js
```

Expected: 五個指令都沒有結果。

- [ ] **Step 9: 執行完整測試**

Run:

```bash
npm test -- --runInBand
```

Expected: 所有既有與新增測試 PASS。

- [ ] **Step 10: 驗證 Web 與 iOS bundle**

Run:

```bash
npx vite build
npx vite build --mode ios
node scripts/strip-ios-assets.mjs
```

Expected:

- 三個指令 exit code 0。
- iOS 合規檢查顯示 bundle 無 Fairy-Stockfish 或 ffish 殘留。
- `git status --short` 不出現版本檔案或其他來源檔案變更。

- [ ] **Step 11: Commit**

```bash
git add main.js game-state.js tests/game-state.test.js
git commit -m "refactor(go): 移除核心狀態鏡像"
```

---

### Task 7: 瀏覽器回歸與最終盤查

**Files:**

- Verify only: `main.js`
- Verify only: `game-state.js`
- Verify only: `timer.js`
- Verify only: `ai-controller.js`
- Verify only: `event-handlers.js`
- Verify only: `tests/game-state.test.js`
- Verify only: `tests/timer.test.js`
- Verify only: `tests/ai-controller.test.js`

**Interfaces:**

- Consumes: 完成後的圍棋單一狀態來源
- Produces: 實機 smoke test 紀錄與最終驗證結果

- [ ] **Step 1: 啟動開發伺服器**

Run:

```bash
npm run dev -- --host 127.0.0.1
```

Expected: Vite 顯示本機網址，瀏覽器 console 沒有啟動錯誤。

- [ ] **Step 2: 驗證未計時基本流程**

在 `#play` 依序驗證：

1. 開始 9 路 PvC 新局。
2. 玩家落子後 AI 正常應手。
3. 玩家虛手後 AI 正常回應。
4. 悔棋回到正確回合與盤面。
5. 重新整理頁面後恢復未完成棋局。
6. 認輸後顯示結果，且棋盤不再接受落子。

Expected: 每一步行為與重構前一致，console 沒有 error。

- [ ] **Step 3: 驗證數目與覆盤**

依序驗證：

1. 進行數手後按「申請數目」。
2. KataGo 數目完成後顯示結果。
3. 點擊死子可切換標記。
4. 取消數目後可繼續落子。
5. 再次數目並確認結果。
6. 進入覆盤，使用前一手、下一手、最初與最新。
7. 從覆盤位置重新練習。
8. 返回原始棋譜。

Expected: 畫面、狀態文字、盤面與棋譜位置一致。

- [ ] **Step 4: 驗證計時**

依序驗證：

1. 開新局並啟用計時。
2. 玩家落子後，玩家時間定格、AI 方開始走鐘。
3. AI 落子後，AI 時間定格、玩家方開始走鐘。
4. 切到背景分頁數秒後回來，時間依真實經過秒數扣除。
5. 重新整理並恢復棋局，剩餘時間與儲存值一致。

Expected: 沒有計時倒退、雙方同時走鐘或停鐘失效。

- [ ] **Step 5: 驗證 AI 失敗恢復**

使用瀏覽器開發工具暫時切成離線，或阻擋 KataGo Worker 載入，再觸發 AI 回合。

Expected:

- 顯示既有錯誤與重試訊息。
- watchdog 與重試完成後，`isAIThinking` 會解除。
- 使用者不會永久卡在無法悔棋、認輸或開始新局的狀態。

- [ ] **Step 6: 驗證桌機與手機寬度**

至少使用：

- 桌機：寬度 1440 px。
- 手機：寬度 390 px。

Expected: 棋盤、狀態列、功能列與 modal 沒有新的版面 regression。

- [ ] **Step 7: 執行最終自動驗證**

Run:

```bash
npm test -- --runInBand
npx vite build
npx vite build --mode ios
node scripts/strip-ios-assets.mjs
git diff --check
git status --short --branch
```

Expected:

- 所有測試 PASS。
- Web 與 iOS bundle 成功。
- iOS GPL 合規檢查通過。
- `git diff --check` 沒有輸出。
- 工作目錄乾淨。

- [ ] **Step 8: 最終完成條件盤查**

Run:

```bash
rg "applyStateFromStore" main.js ai-controller.js event-handlers.js
rg "GameState\.sync" main.js ai-controller.js event-handlers.js tests
rg "^let (komi|gameRules|size|board|currentPlayer|captures|moveHistory|boardHistory|koPoint|passCount|gameOver|gameMode|playerColor|aiLevel|isAIThinking|timerEnabled|timerSeconds|isReviewing|currentReviewMove|isScoring|deadStones|lastMove)\b" main.js
rg "^[[:space:]]*(komi|gameRules|size|board|currentPlayer|captures|moveHistory|boardHistory|koPoint|passCount|gameOver|gameMode|playerColor|aiLevel|isAIThinking|timerEnabled|timerSeconds|isReviewing|currentReviewMove|isScoring|deadStones|lastMove)[[:space:]]*=" main.js
```

Expected: 四個指令都沒有結果。

若 smoke test 發現問題，先依問題類型掃描整個圍棋流程的同類實例，回到對應 Task 修正並重新執行該 Task 與最終驗證。不要在此任務建立範圍外重構。
