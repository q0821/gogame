// xiangqi-game.js — 象棋棋規（封裝 ffish-es6，無自製規則）。
//
// 合法手、走子、勝負、將軍一律交給 ffish（含蹩馬腿、塞象眼、將帥照面、過河兵）。
// 也負責「螢幕座標 ↔ UCI square」映射（全專案唯一來源），與 fen→渲染用棋子格陣解析。
//
// 座標慣例：grid[row][col]，row 0 = 最上方（黑方底線, rank 10），row 9 = 最下方（紅方底線, rank 1），
//           col 0 = 最左 file a。Fairy-Stockfish 象棋 UCI 用 rank 1–10（1-indexed，非 0–9），
//           file a–i；紅帥起點 = 'e1'、紅兵 = rank 4。（用 ffish legalMoves() 實測校正過。）
import Module from 'ffish-es6';

const FILES = 'abcdefghi';     // col 0..8 → file a..i
const RANKS = 10;              // rank 0..9
const COLS = 9;

// FEN 子 → 中文（大寫=紅、小寫=黑）。fairy 象棋：k將 a士 b象 n馬 r車 c砲 p兵卒
const PIECE_CN = {
  K: '帥', A: '仕', B: '相', N: '傌', R: '俥', C: '炮', P: '兵',
  k: '將', a: '士', b: '象', n: '馬', r: '車', c: '砲', p: '卒',
};

let _ffish = null;
let _board = null;
let _readyPromise = null;

export function ensureReady() {
  if (_readyPromise) return _readyPromise;
  // Vite 打包後 Emscripten 找不到 ffish.wasm（會落在 .vite/deps 拿到 index.html）→
  // 用 locateFile 指向 public 內 vendored 的 ffish.wasm（以 application/wasm 提供）。
  _readyPromise = (async () => {
    _ffish = await Module({ locateFile: (f) => (f.endsWith('.wasm') ? '/engine/xiangqi/' + f : f) });
    return true;
  })().catch((e) => { _readyPromise = null; throw e; });
  return _readyPromise;
}

export async function newGame() {
  await ensureReady();
  if (_board) { _board.delete(); _board = null; }
  _board = new _ffish.Board('xiangqi');
}

/**
 * 建立獨立的 ffish Board（殘局模式自管，不碰對弈用的單例 _board，避免互相污染）。
 * 呼叫端負責 delete()。可帶起始 FEN。
 */
export async function newRawBoard(fen) {
  await ensureReady();
  return fen ? new _ffish.Board('xiangqi', fen) : new _ffish.Board('xiangqi');
}

// ——— 座標映射（唯一來源；改這裡前先肉眼驗證 row/col 沒對調）———

/** grid 座標 → UCI square。row 0=上(rank10)、row 9=下(rank1)、col 0=左(file a)。 */
export function rcToSquare(row, col) { return FILES[col] + (RANKS - row); }

/** UCI square → grid 座標。 */
export function squareToRC(sq) {
  return { col: FILES.indexOf(sq[0]), row: RANKS - Number(sq.slice(1)) };
}

// ——— 局面查詢 ———

export function fen() { return _board.fen(); }
/** true = 紅方（先手）走，false = 黑方走。 */
export function turn() { return _board.turn(); }
export function legalMoves() { return _board.legalMoves().split(/\s+/).filter(Boolean); }
/**
 * 拆解 UCI 著法為 from/to square。⚠️ 象棋 rank 1–10：rank 10 的 square 是 3 字元
 * （如 'b10'），整個著法可能 5 字元（'b10c8'），不能用固定 slice(0,2)/slice(2,4)。
 */
export function splitMove(uci) {
  const m = /^([a-i]\d{1,2})([a-i]\d{1,2})$/.exec(uci);
  return m ? { from: m[1], to: m[2] } : { from: uci.slice(0, 2), to: uci.slice(2) };
}
/** 從某 square 出發的所有合法手（回傳目的 square 陣列）。 */
export function legalTargetsFrom(square) {
  return legalMoves().map(splitMove).filter((m) => m.from === square).map((m) => m.to);
}
/** 走一手（UCI），回傳是否合法。 */
export function move(uci) { return _board.push(uci); }
export function isGameOver() { return _board.isGameOver(); }
/** ffish result：'1-0' 紅勝、'0-1' 黑勝、'1/2-1/2' 和、'*' 進行中。 */
export function result() { return _board.result(); }
export function isCheck() { return _board.isCheck(); }
/** 被將的棋子（將/帥）square 陣列，供將軍高亮。 */
export function checkedSquares() { return _board.checkedPieces().split(/\s+/).filter(Boolean); }
/** 已走手數。 */
export function gamePly() { return _board.gamePly(); }
/** 悔棋一手（退回上一步）。 */
export function undo() { _board.pop(); }
/** 目前最後一手的 UCI（無則 null），供悔棋後重設最後手標記。 */
export function lastMoveUci() {
  const ms = _board.moveStack().split(/\s+/).filter(Boolean);
  return ms.length ? ms[ms.length - 1] : null;
}

/**
 * 解析任一 FEN → grid[row][col]，每格為 { char, red } 或 null。
 * row 0 = 最上方（與 FEN 第一段第一列對齊）。
 */
export function gridFromFen(fenStr) {
  const placement = fenStr.split(' ')[0];
  const rows = placement.split('/');
  const grid = [];
  for (let r = 0; r < rows.length; r++) {
    const row = [];
    for (const ch of rows[r]) {
      if (/\d/.test(ch)) { for (let k = 0; k < Number(ch); k++) row.push(null); }
      else row.push({ char: PIECE_CN[ch] || ch, red: ch === ch.toUpperCase() });
    }
    while (row.length < COLS) row.push(null);
    grid.push(row);
  }
  return grid;
}

/** 目前局面的棋子格陣。 */
export function piecesGrid() { return gridFromFen(fen()); }

/** 本局起始子力減目前子力；殘局不把開題前缺少的子算成被吃。 */
export function capturedPieces(fenStr, initialFen) {
  const remaining = new Map();
  for (const row of gridFromFen(fenStr)) for (const piece of row) {
    if (!piece) continue;
    const key = `${piece.red}:${piece.char}`;
    remaining.set(key, (remaining.get(key) || 0) + 1);
  }
  const lost = new Map();
  for (const row of gridFromFen(initialFen)) for (const piece of row) {
    if (!piece) continue;
    const key = `${piece.red}:${piece.char}`;
    const count = remaining.get(key) || 0;
    if (count) remaining.set(key, count - 1);
    else if (lost.has(key)) lost.get(key).count++;
    else lost.set(key, { ...piece, count: 1 });
  }
  return [...lost.values()];
}

// ——— 覆盤用 ———

/** 整局已走的 UCI 著法陣列。 */
export function moveStackList() { return _board.moveStack().split(/\s+/).filter(Boolean); }

/** 由著法序列重播，回傳每個 ply（含開局）的 FEN 陣列（長度 = moves.length + 1）。 */
export function fensForMoves(moves) {
  const b = new _ffish.Board('xiangqi');
  const fens = [b.fen()];
  for (const m of moves) { b.push(m); fens.push(b.fen()); }
  b.delete();
  return fens;
}

export const COLUMNS = COLS;
export const ROWS = RANKS;
