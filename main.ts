// mend: one command-line tool that applies AI-written edits in four formats
// (unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON tool calls) to a
// tree of text files, to the specification in SPEC.md. Node 22 and its standard
// library alone; run it as `node main.ts [options] [PATCH]` with the working
// directory as the root of the tree. Every file is changed or none.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// this file hands over to runner.ts (the last lines below): keep that hand-over
// and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

interface Split {
  lines: string[];
  br: string;
  ends: boolean;
}

/** A file's lines, its own line break, and whether it ends with one (SPEC.md 3). */
function splitFile(text: string): Split {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, ends: false };
  const parts = text.split(br);
  const ends = text.endsWith(br);
  if (ends) parts.pop();
  return { lines: parts, br, ends };
}

function joinFile(s: Split): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.ends ? s.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = ((tree: Tree) => void) & { move?: { from: string; to: string } };

function mkEdit(fn: (tree: Tree) => void, move?: { from: string; to: string }): Edit {
  const e = fn as Edit;
  if (move !== undefined) e.move = move;
  return e;
}

/** Matching (SPEC.md 5). A line of O or N; `ctx` when it is a context line. */
interface MLine {
  text: string;
  ctx: boolean;
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where `o` occurs in `lines` at `tier` (overlaps count). */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (normLine(lines[i + k]!, tier) !== normLine(o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which `o` occurs in `lines` (at or after `from`), with its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t).filter((i) => i >= from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/**
 * The lines that replace the matched block: a context line is written as the
 * file's own matched line, never the patch's; at tier 2 every other line of N
 * is re-indented from O's first line's leading whitespace to the file's
 * (SPEC.md 5). With an empty O there is no tier, so N is written as it is.
 */
function replacement(fileLines: string[], at: number, o: MLine[], n: MLine[], tier: number): string[] {
  const f = leadWs(fileLines[at] ?? '');
  const p = o.length > 0 ? leadWs(o[0]!.text) : '';
  const out: string[] = [];
  let oi = 0;
  for (const nl of n) {
    if (nl.ctx) {
      while (oi < o.length && !o[oi]!.ctx) oi++;
      out.push(fileLines[at + oi]!);
      oi++;
    } else if (tier === 2 && o.length > 0 && nl.text !== '' && nl.text.trim() !== '' && nl.text.startsWith(p)) {
      out.push(f + nl.text.slice(p.length));
    } else {
      out.push(nl.text);
    }
  }
  return out;
}

/** Replace `k` lines at `at` with `rep`, keeping the file's line break. */
function spliceLines(s: Split, at: number, k: number, rep: string[], ends: boolean): Split {
  const lines = [...s.lines];
  lines.splice(at, k, ...rep);
  return { lines, br: s.br, ends };
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md 6)                                          */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  o: MLine[];
  n: MLine[];
  lastNoEol: boolean;
  plusNoEol: boolean;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` / `+++ `: up to the first tab, spaces removed, `a/`/`b/` stripped. */
function parseDiffPath(raw: string): string | null {
  let p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnifiedHeader(lines: string[], start: number, sec: Section, diffOld: string | null, diffNew: string | null): number {
  let dashOld: string | null | undefined;
  let dashNew: string | null | undefined;
  let renFrom: string | undefined;
  let renTo: string | undefined;
  let i = start;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('@@')) break;
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (dashOld === undefined) {
          dashOld = parseDiffPath(line.slice(4));
          dashNew = parseDiffPath(lines[i + 1]!.slice(4));
          i += 2;
          continue;
        }
        break;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('+++ ')) {
      if (dashNew === undefined) dashNew = parseDiffPath(line.slice(4));
      i++;
      continue;
    }
    if (line.startsWith('rename from ')) {
      if (renFrom === undefined) renFrom = line.slice(12).trim();
      i++;
      continue;
    }
    if (line.startsWith('rename to ')) {
      if (renTo === undefined) renTo = line.slice(10).trim();
      i++;
      continue;
    }
    if (line.startsWith('new file mode')) {
      sec.create = true;
      i++;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      sec.remove = true;
      i++;
      continue;
    }
    i++;
  }
  sec.oldPath = dashOld !== undefined ? dashOld : renFrom !== undefined ? renFrom : diffOld;
  sec.newPath = dashNew !== undefined ? dashNew : renTo !== undefined ? renTo : diffNew;
  return i;
}

function parseUnifiedHunks(lines: string[], start: number, sec: Section): number {
  let i = start;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hm !== null) {
      const h: Hunk = { a: Number(hm[1]), o: [], n: [], lastNoEol: false, plusNoEol: false };
      i++;
      const raw: string[] = [];
      while (i < n) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\') || bl === '') {
          raw.push(bl);
          i++;
        } else break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      const followed: boolean[] = new Array(raw.length).fill(false);
      for (let k = 0; k < raw.length; k++) {
        if (raw[k]!.startsWith('\\')) {
          for (let j = k - 1; j >= 0; j--) {
            if (!raw[j]!.startsWith('\\')) {
              followed[j] = true;
              break;
            }
          }
        }
      }
      let lastContent = -1;
      let lastPlus = -1;
      for (let k = 0; k < raw.length; k++) {
        const bl = raw[k]!;
        if (bl.startsWith(' ')) {
          h.o.push({ text: bl.slice(1), ctx: true });
          h.n.push({ text: bl.slice(1), ctx: true });
          lastContent = k;
        } else if (bl.startsWith('-')) {
          h.o.push({ text: bl.slice(1), ctx: false });
        } else if (bl.startsWith('+')) {
          h.n.push({ text: bl.slice(1), ctx: false });
          lastContent = k;
          lastPlus = k;
        } else if (bl === '') {
          h.o.push({ text: '', ctx: true });
          h.n.push({ text: '', ctx: true });
          lastContent = k;
        }
      }
      h.lastNoEol = lastContent >= 0 && followed[lastContent] === true;
      h.plusNoEol = lastPlus >= 0 && followed[lastPlus] === true;
      sec.hunks.push(h);
      continue;
    }
    if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    i++;
  }
  return i;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      if (m === null || m[1] === '' || m[2] === '') throw new Exit2(`error: parse ${i + 1}`);
      const sec: Section = { oldPath: null, newPath: null, create: false, remove: false, hunks: [] };
      i = parseUnifiedHeader(lines, i + 1, sec, m[1]!, m[2]!);
      i = parseUnifiedHunks(lines, i, sec);
      sections.push(sec);
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: Section = { oldPath: null, newPath: null, create: false, remove: false, hunks: [] };
      i = parseUnifiedHeader(lines, i, sec, null, null);
      i = parseUnifiedHunks(lines, i, sec);
      sections.push(sec);
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i++;
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

/** Apply a section's hunks in order to a file split (SPEC.md 6). */
function applyHunks(s: Split, hunks: Hunk[], strict: boolean, errPath: string): Split {
  let cur = s;
  let d = 0;
  for (const h of hunks) {
    const oText = h.o.map((x) => x.text);
    if (oText.length === 0) {
      const at = Math.min(h.a + d, cur.lines.length);
      const rep = h.n.map((x) => x.text);
      const ends = at === cur.lines.length ? !h.lastNoEol : cur.ends;
      cur = spliceLines(cur, at, 0, rep, ends);
      d += h.n.length;
      continue;
    }
    const found = findTier(cur.lines, oText, strict);
    if (found === null) throw new Fail('no-match', errPath);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    for (const pos of found.occ) {
      if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
    }
    const rep = replacement(cur.lines, best, h.o, h.n, found.tier);
    const touchesEnd = best + oText.length === cur.lines.length;
    const ends = touchesEnd ? !h.lastNoEol : cur.ends;
    cur = spliceLines(cur, best, oText.length, rep, ends);
    d += h.n.length - h.o.length;
  }
  return cur;
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  const apply = (tree: Tree): void => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (sec.create || oldP === null) {
      const p = newP ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let plusNoEol = false;
      for (const h of sec.hunks) {
        let hasPlus = false;
        for (const nl of h.n) {
          if (!nl.ctx) {
            plus.push(nl.text);
            hasPlus = true;
          }
        }
        if (hasPlus) plusNoEol = h.plusNoEol;
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (plusNoEol ? '' : '\n'));
      return;
    }
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (sec.remove || newP === null) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (newP !== oldP) {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const cur = tree.get(oldP);
      if (cur === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applyHunks(splitFile(cur), sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, joinFile(out));
      return;
    }
    const cur = tree.get(oldP);
    if (cur === null) throw new Fail('missing', oldP);
    const out = applyHunks(splitFile(cur), sec.hunks, strict, oldP);
    tree.now.set(oldP, joinFile(out));
  };
  const isMove = sec.oldPath !== null && sec.newPath !== null && sec.oldPath !== sec.newPath && !sec.create && !sec.remove;
  return isMove ? mkEdit(apply, { from: sec.oldPath!, to: sec.newPath! }) : apply;
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md 7)                                    */
/* ------------------------------------------------------------------ */

interface SRBlock {
  path: string;
  old: string[];
  nw: string[];
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchIdx = i;
      let path: string | null = null;
      for (let j = searchIdx - 1; j > prevReplace; j--) {
        const t = lines[j]!;
        if (blank(t)) continue;
        const tr = t.trim();
        if (tr.startsWith('```')) continue;
        path = tr;
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
        path = prevPath;
      }
      let eq = -1;
      for (let j = searchIdx + 1; j < n; j++) {
        if (lines[j]!.trimEnd() === '=======') {
          eq = j;
          break;
        }
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
      }
      if (eq === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
      let rep = -1;
      for (let j = eq + 1; j < n; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
      if (rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
      blocks.push({ path, old: lines.slice(searchIdx + 1, eq), nw: lines.slice(eq + 1, rep) });
      prevPath = path;
      prevReplace = rep;
      i = rep + 1;
    } else {
      i++;
    }
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => srEdit(b, strict));
}

function srEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.old.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, b.nw.length === 0 ? '' : b.nw.join('\n') + '\n');
      return;
    }
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const s = splitFile(cur);
    const found = findTier(s.lines, b.old, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.occ.length > 1) throw new Fail('ambiguous', p);
    const at = found.occ[0]!;
    const o: MLine[] = b.old.map((t) => ({ text: t, ctx: false }));
    const nw: MLine[] = b.nw.map((t) => ({ text: t, ctx: false }));
    const rep = replacement(s.lines, at, o, nw, found.tier);
    tree.now.set(p, joinFile(spliceLines(s, at, b.old.length, rep, s.ends)));
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md 8)                                              */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: MLine[];
  n: MLine[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: VChunk[];
  updateLine: number;
}

/** Drop the trailing empty context lines of the last chunk: blank lines at the end of a section are not part of it. */
function stripTrailingBlanks(chunk: VChunk): void {
  let m = 0;
  for (let k = chunk.o.length - 1; k >= 0; k--) {
    const e = chunk.o[k]!;
    if (e.ctx && e.text === '') m++;
    else break;
  }
  if (m === 0) return;
  chunk.o.splice(chunk.o.length - m, m);
  let removed = 0;
  for (let k = chunk.n.length - 1; k >= 0 && removed < m; k--) {
    if (chunk.n[k]!.ctx) {
      chunk.n.splice(k, 1);
      removed++;
    }
  }
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File:')) {
      const sec: VSection = { kind: 'add', path: line.slice(13).trim(), moveTo: null, lines: [], chunks: [], updateLine: 0 };
      i++;
      const body: string[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:') || l.trim() === '*** End Patch') break;
        if (l.startsWith('+')) body.push(l.slice(1));
        else if (l === '') body.push('');
        else throw new Exit2(`error: parse ${i + 1}`);
        i++;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      sec.lines = body;
      sections.push(sec);
    } else if (line.startsWith('*** Delete File:')) {
      const sec: VSection = { kind: 'delete', path: line.slice(16).trim(), moveTo: null, lines: [], chunks: [], updateLine: 0 };
      i++;
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:') || l.trim() === '*** End Patch') break;
        if (blank(l)) {
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      sections.push(sec);
    } else if (line.startsWith('*** Update File:')) {
      const sec: VSection = { kind: 'update', path: line.slice(16).trim(), moveTo: null, lines: [], chunks: [], updateLine: i + 1 };
      i++;
      if (i < last && lines[i]!.startsWith('*** Move to:')) {
        sec.moveTo = lines[i]!.slice(13).trim();
        i++;
      }
      let cur: VChunk | null = null;
      const finishChunk = (): void => {
        if (cur !== null) {
          sec.chunks.push(cur);
          cur = null;
        }
      };
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:') || l.trim() === '*** End Patch') break;
        if (l.startsWith('*** Move to:')) throw new Exit2(`error: parse ${i + 1}`);
        if (l.startsWith('@@')) {
          finishChunk();
          const a = l.slice(2).trim();
          cur = { anchor: a === '' ? null : a, eof: false, o: [], n: [] };
          i++;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (cur === null) cur = { anchor: null, eof: false, o: [], n: [] };
          cur.eof = true;
          finishChunk();
          i++;
          continue;
        }
        if (cur === null) cur = { anchor: null, eof: false, o: [], n: [] };
        if (l.startsWith(' ')) {
          cur.o.push({ text: l.slice(1), ctx: true });
          cur.n.push({ text: l.slice(1), ctx: true });
        } else if (l.startsWith('-')) {
          cur.o.push({ text: l.slice(1), ctx: false });
        } else if (l.startsWith('+')) {
          cur.n.push({ text: l.slice(1), ctx: false });
        } else if (l === '') {
          cur.o.push({ text: '', ctx: true });
          cur.n.push({ text: '', ctx: true });
        } else throw new Exit2(`error: parse ${i + 1}`);
        i++;
      }
      finishChunk();
      if (sec.chunks.length > 0) stripTrailingBlanks(sec.chunks[sec.chunks.length - 1]!);
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.updateLine}`);
      sections.push(sec);
    } else if (line.trim() === '*** End Patch') {
      for (let j = i + 1; j < last; j++) {
        if (!blank(lines[j]!)) throw new Exit2(`error: parse ${j + 1}`);
      }
      i = last;
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => v4aEdit(s, strict));
}

function v4aEdit(sec: VSection, strict: boolean): Edit {
  const apply = (tree: Tree): void => {
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const moveTo = sec.moveTo;
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let s = splitFile(cur);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        let foundAt: number | null = null;
        for (const t of strict ? [0] : [0, 1, 2]) {
          const occ = occurrences(s.lines, [ch.anchor], t).filter((k) => k >= cursor);
          if (occ.length > 0) {
            foundAt = occ[0]!;
            break;
          }
        }
        if (foundAt === null) throw new Fail('no-match', p);
        cursor = foundAt + 1;
      }
      const oText = ch.o.map((x) => x.text);
      if (oText.length === 0) {
        const at = ch.eof ? s.lines.length : cursor;
        const rep = ch.n.map((x) => x.text);
        s = spliceLines(s, at, 0, rep, s.ends);
        cursor = at + rep.length;
        continue;
      }
      let hit: { tier: number; at: number } | null = null;
      for (const t of strict ? [0] : [0, 1, 2]) {
        const occ = occurrences(s.lines, oText, t).filter((k) => k >= cursor && (!ch.eof || k + oText.length === s.lines.length));
        if (occ.length > 0) {
          hit = { tier: t, at: occ[0]! };
          break;
        }
      }
      if (hit === null) throw new Fail('no-match', p);
      const rep = replacement(s.lines, hit.at, ch.o, ch.n, hit.tier);
      s = spliceLines(s, hit.at, oText.length, rep, s.ends);
      cursor = hit.at + rep.length;
    }
    const out = joinFile(s);
    if (moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(moveTo, out);
    } else {
      tree.now.set(p, out);
    }
  };
  return sec.moveTo !== null ? mkEdit(apply, { from: sec.path, to: sec.moveTo }) : apply;
}

/* ------------------------------------------------------------------ */
/* Entry point (SPEC.md 1, 2 and 10)                                    */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const used = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const e of edits) {
    if (e.move === undefined) continue;
    const m = e.move;
    if (tree.original(m.from) !== null && tree.get(m.from) === null && tree.original(m.to) === null && tree.get(m.to) !== null) {
      rows.push({ key: m.to, line: `R ${m.from} -> ${m.to}` });
      used.add(m.from);
      used.add(m.to);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (used.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
