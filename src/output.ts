/** Hand-rolled ANSI styling. Zero dependencies, honours NO_COLOR and non-TTY. */

export interface Style {
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
  magenta(s: string): string;
}

const ESC = String.fromCharCode(27);
const wrap = (open: number, close: number) => (s: string) => `${ESC}[${open}m${s}${ESC}[${close}m`;
const id = (s: string) => s;

export const ansi: Style = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  cyan: wrap(36, 39),
  magenta: wrap(35, 39),
};

export const plain: Style = {
  bold: id,
  dim: id,
  red: id,
  green: id,
  yellow: id,
  cyan: id,
  magenta: id,
};

export function colorEnabled(stream: NodeJS.WriteStream = process.stdout): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  if (process.env.FORCE_COLOR === '0') return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '') return true;
  return Boolean(stream.isTTY);
}

export function styleFor(stream: NodeJS.WriteStream = process.stdout): Style {
  return colorEnabled(stream) ? ansi : plain;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

export function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

const ANSI_RE = new RegExp(`${ESC}\[[0-9;?]*[ -/]*[@-~]`, 'g');

/** Strip ANSI escape sequences from tool output so tails stay readable. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '').replace(/\r(?!\n)/g, '\n');
}
