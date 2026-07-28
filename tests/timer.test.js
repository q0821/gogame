const { sandboxWithTimer } = require('./helpers');

let GoTimer;
beforeAll(() => {
  ({ GoTimer } = sandboxWithTimer());
});

// ─── formatTime ───────────────────────────────────────────────────────────────

describe('GoTimer.formatTime', () => {
  test('0 seconds → "00:00"', () => {
    expect(GoTimer.formatTime(0)).toBe('00:00');
  });

  test('59 seconds → "00:59"', () => {
    expect(GoTimer.formatTime(59)).toBe('00:59');
  });

  test('60 seconds → "01:00"', () => {
    expect(GoTimer.formatTime(60)).toBe('01:00');
  });

  test('600 seconds (10 min) → "10:00"', () => {
    expect(GoTimer.formatTime(600)).toBe('10:00');
  });

  test('3661 seconds → "61:01"', () => {
    expect(GoTimer.formatTime(3661)).toBe('61:01');
  });

  test('single-digit seconds zero-padded', () => {
    expect(GoTimer.formatTime(65)).toBe('01:05');
  });

  test('浮點剩餘用 ceil（倒數最後一秒顯示 00:01）', () => {
    expect(GoTimer.formatTime(595.0)).toBe('09:55');
    expect(GoTimer.formatTime(0.3)).toBe('00:01');
    expect(GoTimer.formatTime(-2)).toBe('00:00');
  });
});

// ─── wall-clock（S12）─────────────────────────────────────────────────────────
// 用假時鐘 + 捕捉 tick：每個測試開新 sandbox（模組狀態獨立），覆寫 ctx 的
// Date / setInterval / clearInterval，手動驅動時間與 tick。

function clocked() {
  const ctx = sandboxWithTimer();
  let now = 1_000_000;
  let tickCb = null;
  ctx.Date = { now: () => now };
  ctx.setInterval = (fn) => { tickCb = fn; return 42; };
  ctx.clearInterval = () => { tickCb = null; };
  return {
    GoTimer: ctx.GoTimer,
    advance: (ms) => { now += ms; },
    tick: () => { if (tickCb) tickCb(); },
    hasInterval: () => tickCb !== null,
  };
}

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

describe('GoTimer wall-clock', () => {
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

  test('背景節流：65 秒只觸發一次 tick，仍扣 65 秒（核心修正）', () => {
    const { GoTimer, advance, tick } = clocked();
    const store = timerStore();
    GoTimer.start({
      getTimerSeconds: store.getTimerSeconds,
      setTimerSeconds: store.setTimerSeconds,
      getCurrentPlayer: () => 1,
      onTimeout: () => {}
    });
    advance(65000);
    tick();
    expect(Math.round(store.seconds[1])).toBe(535);
    expect(GoTimer.formatTime(store.seconds[1])).toBe('08:55');
  });

  test('換手定格上一手、為當手方重新起鐘', () => {
    const { GoTimer, advance, tick } = clocked();
    const store = timerStore();
    let cur = 1;
    const options = {
      getTimerSeconds: store.getTimerSeconds,
      setTimerSeconds: store.setTimerSeconds,
      getCurrentPlayer: () => cur,
      onTimeout: () => {}
    };
    GoTimer.start(options);
    advance(10000);
    cur = 2;
    GoTimer.switch(options);
    expect(Math.round(store.seconds[1])).toBe(590);
    advance(4000);
    tick();
    expect(Math.round(store.seconds[2])).toBe(596);
    expect(Math.round(store.seconds[1])).toBe(590);
  });

  test('stop() 定格目前剩餘供存檔', () => {
    const { GoTimer, advance } = clocked();
    const store = timerStore();
    GoTimer.start({
      getTimerSeconds: store.getTimerSeconds,
      setTimerSeconds: store.setTimerSeconds,
      getCurrentPlayer: () => 1,
      onTimeout: () => {}
    });
    advance(7000);
    GoTimer.stop();
    expect(Math.round(store.seconds[1])).toBe(593);
  });

  test('時間到觸發 onTimeout、定格 0、停鐘', () => {
    const { GoTimer, advance, tick, hasInterval } = clocked();
    const store = timerStore({ 1: 3, 2: 600 });
    let fired = null;
    GoTimer.start({
      getTimerSeconds: store.getTimerSeconds,
      setTimerSeconds: store.setTimerSeconds,
      getCurrentPlayer: () => 1,
      onTimeout: (p) => { fired = p; }
    });
    advance(3000);
    tick();
    expect(fired).toBe(1);
    expect(store.seconds[1]).toBe(0);
    expect(GoTimer.formatTime(store.seconds[1])).toBe('00:00');
    expect(hasInterval()).toBe(false);
  });

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
});
