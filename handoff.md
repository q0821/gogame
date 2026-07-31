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

## 組 C 行為變更：已完成

七項全部完成，commit `3004d9e`..`29dcba7`（7 個）。測試 458 → 476，獨立 review 判定無 Critical 無 Important，瀏覽器 smoke 12／12 PASS、無卡死。

以下保留每項的「原始現況 → 待決事項」，並在各節末補上**實際決定與實情**。有三項的實情與原本的描述不同，那三處特別標了出來。

### 上線注意事項

**這批上到 web 之後不要回滾 bundle。** 新版會寫 `isScoring: true` 進 `gogame_state`，舊版讀得到該欄位但沒有重建數目畫面的邏輯，會進入「狀態說在數目、畫面卻是對局」且自己存不出去也清不掉的不一致，只能靠「重新開始」脫身。

Reviewer 查證過其他管道都不可達：web 與 iOS 不共用 localStorage（iOS 走內嵌 HTTP server 的 `localhost:PORT`，與 web 網域不同 origin）、iOS 使用者無法從 App Store 降版、`public/sw.js` 對 navigate 是 refresh-first 只會往前。**唯一實際可達的觸發就是 web 部署回滾。**

### C1. 離開 `#play` 切換其他棋種時，圍棋計時是否該停

現況：不會停。而且 `pagehide`／`visibilitychange` checkpoint 現在會把「在別的棋種畫面燒掉的時間」也寫進 snapshot（base 不會，因為 base 只在圍棋操作點存檔）。

要決定：離開棋局畫面算不算「暫停對局」？若算，切回來要不要自動續鐘？這牽涉到使用者對「計時對局」的心理模型。

**已完成（`de8a071` + `29dcba7`）**：算暫停。離開停鐘並存檔定格秒數，切回自動續鐘。掛載點選 `showScreen()`（`applyRoute()` 所有分支的唯一收斂點），因為 `enterPlayMode()` 有 `playInited` 保護、只在首次進入時跑。

第一版不完整：PvC 下 AI 那一手在使用者離開後才回來時，`switchTimer()` 會把鐘重新打開，在別的棋種畫面繼續燒時間、甚至在隱藏畫面判超時。`29dcba7` 用 `playTimerSuspended` 旗標修好，`startTimer()` 與 `switchTimer()` 兩處都擋。

**一個實測澄清**：AI 那一手回來時**確實會落進棋譜**（smoke 實測在五子棋畫面上 3 → 4 手），這符合實作意圖 — `isAnalysisRequestCurrent()` 比對的是 board 物件識別、手數、手番與 `gameOver`，換路由這四項都沒變，那一手本來就該落下。真正被守住的是「鐘不會重新啟動」。切回來會看到 AI 已應手，時間沒被燒掉。

### C2. `isScoring` 要不要持久化

現況：從不持久化。所以數目期間 reload 會回到對局狀態；PvC 若手番屬 AI，`loadGame()` 會直接讓 AI 走一手。base 的行為是要求使用者重新虛手兩次。

要決定：reload 後應該回到數目畫面，還是回到對局？這是產品決定。若選前者，`gogame_state` 格式要加欄位（已上架，需考慮舊 snapshot 的預設值）；若選後者，則要處理「不該讓 AI 自動走一手」。

**實情與上面的描述不同**：`getSnapshot()` **早就包含 `isScoring` 與 `deadStones`**，`restoreSnapshot()` 也讀回來。所以格式不用加欄位、不需 migration。真正卡住的是 `saveGame()` 遇到 `isScoring` 會早退，`isScoring: true` 從來寫不出去。

**已完成（`fdc6309`）**：選回到數目畫面。做法是把 `saveGame()` 的守門放寬成只擋 `isReviewing`（而非只在某一處補存，因為 `saveGame()` 呼叫端太分散，補一處會留一堆縫）；死子切換也存檔是要的保真度。還原時只用本地 `calculateScore()`，不重跑 KataGo ownership。順帶補上 `loadGame()` 的 AI 排程與起鐘條件（原本都沒看 `isScoring`）。

`game-state.js` 這批**一行未改**，snapshot 格式證實零變動。Reviewer 逐一查過全部 14 個 `saveGame()` 呼叫端，沒有寫出不該寫的狀態（特別確認 `confirmScoring()` 會先把 `isScoring` 設回 false，不會寫出 `gameOver` 與 `isScoring` 同時為 true 的矛盾狀態）。

### C3. 虛手按鈕與 `requestAIMove()` 的手番／`isScoring` 守門

現況：都沒有守門。7 個 AI 排程點各有一個 100 ms 窗口，窗口內按虛手會把該手記成 AI 顏色，污染棋譜與 SGF。base 有 5 個同形實例，本次重構新增 2 個（`doUndo()`、`cancelScoring()`）。

要決定：守門加在哪一層。加在 `doPass()` 會擋掉 AI 自己的虛手，所以應該加在使用者入口 `doPassAndSave`；但要一次處理全部 7 個排程點，不能只補一處。

**已完成（`5eb6d85`）**：都不是加在使用者入口，而是新增 `aiMoveScheduled` 旗標納入 `isGameBusy()`。`isGameBusy()` 已經被 `placeStone`／`doPass`／`doUndo`／`doResign`／`finishGame` 全部使用，一處改動就把所有窗口關掉。旗標留在 `main.js`，不進 `GameState`、不碰 snapshot。

**排程點是 8 個不是 7 個** — 第 8 個藏在 `ai-controller.js` 整輪失敗後的 1.5 秒重試，同一問題類型，已一併改走 `scheduleAIMove()`。

清除路徑經 reviewer 獨立窮舉，論證可收斂成兩條：`setTimeout` callback 第一件事就是清旗標（所以 `requestAIMove()` 內部發生什麼都與旗標無關）；旗標為 true 時必定有 pending timer，只有觸發或被 `clearTimeout` 兩種下場。瀏覽器 smoke 從「開新局」「AI 整輪失敗」「連點」三條路徑實測都會解除。

### C4. `returnToOriginal()` 要不要 `saveGame()`

現況：不存檔，所以「返回原譜」後 reload 會回到練習分支。已比對確認是 base 就有的行為。

要決定：覆盤的練習分支算不算該持久化的狀態？

**已完成（`55380ca`）**：不算，返回原譜後存的是原譜。

**只補 `saveGame()` 是靜默 no-op** — 快照拍在 `exitReview()` 之前，`isReviewing: true` 會被 `saveGame()` 的守門擋掉，等於白補。已用測試證實（4 手 vs 3 手），所以一併加了 `GameState.exitReview()`。

**附帶的可見變化**：返回原譜後盤面由「分支點局部盤面」改為「完整原譜盤面」。改動前那是「盤面停在覆盤游標、卻沒有任何導航控制項可離開」的死狀態，新行為是完整盤面配上可再次進入覆盤的按鈕。Smoke 目視確認合理（10 手棋譜、最後一手紅圈落在原譜第 10 手、徽章「遊戲結束」與狀態列「已返回原始棋譜」三者自洽）。

### C5. `_timerOnTimeout()` 與 AI 落子的守門順序

現況：`_timerOnTimeout()` 沒有 `isGameBusy()` 守門，而 `ai-controller.js` 的 `app.placeStone()` 之前也沒有 `gameOver` 檢查（守門在落子之後）。理論上 AI 思考中超時，AI 那一手仍可能落在 `gameOver` 之後。

要決定：超時當下該不該中止進行中的 AI 求手，還是讓它落完再判超時。

**實情與上面的描述不同**：超時路徑**原本就攔得住**。`_timerOnTimeout()` 已正確判超時方輸（算 winner、調整等級 ±30、`endGame('X方勝', 'Y方超時')`），而 `placeStone()` 開頭的 `isGameBlocked()` 已含 `gameOver`。

真正會出事的是**「AI 求手期間按開始新遊戲」**：`newGame()` 除了 `window.confirm` 沒有任何 `isGameBusy()` 守門，新局的 `gameOver`／`isAIThinking` 都是 false，兩道守門全放行，舊局那一手會落在新局盤面上。

**已完成（`1f89549`）**：改用既有的 `isAnalysisRequestCurrent()`（比對 board 物件識別＋手數＋手番＋`!gameOver`），一次涵蓋兩條路徑，沿用既有機制而非另造一套。順帶修好「AI 思考中按返回原譜」的同一條 problem class。Smoke 實測：舊局 1 手 + AI 思考中 → 按重新開始 → 新局 9 個取樣點 `moveHistory` 全為空。

### C6. `cancelScoring()` 的 AI 排程冪等性

現況：連呼叫兩次會排兩次求手。有 `isAIThinking` lock 兜底、面板呼叫一次後已隱藏，實務不可達。

要決定：值不值得為理論上的不可達路徑加防護。這項最接近「不做也可以」。

**已完成（`5eb6d85`，與 C3 同一個 commit）**：C3 的 `aiMoveScheduled` 旗標順便解決，零額外成本 — 有旗標就能檢查「已排過」，冪等性自動成立。

### C7. `updateHUD()` 的 `isAIThinking` normalization

現況：`isAIThinking && currentPlayer !== BLACK` 這個條件使人類執白時，AI 真的在思考、徽章卻顯示「黑方」而非「AI 思考中」。

要決定：這是刻意的還是遺留？若要修，人類執白時 AI 思考中該顯示什麼？行為已由測試凍結，改之前先確認想要的顯示。

**已完成（`3004d9e`）**：是遺留，而且同一畫面本來就自相矛盾 — `getStatusMessage()` 用的是未經 normalize 的 `state.isAIThinking`，所以狀態列老實顯示「AI 思考中...」，只有徽章被 normalize 成「黑方」。

修法是直接用 `!!state.isAIThinking`（PvP 不會設 `isAIThinking`，不需額外條件）。前一批刻意加來凍結舊行為的那條測試已改成反映新行為。Smoke 實測人類執白時徽章顯示「AI 思考中」、class 為 `turn-badge`（無 `black`），與狀態列一致。

---

## 覆盤勝率修正（2026-07-31）

使用者回報覆盤勝率怪異。查證後是**兩個獨立問題**，commit `be64b67`、`7e15d6d`、`c463529`、`7b898b8`。

### 問題 1：文案視角混淆（`be64b67`）

`updateReviewAnalysisInfo()` 把「黑勝率」與「該手方失分」並列而未標主語。計算本身完全正確 — 第 14 手（白）的「黑勝率 80%」正是第 15 手的起點，兩者自洽。但讀起來像「黑勝率 80% 然後失 52%」，於是預期下一手是 28%，實際看到 57%。

新格式：`第 14 手（白）— 白這手約失 52% 勝率（≈ 9.6 目，估計），黑勝率升至 80% · 疑問手`

失分一律加主語（連黑方也加），黑勝率改成「降至／升至」的動態句。順帶補上白方分支的測試 — 既有測試只涵蓋黑方，這是問題能長期存在的原因之一。

### 問題 2：引擎 port bug（`7e15d6d` + `c463529`）

`analyzeMcts.ts` 的 root 加權沒有手番翻號。上游 C++（`cpp/search/searchupdatehelpers.cpp` 的 `recomputeNodeStats`）有：

```cpp
stats.selfUtility = node.nextPla == P_WHITE ? childUtility : -childUtility;
```

上游把翻號放在「填 `MoreNodeStats` 的地方」，兩個加權函式刻意保持 player-agnostic — 這部分 port 抄得逐行一致，唯獨省略了 `nextPla` 翻號，等於永遠假設手番是黑。

修法採「還原上游結構」而非發明新簽名：先把四個零相依的純函式抽到 `katago-engine/engine/katago/rootWeighting.js`（純重構，字元級比對 5707 字元完全相同），再於兩個建構點補上翻號。

**寫成 `.js` 而非 `.ts` 是刻意的**：本專案沒有 tsconfig，也沒裝 typescript／`@babel/preset-typescript`／esbuild（vite 8 改用 rolldown），純 JS 讓既有測試的 `makeRequire` 原封不動就能載入。檔頭已註明理由與「請勿改回 .ts」。

### 影響範圍（瀏覽器 A／B 實測確認）

判準是**該手之後那個局面的 root 手番**，與「這手是誰下的」相反：

| | 結果 |
|---|---|
| 黑手番 root（白下的手之後） | 位元級不變，9／9 |
| 白手番 root（黑下的手之後） | 修正後黑勝率較低，5／5 |
| 形勢判斷 | 同上規則 |
| 終局數目 | **逐位元不變**，81 點 ownership 全等 |
| 建議走法文案 | **不變**（`describeSuggestion()` 只用候選手自己的 `scoreLead`） |
| AI 選點 | 不變（`order` 由 visits 排序決定） |
| AI 執白難度 | 候選池收窄、回到名目等級（使用者已裁決接受） |

**真實局面的效應量只有 0.02–1.7 pp**，遠小於探針合成場景的 64 pp。而 KataGo 本身有隨機性（`wideRootNoise ?? 0.04`、`nnRandomize`，`katago-service.js` 兩個都沒傳），實測噪音帶 2.3–4.7 pp **比修正效應還大**，所以 A／B 對照必須先注入 `nnRandomize:false, wideRootNoise:0` 才做得出位元級比對。

難度影響也比預期小：第 1 級門檻 14 目、位移量 0.02–0.24 目，候選池只被擠掉不到 2%。真正受影響的是 **level 11–13**（門檻 0.6／0.3／0），那裡位移量與門檻同一數量級。

### 測試的侷限，請不要誤讀

新增的 golden 斷言是**從目前實作產生的**，證明的是「沒有人在無意間動到這條數值路徑」，**不是「這條路徑等於上游 C++」**。如果 port 本來就有抄錯的地方，golden 會把那個錯一起釘住。上游保真度靠的是逐行對照，不是 golden。

補強前後的 mutation 對照（9 個）：補強前有 6 個抓不到，補強後全部會紅。其中 `z` 的符號方向反轉（與本次修的同類錯）由方向性斷言單獨就能抓到，不必靠 golden — 調參時 golden 會被合法更新，方向性斷言不會。

### 仍未解決

- **兩個建構點（`analyzeMcts.ts:2013`／`:2505`）只有程式碼閱讀覆蓋、沒有測試覆蓋**。把 `'black'` 改成 `'white'` 整套 516 個測試仍會全綠。要補得先讓測試環境載得進 `.ts`。
- `analyzeMcts.ts:2505` 位於全 repo 無人 import 的平行實作內，是死碼，同步修正只為不留半修狀態。
- **讓子局的覆盤有另一個獨立 bug**（本次未修）：`review.js` 從空盤重播棋譜，而讓子石是開局預置、不在棋譜裡，所以覆盤時讓子石會消失；且 `main.js:1200` 的 `k % 2` 假設黑先，讓子局是白先會每一手都反。`replayFromHere()` 也沒傳 `board` 與 `handicap`，從讓子局分出的練習局同樣掉讓子石。

## Follow-up 清單

### 第一級，原本要在發布前揭露的行為差異：三項皆已修掉

註記：使用者可見的行為變更都已寫進 `CHANGELOG-ios.md` 的「未發布」段落，下次發版時填入版號即可。

1. ~~離開 `#play` 後圍棋計時仍在跑，且 checkpoint 會把在別的棋種畫面燒掉的時間寫進 snapshot~~ 已由 **C1** 修掉（`de8a071` + `29dcba7`）。
2. ~~reload 落在雙虛手 snapshot 且 PvC 手番屬 AI 時 `loadGame()` 會直接讓 AI 走一手~~ 已由 **C2** 修掉（`fdc6309`）。現在 reload 回到數目畫面，不會有這條路徑。
3. ~~`doUndo()` 與 `cancelScoring()` 新增的 100 ms AI 排程窗口~~ 已由 **C3** 修掉（`5eb6d85`）。`aiMoveScheduled` 旗標納入 `isGameBusy()` 後，8 個排程點的窗口全關。

### 第二級，已於 follow-up 清理批次完成

4. ~~**`endGame()` 缺 `updateUI()`。**~~ 已於 `e1f1d7a` 完成。掃過全部終局路徑後確認 `game-state.js` 只有 4 處能讓 `gameOver` 變 true、對應 5 條 `main.js` 路徑，`endGame()`（認輸／超時／確認數目三者收斂）是唯一缺口。`ui.js` 的 `updateHUD()` 本來就把 `gameOver` 分支排在最前面，所以不需改顯示邏輯，缺的只是沒人在終局那一刻把狀態送進去。瀏覽器複驗三條路徑皆顯示「遊戲結束」且手數一致。

### 第三級，殘餘 minor

5. ~~死碼群集~~ 已於 `ff1e3ea` 完成：`main.js` 8 處未使用回傳值的 `getGoState()`、`main.js` 的 `get passCount()`、`ui.js` 的 `turnDisplay` 分支皆已刪除。Reviewer 獨立驗證的理由比原本更強：`game-state.js` 的 `state` 是模組私有、不在任何 export，`ensureState()` 是冪等 lazy init，因此刪除裸呼叫在任何位置都安全。
6. ~~`useRealTimer` 旗標的雙重職責~~ 已於 `eaf0e0d` 處理。**沒有**照原本設想拆成兩個旗標（拆完漏帶新旗標的後果一模一樣），改為假 scheduler 恆常安裝，旗標語意收窄為「只決定要不要載入真實 `timer.js`」。刻意不改名：14 個呼叫點用解構預設值 `= false`，改名會讓舊名被靜默忽略，正是要根治的失效類型。附帶修好 jest 平行執行的 worker 計時器洩漏警告。更正一項當初的宣稱：那種空洞斷言在本 repo 從未實際存在（base 與 HEAD 稽核皆為 0 條），改動的實證效益是消除 worker 洩漏與防止未來發生。
7. ~~`ui.js` 渲染層零自動化覆蓋~~ 已於 `e3a9de2` 完成。spike 推翻了原本的假設：這個專案的測試是 `testEnvironment: 'node'` + `vm.createContext()` 自建 realm，**從頭到尾沒有 jsdom**，所以擋路的不是 canvas 而是 helpers 把 `ui.js` 整組 mock 掉的決定。採路線 C：`localRequire('./ui.js')` 載入真實模組，就地覆寫 `drawBoard`／`drawWinrateGraph`（那兩條繼續交給瀏覽器 smoke），零新增依賴、既有測試零修改。12 個 export 中 10 個現在是真的。
8. ~~「計時局 → 計時局」路徑無測試~~ 已於 `501d768` 補上。注意它與既有的「計時 → 不計時」測試互補、不可合併：這條路徑對 `stopTimer()` 排序 bug 免疫（被 `GoTimer.init` 的整份覆寫遮蔽），真正守住那個 bug 的是「計時 → 不計時」那條。
9. ~~虛手按鈕與 `requestAIMove()` 都缺手番／`isScoring` 守門~~ 已由 **C3** 修掉（`5eb6d85`）。
10. ~~`returnToOriginal()` 未 `saveGame()`~~ 已由 **C4** 修掉（`55380ca`）。只補 `saveGame()` 是靜默 no-op，一併加了 `GameState.exitReview()` 才生效。
11. ~~`updateHUD()` 的 `isAIThinking` normalization~~ 已由 **C7** 修掉（`3004d9e`）。
12. ~~`doUndo()` 排程觸發條件的註解敘述錯誤~~ 已於 `a1196b2` 修正。真正的觸發條件是「盤上只有 AI 開局那一手時悔棋」與「從已卡在 AI 手番的狀態恢復」，不是原本寫的「悔兩手後回到輪 AI」（悔兩手其實保留手番）。
13. ~~`cancelScoring()` 的 AI 排程不具冪等性~~ 已由 **C6** 修掉（`5eb6d85`，與 C3 同一機制）。
14. ~~`ui.js` 的三行 `setText` 死碼~~ 已於 `ee6db06` 刪除，連帶移除只被那三行使用的 `setText` 輔助函式。
15. ~~`style.css` 的 `.current-turn` 孤兒規則~~ 已於 `ee6db06` 刪除。其中 3 條 `::before` 是與仍在使用的 `.turn-badge` 共用的選擇器串，只拆掉 `.current-turn` 那半；reviewer 用腳本逐字元比對確認 7 個 `.turn-badge` 規則的選擇器與宣告區塊在前後兩版完全相同。
16. ~~`GameState.setAiLevel()` 不夾值~~ 已於 `3628b7d` 補上，範圍從 `adaptive-difficulty.js` 讀 `MIN_LEVEL`／`MAX_LEVEL`，非寫死數字。
17. ~~`_timerOnTimeout()` 與 AI 落子的守門順序~~ 已由 **C5** 處理（`1f89549`）。實情與原本描述不同：超時路徑原本就攔得住，真正會出事的是「AI 求手期間按開新局」。
18. ~~`regression_notes_status_sync.txt` 提到已刪除的 `turnDisplay`~~ 已於 `ee6db06` 處理。決定保留檔案不刪、也不改寫有時間戳的內文（改寫等於偽造記錄），只在檔首加 4 行過期說明，讓日後 grep 命中時第一行就自我解釋。Reviewer 逐句驗證過那 4 行說明皆正確。
19. `aiLevel` 仍有兩條繞過 `setAiLevel()` 的直寫路徑：`game-state.js` 的 `createInitialState()` 與 `restoreSnapshot()` 都是 `snapshot.aiLevel || 10`，未夾值。損毀的 localStorage 仍可塞進超範圍值。不阻擋（`levelConfig()` 與 `nextLevelForMode()` 內部各自夾過範圍，AI 實際強度不受影響）。
20. `#statusMsg` 這個元素在任何 HTML 都不存在，`setStatus()` 對它的寫入永遠走 null guard。未來可考慮連同 guard 一起清掉。
21. 測試 DOM mock 的效力界線：`getElementById` 永不回傳 null、`textContent` 不做字串轉型。所以「元素被刪掉」這類 regression 測不到，該防線仍在瀏覽器 smoke；`moves: 7` 這類斷言是 mock 形狀，換到真實 DOM 需要 `String()`。

### 組 C review 與 smoke 新找到的（全部不阻擋，未處理）

22. `returnToOriginal()` 是唯一沒有 `cancelScheduledAIMove()` 的換局路徑（其他三處 `restoreSnapshot`／`startGame` 呼叫端都有）。Reviewer 實測殘留排程確實會觸發一次 `requestAIMove()`，但還原後 `gameOver` 為 true 使其早退，目前無害。建議補上以保住「換局一律 cancel」的不變式，免得日後覆盤放寬到中局時破功。
23. `ai-controller.js` 整輪失敗後的 1.5 秒恢復重試排程，若碰上已有 pending 排程會被冪等守門靜默丟棄，AI 會停在「自動重試中…」不再重試。可達條件是「AI 思考中按開始新遊戲」，而那種情況下舊局的重試本來就不該發生。
24. modal 是 `position:fixed`，`showScreen()` 不會關掉它。若使用者開著結果 modal 用瀏覽器上一頁離開 `#play`，再按 modal 裡的「再來一局」，新局的 `startTimer()` 會被 `playTimerSuspended` 吞掉。切回 `#play` 時 `enterPlayMode()` 的續鐘分支會自癒。
25. `deadStones` 必須是 `Set` 這個不變式沒有測試釘住（`toggleDeadGroup()` 用 `.has/.add/.delete`，而測試用 `Array.from()` 斷言，對 Array 與 Set 行為相同）。現況正確（`createInitialState()` 有 `new Set()`），但日後有人動 `restoreSnapshot` 測試不會叫。
26. 「reload 進數目 → 再標死子」這條 C2 新開的整合路徑沒有自動化測試（瀏覽器 smoke 第 4 項有實測通過）。
27. `index.html` 數目面板附近的註解寫「該處也可確認/取消」，但 panel 內實際只有「查看結果」一顆鈕。既有錯誤，但 C2 讓這個 panel 成為 reload 後的唯一入口，值得順帶修正。使用者的逃生路徑是：查看結果 → modal 的「繼續對弈／修正死子／確認結果」。
28. `returnToOriginal()` 之後 `currentReviewMove` 仍停在離開時的手數（`isReviewing` 已為 false 故不影響顯示）。
29. `loadGame()` 還原終局狀態時未重建 `#exportSgfBtn`。

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
