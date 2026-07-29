# 圍棋單一狀態來源重構 Handoff

更新時間：2026-07-29
目前狀態：**已完成並合併到 `main`，已 push。** 本文件保留作為 follow-up 清單與驗證紀錄。

## 目標

將圍棋核心對局狀態收斂到 `GameState` 單一來源，移除 `main.js` 的核心狀態鏡像與 `GameState.sync()`，並完成瀏覽器回歸、程式碼審查與分支收尾。

使用者已明確要求採用 subagent 驅動方式執行。

## 工作位置

- Repo：
  `/Users/hd/WORK/case/gogame/gogame-src`
- 已合併到 `main`，HEAD 與 `origin/main` 皆為
  `cb0c8d4` — `fix(go): 進入數目時同步更新資訊列`
- 原實作 branch `refactor/go-single-state-source`：已 fast-forward merge 後刪除。
- 原實作 worktree `.worktrees/go-single-state-source`：已移除。
- branch 基準：
  `2abd1cc`
- SDD workspace（依指示保留，已從 worktree 複製到主 repo）：
  `.superpowers/sdd/2026-07-28-go-single-state-source/`（git-ignored，42 個檔案）
- SDD ledger：
  `.superpowers/sdd/2026-07-28-go-single-state-source/progress.md`

## 規格與計畫

- 設計：
  `docs/superpowers/specs/2026-07-28-go-single-state-source-design.md`
- 實作計畫：
  `docs/superpowers/plans/2026-07-28-go-single-state-source.md`

## 完整 commit 清單，14 個

```text
16af0c6 refactor(go): 新增明確狀態寫入介面
44fea05 refactor(go): 讓計時器經由狀態介面寫入
e10237c refactor(go): 隔離子模組與狀態儲存
206d004 refactor(go): 直接讀取核心對局狀態
92f1dc1 fix(go): 丟棄過期盤面分析結果
cef0c86 refactor(go): 遷移核心操作至單一狀態來源
054d9c2 fix(go): 修正新局確認與 AI 等級同步
47885f0 refactor(go): 移除核心狀態鏡像
9ae52c9 fix(go): 補齊計時生命週期同步
1a896ca fix(go): 修正計時持久化邊界
4a486ed fix(go): 修正雙虛手後的回合歸屬
ef56cc2 fix(go): 手番回到 AI 時喚醒 AI 求手
76d14a0 fix(go): 修正取消數目的回合顯示與新局計時殘值
cb0c8d4 fix(go): 進入數目時同步更新資訊列
```

Task 1 至 Task 7 全部完成，每一項都經過獨立唯讀 review。

## 已達成的核心結果

- `GameState` 已成為圍棋核心狀態唯一來源。
- `main.js` 的核心狀態鏡像已移除，`applyStateFromStore()` 已移除。
- `GameState.sync()` 與相關測試已移除。
- `getSnapshot()` 格式與 `restoreSnapshot()` 相容性維持不變。
- 計時器使用 callback 讀寫 `GameState`。
- AI controller 與 event handler 不再直接存取 store。
- 非同步盤面分析有 board identity 過期結果防護。

過程中順帶修好的既有缺陷：

- `applyPass()` 雙虛手不換手，導致 `replayFromHere()` 重播含雙虛手的棋譜前綴時，其後落子會被記成錯誤顏色。
- `cancelScoring()` 與 `doUndo()` 在手番回到 AI 時不會喚醒 AI 求手，PvC 會停住無人推進。
- `startNewGame()` 的 `stopTimer()` 排序把上一局殘餘秒數寫進新局狀態與 snapshot。

## 驗證證據，請注意各項是在哪個 commit 跑的

| 驗證項目 | 範圍／commit | 結果 |
|---|---|---|
| Whole-branch final review | `2abd1cc..ef56cc2`，opus | 無 Critical，1 Important，判定可合併 |
| Fix wave scoped re-review | `ef56cc2..76d14a0`，opus | 無阻擋項，判定可合併 |
| 完整瀏覽器 smoke，14 項 | 在 `ef56cc2` 執行 | 14／14 PASS |
| 針對性瀏覽器複驗，3 項 | 在 `76d14a0` 執行 | 3／3 PASS |
| Follow-up scoped re-review | `76d14a0..cb0c8d4` | 無阻擋項，判定可合併 |
| Follow-up 瀏覽器複驗，2 條路徑 | 在 `cb0c8d4` 執行 | 2／2 PASS |
| 完整測試套件 | 在 `cb0c8d4` | 24 suites／426 tests PASS |
| `vite build`、`vite build --mode ios`、`strip-ios-assets.mjs` | 在 `cb0c8d4` | PASS，GPL 合規通過 |

說明兩點：

1. **whole-branch review 涵蓋到 `ef56cc2`，不含 `76d14a0` 與 `cb0c8d4`。** `76d14a0` 是 final review 的唯一一次 fix wave，依 SDD 流程只做一次 scoped re-review，沒有第二次 whole-branch pass；`cb0c8d4` 是使用者授權的 follow-up，同樣以 scoped re-review 處理。這是流程規定，不是遺漏。
2. **build 通過來自 implementer 報告。** re-reviewer 為維持唯讀（`vite build` 會寫 `dist/`）沒有自行重跑。

### 關鍵驗證數值

Fix wave 複驗（在 `76d14a0`）：

```text
雙虛手取消數目後 PvP：#mobileTurn「黑方」對 GameState.currentPlayer=1，一致
                     修正前此處顯示「白方」
計時局→不計時新局：舊局 timerSeconds {"1":288.424,"2":201.5}
                   開新局後 live 與 localStorage 皆為 {"1":600,"2":600}
                   跨文件 reload 後仍為 {"1":600,"2":600}
計時局→不同時長計時新局：逐秒實測 23 秒，嚴格 1 秒掉 1 秒，無重複扣秒
非預期 console error：0
```

Follow-up 複驗（在 `cb0c8d4`）：

```text
路徑 A 雙虛手進入數目：#mobileTurn「黑方」、#mobileMoveCount 4
                       對 GameState currentPlayer=1、moveHistory.length=4
                       修正前為「白方」、3
路徑 B 申請數目按鈕：  #mobileTurn「黑方」、#mobileMoveCount 2
                       對 currentPlayer=1、moveHistory.length=2，維持原樣
scoringPanel 正常顯示、aiThinkingOverlay 未誤開、取消數目後徽章仍正確
非預期 console error：0
```

完整 smoke（在 `ef56cc2`）修復了 round 1 的 timer 倒退：

```text
round 1（缺陷）：reload 前 02:31 → reload 後 04:36，倒退 125 秒
round 4（修復後）：reload 前 09:02 → reload 後 09:01，往前不倒退
```

round 1 曾標記 SKIPPED 的兩項，這次都實際執行：

- AI 失敗恢復：以 `addInitScript` 換掉 `globalThis.Worker` 注入 throw 與 hang 兩種故障，watchdog 在 20 秒觸發、重試後收斂、`isAIThinking` 全程正確解鎖。
- 390 px 手機互動：實際點過功能列、modal、落子、虛手、悔棋、數目面板。

### 報告檔位置

- 實作與 fix 報告：`.superpowers/sdd/2026-07-28-go-single-state-source/task-7-fix-report.md`
- Smoke 報告，含 round 1、round 4 後、fix wave 複驗三段：`.superpowers/sdd/2026-07-28-go-single-state-source/task-7-report.md`
- 計時問題根因：`.superpowers/sdd/2026-07-28-go-single-state-source/task-7-timer-root-cause.md`
- 各輪 review package diff：同目錄的 `review-<base>..<head>.diff`
- Ledger：同目錄的 `progress.md`

## 回溯相容性，已上架版本

這個 app 已上架（`MARKETING_VERSION = 1.0.5`，commit `647afc9` 已上傳 App Store Connect），野外存在真實使用者的 `gogame_state` snapshot。

Final reviewer 已獨立查證：

- `getSnapshot()`、`restoreSnapshot()`、`SAVE_KEY` 全數未變。
- 已上架版本寫得出的 `passCount` 只可能是 0 或 1，這兩個值在新舊 `applyPass()` 下語意完全一致。
- 還原時新增的 `setAIThinking(false)` 與 `setAiLevel(loadAiLevel())` 兩個正規化，效果等效或更好。

**結論：安全，不需 migration。**

## 已關閉的風險項

**round 1 review 遺失的第 4 個 finding：已關閉。** ledger 只留下一行摘要「3 addressed, 3 open plus 1 new important」，第 4 項原文隨對話遺失、不可回收。處置方式是請兩位獨立 reviewer 分別重掃 round 1 引入的全部 6 處計時 lifecycle checkpoint（`pagehide`、`visibilitychange`、`loadGame()` 起鐘、`endGame()` 存檔、`doUndo()` timer ownership、`cancelScoring()` 起鐘），兩位都判定為清、無未解 Critical／Important。視為已由獨立重掃關閉，不再是未知數。

**活參照外洩：已查證乾淨。** 鏡像移除後，`main.js` 交給子模組的不再是深拷貝而是 store 活物件。Final reviewer 逐一檢查 11 個消費端，確認全部唯讀、無 in-place mutation（`rules.js` 一律先 `cloneBoard()`、`ui.js` `updateHUD()` 第一行 spread）。這是既有測試結構上抓不到的盲區，因為 sandbox 把 `ui.js` 整組換成 noop。

## 收尾紀錄

依 `superpowers:finishing-a-development-branch` 執行，使用者選擇「Merge 回 main 並 push」與「保留 SDD workspace」：

1. 在 worktree 重跑完整測試：24 suites／426 tests PASS。
2. Fast-forward merge `refactor/go-single-state-source` 到 `main`。
3. 在**合併結果**上重跑測試，綠燈後才推送。
4. `git push origin main`：`647afc9..cb0c8d4`。
5. 移除 worktree、刪除已合併分支。
6. SDD workspace 依指示保留，先從 worktree 複製到主 repo 才移除 worktree（否則會一併被刪）。
7. 主 repo 最終測試：24 suites／426 tests PASS。

## 使用者授權的 follow-up，已完成

**`endGameByScoring()` 補 `updateUI()`**，commit `cb0c8d4`。

原本兩位 reviewer 都判定延後，使用者看過清單後指示補上。`updateUI()` 放在 `GameState.beginScoring()` 之後、第一個 `await`（`KataGo.scoreGame`）之前、`updateScoringDisplay()` 之前。位置的兩個必要條件：必須在 `beginScoring()` 之後才推得出已進入數目的狀態；必須在第一個 await 之前，否則整段數秒的 KataGo 推論期間畫面仍是舊值。

已揭露的連帶顯示變化：`endGame()` 本身沒有 `updateUI()`（既有缺口），所以「雙虛手 → 數目 → 確認結果」後徽章停在進入數目時推入的那筆，由修正前的「白方、3 手」變成「黑方、4 手」。兩者都不是「遊戲結束」，但新值手數正確且與 `GameState` 一致，reviewer 判定為中性偏改善，且該畫面有 `#resultModal` 覆蓋，視覺影響有限。

## 待討論並決定：組 C 行為變更

這七項都會改變已上架 App 的可觀察行為，而且好幾項的「正確行為」不是自明的，屬於產品決定而非技術問題。**尚未討論，尚未動手。** 下次要處理時先逐項決定目標行為，再開實作分支。

每項的格式是「現況 → 要決定什麼」。

### C1. 離開 `#play` 切換其他棋種時，圍棋計時是否該停

現況：不會停。而且 `pagehide`／`visibilitychange` checkpoint 現在會把「在別的棋種畫面燒掉的時間」也寫進 snapshot（base 不會，因為 base 只在圍棋操作點存檔）。

要決定：離開棋局畫面算不算「暫停對局」？若算，切回來要不要自動續鐘？這牽涉到使用者對「計時對局」的心理模型。

### C2. `isScoring` 要不要持久化

現況：從不持久化。所以數目期間 reload 會回到對局狀態；PvC 若手番屬 AI，`loadGame()` 會直接讓 AI 走一手。base 的行為是要求使用者重新虛手兩次。

要決定：reload 後應該回到數目畫面，還是回到對局？這是產品決定。若選前者，`gogame_state` 格式要加欄位（已上架，需考慮舊 snapshot 的預設值）；若選後者，則要處理「不該讓 AI 自動走一手」。

### C3. 虛手按鈕與 `requestAIMove()` 的手番／`isScoring` 守門

現況：都沒有守門。7 個 AI 排程點各有一個 100 ms 窗口，窗口內按虛手會把該手記成 AI 顏色，污染棋譜與 SGF。base 有 5 個同形實例，本次重構新增 2 個（`doUndo()`、`cancelScoring()`）。

要決定：守門加在哪一層。加在 `doPass()` 會擋掉 AI 自己的虛手，所以應該加在使用者入口 `doPassAndSave`；但要一次處理全部 7 個排程點，不能只補一處。

### C4. `returnToOriginal()` 要不要 `saveGame()`

現況：不存檔，所以「返回原譜」後 reload 會回到練習分支。已比對確認是 base 就有的行為。

要決定：覆盤的練習分支算不算該持久化的狀態？

### C5. `_timerOnTimeout()` 與 AI 落子的守門順序

現況：`_timerOnTimeout()` 沒有 `isGameBusy()` 守門，而 `ai-controller.js` 的 `app.placeStone()` 之前也沒有 `gameOver` 檢查（守門在落子之後）。理論上 AI 思考中超時，AI 那一手仍可能落在 `gameOver` 之後。

要決定：超時當下該不該中止進行中的 AI 求手，還是讓它落完再判超時。

### C6. `cancelScoring()` 的 AI 排程冪等性

現況：連呼叫兩次會排兩次求手。有 `isAIThinking` lock 兜底、面板呼叫一次後已隱藏，實務不可達。

要決定：值不值得為理論上的不可達路徑加防護。這項最接近「不做也可以」。

### C7. `updateHUD()` 的 `isAIThinking` normalization

現況：`isAIThinking && currentPlayer !== BLACK` 這個條件使人類執白時，AI 真的在思考、徽章卻顯示「黑方」而非「AI 思考中」。

要決定：這是刻意的還是遺留？若要修，人類執白時 AI 思考中該顯示什麼？行為已由測試凍結，改之前先確認想要的顯示。

---

## Follow-up 清單

### 第一級，下次發布前必須揭露的行為差異

註記：這次是 fast-forward merge，沒有 merge commit。使用者可見的行為變更已寫進 `CHANGELOG-ios.md` 的「未發布」段落，下次發版時填入版號即可。以下三項則是給開發者的技術面差異，不適合寫進面向使用者的 changelog。

1. 離開 `#play` 切換其他棋種後圍棋計時仍在跑（既有行為），但 `pagehide`／`visibilitychange` checkpoint 現在會把「在別的棋種畫面燒掉的時間」也寫進 snapshot，base 不會。修正方向見 **C1**。
2. reload 落在雙虛手 snapshot 且 PvC 手番屬 AI 時，`loadGame()` 會直接讓 AI 走一手。根因是 `isScoring` 從不持久化。base 則是要求使用者重新虛手兩次，差別在手番歸誰，且 AI 那一手可悔棋。修正方向見 **C2**。
3. `doUndo()` 與 `cancelScoring()` 新增兩個 100 ms AI 排程窗口，使同形實例從 base 的 5 個變成 7 個。後果不是卡死，而是窗口內按虛手會把該手記成 AI 顏色，污染棋譜與 SGF。修正方向見 **C3**。

### 第二級，已於 follow-up 清理批次完成

4. ~~**`endGame()` 缺 `updateUI()`。**~~ 已於 `e1f1d7a` 完成。掃過全部終局路徑後確認 `game-state.js` 只有 4 處能讓 `gameOver` 變 true、對應 5 條 `main.js` 路徑，`endGame()`（認輸／超時／確認數目三者收斂）是唯一缺口。`ui.js` 的 `updateHUD()` 本來就把 `gameOver` 分支排在最前面，所以不需改顯示邏輯，缺的只是沒人在終局那一刻把狀態送進去。瀏覽器複驗三條路徑皆顯示「遊戲結束」且手數一致。

### 第三級，殘餘 minor

5. ~~死碼群集~~ 已於 `ff1e3ea` 完成：`main.js` 8 處未使用回傳值的 `getGoState()`、`main.js` 的 `get passCount()`、`ui.js` 的 `turnDisplay` 分支皆已刪除。Reviewer 獨立驗證的理由比原本更強：`game-state.js` 的 `state` 是模組私有、不在任何 export，`ensureState()` 是冪等 lazy init，因此刪除裸呼叫在任何位置都安全。
6. ~~`useRealTimer` 旗標的雙重職責~~ 已於 `eaf0e0d` 處理。**沒有**照原本設想拆成兩個旗標（拆完漏帶新旗標的後果一模一樣），改為假 scheduler 恆常安裝，旗標語意收窄為「只決定要不要載入真實 `timer.js`」。刻意不改名：14 個呼叫點用解構預設值 `= false`，改名會讓舊名被靜默忽略，正是要根治的失效類型。附帶修好 jest 平行執行的 worker 計時器洩漏警告。更正一項當初的宣稱：那種空洞斷言在本 repo 從未實際存在（base 與 HEAD 稽核皆為 0 條），改動的實證效益是消除 worker 洩漏與防止未來發生。
7. ~~`ui.js` 渲染層零自動化覆蓋~~ 已於 `e3a9de2` 完成。spike 推翻了原本的假設：這個專案的測試是 `testEnvironment: 'node'` + `vm.createContext()` 自建 realm，**從頭到尾沒有 jsdom**，所以擋路的不是 canvas 而是 helpers 把 `ui.js` 整組 mock 掉的決定。採路線 C：`localRequire('./ui.js')` 載入真實模組，就地覆寫 `drawBoard`／`drawWinrateGraph`（那兩條繼續交給瀏覽器 smoke），零新增依賴、既有測試零修改。12 個 export 中 10 個現在是真的。
8. ~~「計時局 → 計時局」路徑無測試~~ 已於 `501d768` 補上。注意它與既有的「計時 → 不計時」測試互補、不可合併：這條路徑對 `stopTimer()` 排序 bug 免疫（被 `GoTimer.init` 的整份覆寫遮蔽），真正守住那個 bug 的是「計時 → 不計時」那條。
9. 虛手按鈕與 `requestAIMove()` 都缺手番／`isScoring` 守門。**見上方 C3**，待討論。
10. `returnToOriginal()` 未 `saveGame()`，返回原譜後 reload 會回到練習分支。**見上方 C4**，待討論。
11. `updateHUD()` 的 `isAIThinking && currentPlayer !== BLACK` normalization 使人類執白時「AI 思考中」徽章永不顯示。**見上方 C7**，待討論。
12. ~~`doUndo()` 排程觸發條件的註解敘述錯誤~~ 已於 `a1196b2` 修正。真正的觸發條件是「盤上只有 AI 開局那一手時悔棋」與「從已卡在 AI 手番的狀態恢復」，不是原本寫的「悔兩手後回到輪 AI」（悔兩手其實保留手番）。
13. `cancelScoring()` 的 AI 排程不具冪等性，連呼叫兩次會排兩次。**見上方 C6**，待討論。
14. ~~`ui.js` 的三行 `setText` 死碼~~ 已於 `ee6db06` 刪除，連帶移除只被那三行使用的 `setText` 輔助函式。
15. ~~`style.css` 的 `.current-turn` 孤兒規則~~ 已於 `ee6db06` 刪除。其中 3 條 `::before` 是與仍在使用的 `.turn-badge` 共用的選擇器串，只拆掉 `.current-turn` 那半；reviewer 用腳本逐字元比對確認 7 個 `.turn-badge` 規則的選擇器與宣告區塊在前後兩版完全相同。
16. ~~`GameState.setAiLevel()` 不夾值~~ 已於 `3628b7d` 補上，範圍從 `adaptive-difficulty.js` 讀 `MIN_LEVEL`／`MAX_LEVEL`，非寫死數字。
17. `_timerOnTimeout()` 沒有 `isGameBusy()` 守門，而 `ai-controller.js` 的 `app.placeStone()` 之前也沒有 `gameOver` 檢查（守門在落子之後）。**見上方 C5**，待討論。
18. ~~`regression_notes_status_sync.txt` 提到已刪除的 `turnDisplay`~~ 已於 `ee6db06` 處理。決定保留檔案不刪、也不改寫有時間戳的內文（改寫等於偽造記錄），只在檔首加 4 行過期說明，讓日後 grep 命中時第一行就自我解釋。Reviewer 逐句驗證過那 4 行說明皆正確。
19. `aiLevel` 仍有兩條繞過 `setAiLevel()` 的直寫路徑：`game-state.js` 的 `createInitialState()` 與 `restoreSnapshot()` 都是 `snapshot.aiLevel || 10`，未夾值。損毀的 localStorage 仍可塞進超範圍值。不阻擋（`levelConfig()` 與 `nextLevelForMode()` 內部各自夾過範圍，AI 實際強度不受影響）。
20. `#statusMsg` 這個元素在任何 HTML 都不存在，`setStatus()` 對它的寫入永遠走 null guard。未來可考慮連同 guard 一起清掉。
21. 測試 DOM mock 的效力界線：`getElementById` 永不回傳 null、`textContent` 不做字串轉型。所以「元素被刪掉」這類 regression 測不到，該防線仍在瀏覽器 smoke；`moves: 7` 這類斷言是 mock 形狀，換到真實 DOM 需要 `String()`。

## 全域限制

- 不改變 `gogame_state` 的 `localStorage` 格式。
- 不改變棋規、AI 強度、自適應難度演算法、UI、HTML ID 或全域操作函式名稱。
- 不修改其他棋類的獨立狀態管理。
- 不新增狀態管理套件、Proxy 或事件訂閱機制。
- 暫時性 UI 狀態必須留在 `main.js`。
- 每個非同步邊界完成後，重新讀取最新 `GameState`。
- 不順手重構未點名程式碼。
- 修 bug 時先辨識 problem class，掃描同類實例並從共同根因修正。
- 宣稱完成前必須有 fresh verification evidence。

## 開發規範提醒

- `~/.codex/dev-principles.md` 在這台環境不存在，使用現存的 `~/.claude/dev-principles.md`。
- 使用 subagent 驅動流程時，每個實作 Task 後必須有獨立唯讀 review。
- Controller 不要自行修 reviewer findings，應交回 implementer。
- 不要同時啟動多個 implementer。
- commit 訊息不加任何 Claude 或 Codex 相關尾註。
