# 圍棋核心狀態單一來源設計

## 背景

目前圍棋對局以 `game-state.js` 保存核心狀態，但 `main.js` 同時宣告一組同名可變變數，並在每次 `GameState` 操作後透過 `applyStateFromStore()` 複製狀態。

這會形成兩份執行期表示：

1. `game-state.js` 內的正式狀態。
2. `main.js` 內供 UI、AI、計時與操作流程使用的鏡像。

任何流程只要漏掉同步，畫面、AI 判斷、存檔與正式狀態就可能不一致。本次重構要讓 `GameState` 成為圍棋核心對局狀態的唯一來源，同時保留現有的原生 JavaScript 架構與明確 render 流程。

## 目標

- `GameState` 成為圍棋核心對局狀態的唯一來源。
- 移除 `main.js` 的核心狀態鏡像與 `applyStateFromStore()`。
- 所有核心狀態寫入都使用語意明確的 `GameState` 操作。
- `ai-controller.js` 與 `event-handlers.js` 只透過 `app` context 使用所需狀態與操作。
- 保持現有棋規、AI 行為、畫面流程、存檔格式與跨平台建置方式不變。
- 使用分階段、可測試、可獨立提交的方式完成遷移。

## 非目標

- 不導入 Redux、Proxy、事件匯流排或其他 reactive store。
- 不重構其他棋類的獨立狀態管理。
- 不重新設計圍棋 UI、Canvas 渲染或 HTML 結構。
- 不改變 `gogame_state` 的 `localStorage` 格式。
- 不調整棋規、AI 強度、自適應難度演算法或付費權益。
- 不順便拆分 `main.js` 的其他非狀態職責。

## 採用方案

採用漸進式直接讀取 `GameState`。

`main.js` 透過單一讀取函式取得當下狀態：

```js
function getGoState() {
  return GameState.getState();
}
```

每個需要多次使用狀態的函式，在函式入口取得當下狀態。跨越 `await`、計時器或其他非同步邊界後，必須重新讀取，不得假設先前取得的狀態仍然有效。

不採用 Proxy，避免把隱藏式轉送留在核心流程中。不導入訂閱式 store，避免把這次重構擴大為狀態管理框架改造。

## 狀態歸屬

### `GameState` 管理

以下欄位是圍棋核心狀態，唯一來源為 `game-state.js`：

- 棋盤：`size`、`board`、`currentPlayer`
- 棋局紀錄：`moveHistory`、`boardHistory`、`lastMove`
- 規則狀態：`captures`、`koPoint`、`passCount`
- 對局設定：`gameMode`、`playerColor`、`gameRules`、`komi`、`handicap`
- AI 狀態：`aiLevel`、`isAIThinking`
- 計時狀態：`timerEnabled`、`timerSeconds`
- 對局階段：`gameOver`、`isScoring`、`deadStones`
- 覆盤狀態：`isReviewing`、`currentReviewMove`

`main.js` 不得再宣告這些同名可變變數。

### `main.js` 保留

以下內容是暫時性 UI、執行中工作或跨對局偏好，不放入核心 store：

- `showingHint`
- `suggestMove`
- `liveOwnership`
- `_suggestBusy`
- `_estimateBusy`
- `invalidFlash`
- `_invalidFlashTimer`
- `_drawRaf`
- `_toastTimer`
- Canvas、`ctx`、`cellSize`、`padding`、`hoverPos`
- `reviewAnalysis`、`reviewAnalyzing`、`reviewOwnershipOn`
- `savedOriginalGame`
- `_pendingLevelMsg`
- `_lastOwnership`
- `emotionEnabled`
- `aiLevelMode`

`aiLevelMode` 是跨對局的使用者偏好，維持由 `localStorage` 管理。當前棋局實際使用的 `aiLevel` 則由 `GameState` 管理。

#### `aiLevel` 有兩個持久化家，這是刻意設計

`aiLevel` 同時出現在兩個 `localStorage` key，在一份標題是「單一狀態來源」的文件裡容易被誤讀成漏改，這裡明確記下：

- `gogame_ai_level`（`AI_LEVEL_KEY`）是**權威來源**。它是跨對局偏好，由 `loadAiLevel()` 讀、`saveAiLevel()` 寫，與 `aiLevelMode` 同一類，不屬於單局狀態。
- `gogame_state`（`SAVE_KEY`）裡的 `snapshot.aiLevel` **寫得出、讀不到**。`getSnapshot()` 仍輸出這個欄位（維持已上架版本的 snapshot 格式，不做 migration），但 `loadGame()` 在 `restoreSnapshot(s)` 之後會立刻用 `GameState.setAiLevel(loadAiLevel())` 覆蓋掉它。

換句話說：`GameState.aiLevel` 作為「當前對局使用的等級」這個**執行期**狀態的單一來源沒有例外；但它的**持久化**歸 `gogame_ai_level` 管，`snapshot.aiLevel` 只是為了格式相容而保留的殘留欄位。恢復對局時等級跟著使用者偏好走，而不是跟著那一局存檔當下的值走，才符合「等級是跨對局偏好」的語意。

連帶結論：`loadAiLevel()` 是 `GameState.aiLevel` 的主要來源（開機、開新局的自動模式、恢復對局都經過它），因此合法範圍的夾值放在 `loadAiLevel()`，而不是放在每一處把等級寫進控制項的地方。

## 讀取介面

`main.js` 的 render、操作、儲存與路由流程直接讀取 `GameState.getState()`。

`app` context 的狀態 getter 也直接讀取 `GameState`：

```js
get board() {
  return getGoState().board;
}
```

`window.currentReviewMove` 與 `window.moveHistory` 的 getter 改為直接讀取 `GameState`，維持既有 inline `onclick` 相容性。

`GameState.getState()` 回傳的內容只供讀取。正式程式碼不得直接改寫回傳物件或其巢狀資料。

## 寫入介面

既有領域操作維持：

- `startGame()`
- `applyMove()`
- `applyPass()`
- `undo()`
- `beginScoring()`
- `cancelScoring()`
- `confirmScoring()`
- `toggleDeadGroup()`
- `enterReview()`
- `exitReview()`
- `reviewGo()`
- `restoreSnapshot()`

新增語意明確的狀態操作：

- `setAIThinking(value)`
- `setAiLevel(level)`
- `setTimerSeconds(seconds)`
- `setDeadStones(stones)`
- `markGameOver()`

`setTimerSeconds()` 必須複製傳入物件，避免外部持有可直接修改 store 的參照。

`setDeadStones()` 必須把傳入的陣列、集合或可迭代值轉成新的 `Set`。

`markGameOver()` 必須將 `gameOver` 設為 `true`，並將 `isAIThinking` 設為 `false`，確保終局後不會保留操作鎖。

完成所有正式消費者遷移後，移除泛用的 `sync(partialState)` 與其測試，避免留下任意改寫 store 的後門。

## 子模組邊界

`ai-controller.js` 與 `event-handlers.js` 不再直接取得 `GameState`。

`app` context 提供它們實際需要的操作：

```js
app.setAIThinking(true);
app.toggleDeadGroup(group.stones);
app.placeStone(x, y);
app.doPass();
```

移除：

- `app.GameState`
- `app.applyStateFromStore`

子模組仍可透過 `app` 的 getter 讀取棋盤、回合、模式與 AI 狀態，但不得知道 store 的內部實作。

## 計時器設計

`timer.js` 目前直接修改傳入的 `timerSeconds` 物件。重構後改用 callback 讀寫：

- 透過 callback 取得最新剩餘秒數。
- 每次同步時間時建立新的秒數物件。
- 透過 callback 呼叫 `GameState.setTimerSeconds()`。
- interval、時間戳、當前走鐘方與 timeout callback 仍由 `timer.js` 管理。

計時器不得持有可直接修改核心 store 的物件參照。

計時器必須維持目前的 wall-clock 語意。瀏覽器背景節流後，剩餘秒數仍依真實經過時間計算，而不是依 tick 次數扣除。

## 資料流

```text
使用者或 AI 操作
    ↓
GameState 語意操作
    ↓
main.js 重新讀取當下狀態
    ↓
更新 UI、儲存快照、安排下一個非同步操作
```

本次仍使用明確的 `updateUI()`、`drawBoard()`、`syncStatus()` 與 `saveGame()` 呼叫，不加入自動訂閱或自動 render。

## 非同步與競態

- AI 啟動時透過 `setAIThinking(true)` 鎖定操作。
- AI 成功、失敗或 watchdog 逾時後都必須釋放 `isAIThinking`。
- AI 回傳後重新讀取當下狀態，不使用請求開始前保存的棋盤參照。
- 既有防重入、watchdog、引擎重設、重試與錯誤恢復行為全部保留。
- 排程 AI 前的狀態提示使用明確訊息，不再暫時改寫本地 `isAIThinking` 來影響 UI。
- 數目或覆盤的非同步結果套用前，重新確認目前仍處於對應模式。
- `GameState` 操作完成後不需要同步複製，只需要依流程更新畫面與存檔。

## 儲存與相容性

- `getSnapshot()` 的輸出格式保持不變。
- `restoreSnapshot()` 繼續接受既有儲存資料。
- 舊資料缺少非必要欄位時，沿用目前的預設值。
- 儲存前先讓計時器定格最新剩餘秒數，再直接取得 `GameState` snapshot。
- `gogame_state` key 保持不變。
- HTML 暴露的全域函式名稱保持不變。
- Web、PWA、iOS 與 Android 的建置分流保持不變。

## 遷移順序

### 階段 1：補齊 `GameState` API

新增語意操作及單元測試。此階段先保留既有鏡像，確保變更能獨立驗證。

### 階段 2：調整計時器

改用 callback 讀寫 `timerSeconds`，補齊初始化、倒數、切換回合、背景節流、停鐘與超時測試。

### 階段 3：清除子模組對 store 的直接依賴

修改 `ai-controller.js`、`event-handlers.js` 與 `app` context，移除 `app.GameState` 和 `app.applyStateFromStore`。

### 階段 4：逐區替換 `main.js`

依序遷移：

1. 畫面 render 與狀態文字。
2. 落子、虛手、悔棋與認輸。
3. 數目與死子。
4. 計時。
5. 覆盤與練習模式。
6. 自適應難度。
7. SGF 匯出。
8. 新局、儲存與恢復。
9. `window.currentReviewMove` 與 `window.moveHistory`。

每一區完成後執行相關測試。跨越非同步邊界的函式必須重新取得狀態。

### 階段 5：移除鏡像與泛用同步

移除：

- `main.js` 頂端的核心狀態變數。
- `applyStateFromStore()`。
- `app.applyStateFromStore`。
- `app.GameState`。
- 正式程式碼中的 `GameState.sync()`。
- `GameState.sync()` 與其測試。

## 測試策略

### `tests/game-state.test.js`

驗證：

- `setAIThinking()` 只修改 AI 狀態。
- `setAiLevel()` 正確更新當前等級。
- `setTimerSeconds()` 不共用外部可變物件。
- `setDeadStones()` 建立新的 `Set`。
- `markGameOver()` 結束棋局並釋放 AI 狀態。
- Snapshot 與 restore 往返後一致。
- 舊版儲存資料缺少非必要欄位時仍可恢復。

### `tests/timer.test.js`

驗證：

- 初始化時間。
- 真實時間倒數。
- 切換回合。
- 背景節流。
- 停鐘定格。
- 超時 callback。
- 每次更新都透過寫入 callback。

### `tests/ai-controller.test.js`

驗證：

- AI 開始時設為思考中。
- 正常完成後解除。
- 引擎失敗後解除。
- watchdog 逾時後解除。
- 重複請求仍會被阻擋。
- 測試不再需要 `GameState` 或 `applyStateFromStore` mock。

### 全套驗證

```bash
npm test -- --runInBand
npx vite build
npx vite build --mode ios
node scripts/strip-ios-assets.mjs
```

使用 `npx vite build`，避免 `generate-version.js` 在驗證期間改寫追蹤中的版本檔案。

### 瀏覽器 smoke test

桌機與手機寬度各驗證：

- 開始新局。
- 玩家落子後 AI 應手。
- 玩家虛手與 AI 虛手。
- 悔棋。
- 認輸。
- 申請數目與修正死子。
- 儲存後重新整理並恢復。
- 終局覆盤。
- 從覆盤位置重新練習。
- 開啟計時後切換回合。
- AI 失敗後操作不會被永久鎖住。

## 靜態完成條件

以下搜尋必須沒有結果：

```bash
rg "applyStateFromStore" main.js ai-controller.js event-handlers.js

rg "GameState\.sync" main.js ai-controller.js event-handlers.js

rg "^let (komi|gameRules|size|board|currentPlayer|captures|moveHistory|boardHistory|koPoint|passCount|gameOver|gameMode|playerColor|aiLevel|isAIThinking|timerEnabled|timerSeconds|isReviewing|currentReviewMove|isScoring|deadStones|lastMove)\b" main.js
```

## 完成標準

- `GameState` 是圍棋核心狀態唯一來源。
- `main.js` 不再持有核心狀態鏡像。
- 所有既有測試與新增測試通過。
- Web 與 iOS 模式建置通過。
- 舊棋局可正常恢復。
- 圍棋的操作行為、棋規與 UI 不變。
- 其他棋類沒有被修改。
- Git diff 只包含本次狀態重構需要的檔案。
