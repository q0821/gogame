// xiangqi-ui.js — 象棋盤、實體吃子時序與被吃棋子資訊；對局狀態由控制器持有。
//
// 棋子畫在「交叉點」上（非格子內），9 直線 x 10 橫線。河界處內側直線斷開，九宮畫斜線。
// 棋子為實體立體感（徑向漸層凸面 + 投影 + 描邊 + 高光）。
// view = { grid, selected, legalTargets, lastMove, checkRC, anim }；座標 row 0=上、col 0=左。
//   anim 隱藏起點及被吃格，分別畫攻方落定與受擊棋子的離盤效果。
import { COLUMNS, ROWS, squareToRC, splitMove, capturedPieces } from './xiangqi-game.js';
import { paintBoardBase, paintWoodGrain, paintVignette } from './board-texture.js';
import { posHash01, engraveText, paintPieceGrain } from './piece-texture.js';
import { makeHiDPIOffscreen, hidpiScale } from './canvas-dpr.js';
import { prefersReducedMotion } from './motion.js';

// 與 style.css --font-serif 同步（canvas 無法吃 CSS 變數，故重複一份系統宋體 stack）
const SERIF = '"Noto Serif TC","Noto Serif CJK TC","Songti TC","Songti SC","STSong","PMingLiU","MingLiU","SimSun",serif';

const LINE = '#5b4423';
const SEL = '#c0392b';
const HINT = 'rgba(43,90,40,0.55)';
const LAST = 'rgba(201,140,40,0.30)';
const CHECK = '#d23b3b';

/** 依容器寬度算 cellSize 並設定 canvas 尺寸（含 DPR）。padding 留足棋子半徑+陰影避免切邊。 */
export function resizeXiangqiCanvas(deps, maxWidthPx) {
  const { canvas } = deps;
  const cols = COLUMNS - 1;            // 8 水平間隔
  const rows = ROWS - 1;               // 9 垂直間隔
  // 先依寬度估 cell（padding 取 cell 的比例，故聯立求解）
  const usableW = Math.min(maxWidthPx || 360, 480);
  // w = pad*2 + cols*cell，pad = cell*PAD_RATIO → w = cell*(cols + 2*PAD_RATIO)
  const PAD_RATIO = 0.62;
  const cell = Math.max(30, Math.floor(usableW / (cols + 2 * PAD_RATIO)));
  const pad = Math.round(cell * PAD_RATIO);
  deps.cellSize = cell;
  deps.padding = pad;
  const w = pad * 2 + cols * cell;
  const h = pad * 2 + rows * cell;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  deps.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  deps._w = w; deps._h = h;
  return { w, h, cell };
}

function ix(deps, col) { return deps.padding + col * deps.cellSize; }
function iy(deps, row) { return deps.padding + row * deps.cellSize; }
function line(ctx, x1, y1, x2, y2) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }

/** 兵卒位（rows 3,6 cols 0,2,4,6,8）與炮位（rows 2,7 cols 1,7）的傳統直角標線；邊列只畫內側。 */
function drawPositionMarks(deps) {
  const ctx = deps.ctx, cell = deps.cellSize;
  const g = cell * 0.10, len = cell * 0.16;
  ctx.strokeStyle = LINE; ctx.lineWidth = 1.2;
  const pts = [];
  for (const c of [0, 2, 4, 6, 8]) { pts.push([3, c]); pts.push([6, c]); }
  for (const c of [1, 7]) { pts.push([2, c]); pts.push([7, c]); }
  for (const [r, c] of pts) {
    const x = ix(deps, c), y = iy(deps, r);
    for (const dx of [-1, 1]) {
      if ((dx < 0 && c === 0) || (dx > 0 && c === COLUMNS - 1)) continue; // 邊列省略外側
      for (const dy of [-1, 1]) {
        const px = x + dx * g, py = y + dy * g;
        ctx.beginPath();
        ctx.moveTo(px + dx * len, py); ctx.lineTo(px, py); ctx.lineTo(px, py + dy * len);
        ctx.stroke();
      }
    }
  }
}

/** 畫一顆實體立體棋子（投影 + 凸面漸層 + 描邊 + 高光 + 字）。 */
function drawPiece(ctx, x, y, r, piece, lifted) {
  // 防護：座標/半徑非有限值時跳過（createRadialGradient 收到 NaN 會拋例外凍住整盤）
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(r) || r <= 0) return;
  const edge = piece.red ? '#a8392e' : '#2c2417';
  // 1) 投影（只在底盤填色時開 shadow，畫完即關，避免描邊/字糊掉）
  ctx.save();
  ctx.shadowColor = 'rgba(60,40,15,0.40)';
  ctx.shadowBlur = lifted ? r * 0.6 : r * 0.34;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = lifted ? r * 0.34 : r * 0.20;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = '#e9d3a4';
  ctx.fill();
  ctx.restore();
  // 2) 凸面漸層（左上亮 → 右下暗）
  const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.38, r * 0.15, x, y, r);
  g.addColorStop(0, '#fbf3df');
  g.addColorStop(0.55, '#f0e0bc');
  g.addColorStop(1, '#dcc295');
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  // 2b) 棋面年輪（依位置定死，重繪不抖動；clip 略縮避免壓到描邊）
  const seed = posHash01(x, y);
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r * 0.97, 0, Math.PI * 2);
  ctx.clip();
  paintPieceGrain(ctx, 'ring', seed, { x, y, r });
  ctx.restore();
  // 3) 外描邊 + 內圈
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(2, r * 0.10);
  ctx.strokeStyle = edge;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, r * 0.80, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(1, r * 0.05);
  ctx.strokeStyle = piece.red ? 'rgba(168,57,46,0.5)' : 'rgba(44,36,23,0.45)';
  ctx.stroke();
  // 3b) 內圈淺浮雕：右下內陰影 + 左上邊緣高光，營造陰刻圓底質感（幅度小，不影響文字辨識）
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r * 0.80, 0, Math.PI * 2);
  ctx.clip();
  const shade = ctx.createRadialGradient(x + r * 0.3, y + r * 0.32, r * 0.3, x, y, r * 0.82);
  shade.addColorStop(0, 'rgba(0,0,0,0)');
  shade.addColorStop(1, piece.red ? 'rgba(120,38,25,0.18)' : 'rgba(30,20,8,0.18)');
  ctx.fillStyle = shade;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
  const rim = ctx.createRadialGradient(x - r * 0.32, y - r * 0.36, 0, x - r * 0.32, y - r * 0.36, r * 0.95);
  rim.addColorStop(0, 'rgba(255,255,255,0.32)');
  rim.addColorStop(0.45, 'rgba(255,255,255,0)');
  ctx.fillStyle = rim;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
  ctx.restore();
  // 3c) 底緣側面暗帶：下半弧一道低對比暗帶，模擬圓柱側面厚度
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.beginPath();
  ctx.arc(x, y, r * 0.88, Math.PI * 0.15, Math.PI * 0.85);
  ctx.lineWidth = r * 0.16;
  ctx.strokeStyle = 'rgba(90,60,20,0.14)';
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.restore();
  // 4) 左上高光弧
  ctx.beginPath();
  ctx.arc(x - r * 0.18, y - r * 0.20, r * 0.62, Math.PI * 1.05, Math.PI * 1.62);
  ctx.lineWidth = r * 0.12;
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.lineCap = 'butt';
  // 5) 字（陰刻，亮邊/刻痕用預設值）
  engraveText(ctx, piece.char, x, y + r * 0.04, Math.round(r * 1.12), { ink: edge, font: SERIF });
}

// ——— 棋盤背景 offscreen 快取（底色＋木紋＋格線＋九宮＋標線＋河界字＋vignette，只在尺寸變動時重算） ———
let _bg = null;
let _bgKey = '';

function buildBackground(deps) {
  const key = `${deps._w}_${deps._h}_${deps.cellSize}_${hidpiScale()}`;
  if (_bg && _bgKey === key) return _bg;
  const { off, ctx } = makeHiDPIOffscreen(deps._w, deps._h);
  const bg = { ctx, cellSize: deps.cellSize, padding: deps.padding };
  const cell = deps.cellSize;

  paintBoardBase(ctx, deps._w, deps._h, { top: '#f0d194', mid: '#e9c987', bottom: '#d6ad64' });
  paintWoodGrain(ctx, deps._w, deps._h, { seed: 17, grainColor: 'rgba(80,58,26,0.10)', speckColor: 'rgba(255,244,214,0.10)' });

  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1.4;

  // 橫線
  for (let r = 0; r < ROWS; r++) line(ctx, ix(bg, 0), iy(bg, r), ix(bg, COLUMNS - 1), iy(bg, r));
  // 直線：邊線整條，內側在河界斷開
  for (let c = 0; c < COLUMNS; c++) {
    if (c === 0 || c === COLUMNS - 1) {
      line(ctx, ix(bg, c), iy(bg, 0), ix(bg, c), iy(bg, ROWS - 1));
    } else {
      line(ctx, ix(bg, c), iy(bg, 0), ix(bg, c), iy(bg, 4));
      line(ctx, ix(bg, c), iy(bg, 5), ix(bg, c), iy(bg, ROWS - 1));
    }
  }
  // 九宮斜線
  line(ctx, ix(bg, 3), iy(bg, 0), ix(bg, 5), iy(bg, 2));
  line(ctx, ix(bg, 5), iy(bg, 0), ix(bg, 3), iy(bg, 2));
  line(ctx, ix(bg, 3), iy(bg, 7), ix(bg, 5), iy(bg, 9));
  line(ctx, ix(bg, 5), iy(bg, 7), ix(bg, 3), iy(bg, 9));

  // 兵卒位、炮位的傳統直角標線
  drawPositionMarks(bg);

  // 河界字（陰刻，亮/暗幅度壓低避免搶戲）
  const riverY = (iy(bg, 4) + iy(bg, 5)) / 2;
  const riverOpts = {
    ink: 'rgba(91,68,35,0.5)',
    font: SERIF,
    weight: 400, // 原樣式非粗體，維持原字重
    lightColor: 'rgba(255,255,255,0.18)',
    shadowColor: 'rgba(0,0,0,0.14)',
  };
  engraveText(ctx, '楚 河', ix(bg, 1.5), riverY, cell * 0.46, riverOpts);
  engraveText(ctx, '漢 界', ix(bg, 6.5), riverY, cell * 0.46, riverOpts);

  paintVignette(ctx, deps._w, deps._h);

  _bg = off; _bgKey = key;
  return off;
}

export function drawXiangqi(deps, view) {
  const { ctx } = deps;
  const cell = deps.cellSize;
  ctx.clearRect(0, 0, deps._w, deps._h);
  ctx.drawImage(buildBackground(deps), 0, 0, deps._w, deps._h);

  // 最後一手標記
  if (view.lastMove) {
    for (const sq of view.lastMove) {
      const p = view.rc(sq);
      ctx.fillStyle = LAST;
      ctx.beginPath();
      ctx.arc(ix(deps, p.col), iy(deps, p.row), cell * 0.46, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 將軍：被將將帥紅色高亮環
  if (view.checkRC) {
    ctx.strokeStyle = CHECK;
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.arc(ix(deps, view.checkRC.col), iy(deps, view.checkRC.row), cell * 0.5, 0, Math.PI * 2);
    ctx.stroke();
  }

  const radius = cell * 0.40;

  // 棋子（動畫時隱藏起點格）
  const grid = view.grid;
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      const piece = grid[r][c];
      if (!piece) continue;
      if (view.anim && view.anim.hideRow === r && view.anim.hideCol === c) continue;
      if (view.anim?.victim && view.anim.toRow === r && view.anim.toCol === c) continue;
      drawPiece(ctx, ix(deps, c), iy(deps, r), radius, piece, false);
    }
  }

  // 選取環
  if (view.selected) {
    const p = view.rc(view.selected);
    ctx.strokeStyle = SEL;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(ix(deps, p.col), iy(deps, p.row), radius + 4, 0, Math.PI * 2);
    ctx.stroke();
  }
  // 合法目的點
  if (view.legalTargets) {
    for (const sq of view.legalTargets) {
      const p = view.rc(sq);
      const occupied = view.grid[p.row][p.col];
      if (occupied) {
        ctx.strokeStyle = HINT;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(ix(deps, p.col), iy(deps, p.row), radius + 4, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = HINT;
        ctx.beginPath();
        ctx.arc(ix(deps, p.col), iy(deps, p.row), cell * 0.13, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // 最佳變化預想（PV）：箭頭 + 序號（覆盤分析後）
  if (view.pv && view.pv.length) {
    view.pv.forEach((mv, i) => {
      const a = view.rc(mv.from), b = view.rc(mv.to);
      const op = i === 0 ? 0.92 : i === 1 ? 0.62 : 0.4;
      drawArrow(ctx, ix(deps, a.col), iy(deps, a.row), ix(deps, b.col), iy(deps, b.row), `rgba(30,111,192,${op})`, Math.max(2.5, cell * 0.11), radius * 0.62);
      // 序號徽章於終點
      const bx = ix(deps, b.col), by = iy(deps, b.row);
      ctx.beginPath();
      ctx.arc(bx + radius * 0.5, by - radius * 0.5, radius * 0.32, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(30,111,192,${op})`;
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `700 ${Math.round(radius * 0.42)}px ${SERIF}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), bx + radius * 0.5, by - radius * 0.5 + 1);
    });
  }

  // 受擊子獨立離盤，不再與進攻子重疊滑動。
  if (view.anim?.victim) {
    const a = view.anim;
    ctx.save();
    ctx.globalAlpha = a.victimOpacity;
    drawPiece(ctx, a.victimX, a.victimY, radius * a.victimScale, a.victim, a.victimOpacity < 1);
    ctx.restore();
  }
  if (view.anim?.piece) {
    const a = view.anim;
    drawPiece(ctx, a.x, a.y, radius * (a.scale ?? 1), a.piece, a.lifted ?? true);
  }
}

/** 由 (x1,y1) 指向 (x2,y2) 的箭頭；shrink 為兩端內縮（避免蓋住棋子中心）。 */
function drawArrow(ctx, x1, y1, x2, y2, color, width, shrink) {
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const sx = x1 + Math.cos(ang) * shrink, sy = y1 + Math.sin(ang) * shrink;
  const ex = x2 - Math.cos(ang) * shrink, ey = y2 - Math.sin(ang) * shrink;
  ctx.strokeStyle = color; ctx.fillStyle = color;
  ctx.lineWidth = width; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
  const head = width * 2.6;
  ctx.beginPath();
  ctx.moveTo(ex, ey);
  ctx.lineTo(ex - head * Math.cos(ang - Math.PI / 6), ey - head * Math.sin(ang - Math.PI / 6));
  ctx.lineTo(ex - head * Math.cos(ang + Math.PI / 6), ey - head * Math.sin(ang + Math.PI / 6));
  ctx.closePath(); ctx.fill();
  ctx.lineCap = 'butt';
}

/** 兩模式共用的接觸→提子→落定時序；取消會清掉每個 frame/timer。 */
export function animateXiangqiMove(deps, grid, uci, { onContact, onFinish }) {
  const { from, to } = splitMove(uci);
  const source = squareToRC(from), target = squareToRC(to);
  const piece = grid[source.row]?.[source.col], victim = grid[target.row]?.[target.col];
  const contactMs = victim ? 180 : 280;
  const duration = victim ? 420 : 280;
  let frame = 0, timer = 0, done = false, contacted = false, committed = false;
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  const contact = () => {
    if (contacted) return;
    contacted = true;
    committed = onContact(victim) !== false;
  };
  const finish = (complete) => {
    if (done) return;
    if (complete) contact();
    done = true;
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    onFinish(committed);
    resolve(committed);
  };
  const start = performance.now();
  const step = (now) => {
    if (done) return;
    if (prefersReducedMotion() || document.hidden) { finish(true); return; }
    const elapsed = now - start;
    if (elapsed >= contactMs) contact();
    if (contacted && !committed) { finish(false); return; }
    const cell = deps.cellSize;
    const x0 = ix(deps, source.col), y0 = iy(deps, source.row);
    const x1 = ix(deps, target.col), y1 = iy(deps, target.row);
    const distance = Math.hypot(x1 - x0, y1 - y0) || 1;
    const ux = (x1 - x0) / distance, uy = (y1 - y0) / distance;
    const approach = Math.min(1, elapsed / contactMs);
    const ease = approach < 0.5 ? 2 * approach * approach : 1 - (-2 * approach + 2) ** 2 / 2;
    const exit = Math.max(0, Math.min(1, (elapsed - contactMs) / 180));
    const settle = Math.max(0, Math.min(1, (elapsed - contactMs) / 240));
    // 先在棋緣相接，再讓攻方推入空出的交叉點；只留一次短促回頓。
    const gap = victim ? cell * 0.66 : 0;
    const advance = victim ? 1 - (1 - settle) ** 3 : 0;
    const recoil = victim ? Math.sin(settle * Math.PI) * cell * 0.045 : 0;
    const anim = {
      hideRow: source.row, hideCol: source.col, piece,
      x: x0 + (x1 - ux * gap - x0) * ease + ux * (gap * advance - recoil),
      y: y0 + (y1 - uy * gap - y0) * ease + uy * (gap * advance - recoil),
      scale: 1 + Math.sin(settle * Math.PI) * 0.025,
      lifted: elapsed < contactMs,
      victim, toRow: target.row, toCol: target.col,
      victimX: x1 + ux * cell * 0.18 * exit,
      victimY: y1 + uy * cell * 0.18 * exit - cell * 0.22 * exit,
      victimScale: 1 - 0.3 * exit,
      victimOpacity: 1 - exit,
    };
    drawXiangqi(deps, { grid, anim, rc: squareToRC });
    if (elapsed >= duration) finish(true);
    else frame = requestAnimationFrame(step);
  };
  if (!piece || prefersReducedMotion() || document.hidden) finish(true);
  else {
    frame = requestAnimationFrame(step);
    timer = setTimeout(() => finish(true), duration + 120);
  }
  return { promise, cancel: () => finish(false) };
}

/** 被吃棋子為唯讀文字，不暗示可點擊或可打入。 */
export function renderCapturedPieces(container, fen, initialFen) {
  const pieces = capturedPieces(fen, initialFen);
  const totals = { redLost: 0, blackLost: 0 };
  for (const side of ['red', 'black']) {
    const groups = pieces.filter((p) => p.red === (side === 'red'));
    totals[side + 'Lost'] = groups.reduce((sum, p) => sum + p.count, 0);
    const row = container?.querySelector(`.capture-row[data-side="${side}"]`);
    const list = row?.querySelector('.capture-pieces');
    if (!list) continue;
    list.replaceChildren();
    if (!groups.length) {
      const empty = document.createElement('span');
      empty.className = 'capture-empty';
      empty.textContent = '尚無';
      list.append(empty);
      continue;
    }
    for (const piece of groups) {
      const token = document.createElement('span');
      token.className = 'captured-piece ' + side;
      const glyph = document.createElement('span');
      glyph.className = 'captured-glyph';
      glyph.textContent = piece.char;
      token.append(glyph);
      if (piece.count > 1) {
        const count = document.createElement('span');
        count.className = 'captured-count';
        count.textContent = `×${piece.count}`;
        token.append(count);
      }
      list.append(token);
    }
  }
  return totals;
}

export function announceXiangqiCapture(feedback, victim) {
  if (!feedback || !victim) return;
  feedback.dataset.captureSide = victim.red ? 'red' : 'black';
  feedback.textContent = `${victim.red ? '紅' : '黑'}方${victim.char}被吃`;
}
