// timer.js — 對局計時器（wall-clock，S12）。
//
// 舊版用 setInterval「每 tick 減 1 秒」＝把 tick 次數當秒數，背景分頁被瀏覽器節流
// （約每分鐘才一 tick）就會漏算時間、時鐘變慢。改為 wall-clock：記下「這手開始的
// 時間戳 + 開始時剩餘秒數」，每次 tick 用真實流逝時間回推剩餘，tick 只負責刷新顯示
// 與檢查超時，不再是時間來源。即使 tick 被節流/漏掉，畫面剩餘永遠正確。
//
// timerSeconds = { 1:黑剩餘秒, 2:白剩餘秒 } 仍是 source of truth（存檔/同步/還原都讀它）；
// 進行中的那一方會被持續更新成精確剩餘（浮點），非進行方維持其上次落子時的定格值。
// timer 透過 callback 讀寫狀態，不直接持有或修改外部 timerSeconds 物件。

let displayInterval = null;   // 顯示刷新用的 interval（非時間來源）
let activePlayer = null;      // 目前在走鐘的一方（1/2），null=未在計時
let turnStartTs = 0;          // 這手開始的時間戳（Date.now()）
let turnStartRemaining = 0;   // 這手開始時 activePlayer 的剩餘秒數
let getTimerSeconds = null;
let setTimerSeconds = null;
let timeoutCb = null;
let getPlayer = null;

const TICK_MS = 250;          // 刷新頻率：回到分頁後最多 0.25s 內校正顯示

function elapsed() {
  return (Date.now() - turnStartTs) / 1000;
}

/** 算出 activePlayer 此刻的精確剩餘並以新物件寫回（夾在 0 以上）。 */
function syncRemaining() {
  if (activePlayer == null || !getTimerSeconds || !setTimerSeconds) return null;
  const remaining = Math.max(0, turnStartRemaining - elapsed());
  const current = getTimerSeconds();
  const next = { ...current, [activePlayer]: remaining };
  setTimerSeconds(next);
  return { remaining, seconds: next };
}

function tick() {
  if (activePlayer == null) return;
  const synced = syncRemaining();
  if (!synced) return;
  GoTimer.updateDisplay(synced.seconds);
  if (synced.remaining <= 0) {
    const timedOut = activePlayer;
    GoTimer.stop();           // 會定格 0 並清掉 interval
    timeoutCb && timeoutCb(timedOut);
  }
}

export const GoTimer = {
  init(minutes, writeSeconds) {
    const secs = (minutes || 10) * 60;
    const next = { 1: secs, 2: secs };
    writeSeconds(next);
    GoTimer.updateDisplay(next);
  },

  start(options) {
    GoTimer.stop();           // 若有前一手在走，先定格其剩餘
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

  // 換手：先定格上一手剩餘（stop），再為新的當手方重新起鐘（start 讀 getCurrentPlayer()）。
  switch(options) {
    GoTimer.start(options);
  },

  sync() {
    return syncRemaining();
  },

  stop() {
    if (activePlayer != null) {
      syncRemaining();        // 定格目前這一方的精確剩餘，供存檔/還原
      activePlayer = null;
    }
    if (displayInterval) { clearInterval(displayInterval); displayInterval = null; }
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

  /** Pure: 秒數 → "MM:SS"。用 ceil 讓倒數在最後一秒顯示 00:01 再到 00:00；容忍浮點輸入。 */
  formatTime(s) {
    const t = Math.max(0, Math.ceil(s));
    return `${Math.floor(t / 60).toString().padStart(2, '0')}:${(t % 60).toString().padStart(2, '0')}`;
  }
};
