// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does all of
// SPEC.md: the command line, the output and exit codes, safe paths, format detection, JSON edits, the
// all-or-nothing write, three-tier line matching, unified diffs, SEARCH/REPLACE blocks and V4A patches.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
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

type Edit = (tree: Tree) => void;

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

/** A file split into lines: its line break, its lines, and whether it ends with a line break. */
interface FileParts {
  lines: string[];
  br: string;
  final: boolean;
}
function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}
function joinFile(f: FileParts): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadOf = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** Positions where O occurs in file at one tier, at or after `from`. */
function occurrencesAtTier(file: string[], O: string[], tier: number, from: number): number[] {
  const norm = tier === 0 ? (s: string): string => s : tier === 1 ? trimTrail : trimBoth;
  const o = O.map(norm);
  const out: number[] = [];
  for (let i = from; i + O.length <= file.length; i++) {
    let ok = true;
    for (let k = 0; k < O.length; k++) {
      if (norm(file[i + k]!) !== o[k]) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs at or after `from`. */
function findOccurrences(file: string[], O: string[], strict: boolean, from: number): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrencesAtTier(file, O, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One body line of a hunk or chunk: a context line, an old line, or a new line. */
type BodyLine = { kind: 'ctx' | 'old' | 'new'; text: string };

/**
 * Replace the O lines (the ctx and old body lines) at `at` with the body. Context lines are written as the
 * file's own matched lines; at tier 2 the other new lines are re-indented from O's first line to the file's.
 */
function applyBody(file: string[], body: BodyLine[], at: number, tier: number): string[] {
  const O = body.filter((b) => b.kind !== 'new').map((b) => b.text);
  const F = O.length > 0 ? leadOf(file[at] ?? '') : '';
  const P = O.length > 0 ? leadOf(O[0]!) : '';
  const out: string[] = [];
  let j = at;
  for (const b of body) {
    if (b.kind === 'ctx') { out.push(file[j]!); j++; }
    else if (b.kind === 'old') { j++; }
    else {
      let t = b.text;
      if (tier === 2 && O.length > 0 && t !== '' && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
      out.push(t);
    }
  }
  return [...file.slice(0, at), ...out, ...file.slice(at + O.length)];
}

/** The last body line that is a context or new line, or -1 when there is none. */
function lastCtxPlus(body: BodyLine[]): number {
  let idx = -1;
  for (let j = 0; j < body.length; j++) {
    if (body[j]!.kind !== 'old') idx = j;
  }
  return idx;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs
// ---------------------------------------------------------------------------

/** One hunk of a unified section: the old start line A and its body. */
interface Hunk {
  a: number;
  body: BodyLine[];
  /** backslashAfter[j] is true when a `\` line follows body[j]. */
  backslashAfter: boolean[];
}
/** One section of a unified diff. A path is undefined when not named, null when /dev/null. */
interface UniSection {
  dashOld: string | null | undefined;
  dashNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;

/** The path a `--- ` or `+++ ` line names: null for /dev/null. */
function dashPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/')) t = t.slice(2);
  else if (t.startsWith('b/')) t = t.slice(2);
  return t;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let hasPair = false;

  const newSection = (): UniSection => {
    const s: UniSection = { dashOld: undefined, dashNew: undefined, renameFrom: undefined, renameTo: undefined, diffOld: undefined, diffNew: undefined, isCreate: false, isDelete: false, hunks: [] };
    sections.push(s);
    cur = s;
    inHeader = true;
    hasPair = false;
    return s;
  };

  let i = 0;
  while (i < lines.length) {
    const L = lines[i]!;
    if (L.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(L);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.diffOld = m[1]!;
      s.diffNew = m[2]!;
      i++;
      continue;
    }
    if (L.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !hasPair) {
        cur.dashOld = dashPath(L);
        cur.dashNew = dashPath(lines[i + 1]!);
        hasPair = true;
      } else {
        const s = newSection();
        s.dashOld = dashPath(L);
        s.dashNew = dashPath(lines[i + 1]!);
        hasPair = true;
      }
      i += 2;
      continue;
    }
    if (L.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (L.startsWith('@@')) {
      const m = HUNK_HEAD.exec(L);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const a = Number(m[1]);
      const body: BodyLine[] = [];
      const backslashAfter: boolean[] = [];
      i++;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b.startsWith(' ')) { body.push({ kind: 'ctx', text: b.slice(1) }); backslashAfter.push(false); i++; }
        else if (b.startsWith('-')) { body.push({ kind: 'old', text: b.slice(1) }); backslashAfter.push(false); i++; }
        else if (b.startsWith('+')) { body.push({ kind: 'new', text: b.slice(1) }); backslashAfter.push(false); i++; }
        else if (b.startsWith('\\')) { if (body.length > 0) backslashAfter[body.length - 1] = true; i++; }
        else if (b === '') { body.push({ kind: 'ctx', text: '' }); backslashAfter.push(false); i++; }
        else break;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.text === '') {
        body.pop();
        backslashAfter.pop();
      }
      cur.hunks.push({ a, body, backslashAfter });
      continue;
    }
    if (cur !== null && inHeader) {
      if (L.startsWith('rename from ')) cur.renameFrom = L.slice('rename from '.length).trim();
      else if (L.startsWith('rename to ')) cur.renameTo = L.slice('rename to '.length).trim();
      else if (L.startsWith('new file mode')) cur.isCreate = true;
      else if (L.startsWith('deleted file mode')) cur.isDelete = true;
    }
    i++;
  }

  return sections.map((s) => {
    const oldP = s.dashOld !== undefined ? s.dashOld : s.renameFrom !== undefined ? s.renameFrom : s.diffOld;
    const newP = s.dashNew !== undefined ? s.dashNew : s.renameTo !== undefined ? s.renameTo : s.diffNew;
    return (tree: Tree): void => {
      if (oldP !== null && oldP !== undefined && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && newP !== undefined && newP !== oldP && !safe(newP)) throw new Fail('unsafe', newP);
      const create = oldP === null || s.isCreate;
      const del = newP === null || s.isDelete;
      if (create) {
        if (newP === null || newP === undefined) return;
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const made: string[] = [];
        let lastPlusBackslash = false;
        let hasPlus = false;
        for (const h of s.hunks) {
          for (let j = 0; j < h.body.length; j++) {
            if (h.body[j]!.kind === 'new') {
              made.push(h.body[j]!.text);
              hasPlus = true;
              lastPlusBackslash = h.backslashAfter[j]!;
            }
          }
        }
        const final = hasPlus ? !lastPlusBackslash : false;
        tree.now.set(newP, made.length === 0 ? '' : made.join('\n') + (final ? '\n' : ''));
        return;
      }
      if (del) {
        if (oldP === null || oldP === undefined) return;
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        tree.now.set(oldP, null);
        return;
      }
      const op = oldP as string;
      const np = newP as string;
      if (op !== np) {
        if (tree.get(op) === null) throw new Fail('missing', op);
        if (tree.get(np) !== null) throw new Fail('exists', np);
      } else if (tree.get(op) === null) {
        throw new Fail('missing', op);
      }
      const fp = splitFile(tree.get(op)!);
      let d = 0;
      for (const h of s.hunks) {
        const O = h.body.filter((b) => b.kind !== 'new').map((b) => b.text);
        const N = h.body.filter((b) => b.kind !== 'old').map((b) => b.text);
        const last = lastCtxPlus(h.body);
        const noBreak = last >= 0 && h.backslashAfter[last] === true;
        if (O.length === 0) {
          const at = Math.min(h.a + d, fp.lines.length);
          const atEnd = at === fp.lines.length;
          fp.lines = applyBody(fp.lines, h.body, at, 0);
          if (atEnd && h.body.length > 0) fp.final = !noBreak;
          d += N.length;
          continue;
        }
        const found = findOccurrences(fp.lines, O, strict, 0);
        if (found === null) throw new Fail('no-match', op);
        const target = h.a - 1 + d;
        let best = found.pos[0]!;
        let bestDist = Math.abs(best - target);
        for (let k = 1; k < found.pos.length; k++) {
          const p = found.pos[k]!;
          const dist = Math.abs(p - target);
          if (dist < bestDist) { best = p; bestDist = dist; }
        }
        const runsToEnd = best + O.length === fp.lines.length;
        fp.lines = applyBody(fp.lines, h.body, best, found.tier);
        if (runsToEnd) fp.final = !noBreak;
        d += N.length - O.length;
      }
      const out = joinFile(fp);
      if (op !== np) {
        tree.now.set(np, out);
        tree.now.set(op, null);
        tree.moves.push([op, np]);
      } else {
        tree.now.set(op, out);
      }
    };
  });
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks
// ---------------------------------------------------------------------------

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      let path: string | null = null;
      for (let j = i - 1; j > prevEnd; j--) {
        const t = lines[j]!.trim();
        if (t === '') continue;
        if (t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${i + 1}`);
        path = prevPath;
      }
      let sep = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '=======') { sep = j; break; }
      }
      if (sep === -1) throw new Exit2(`error: parse ${i + 1}`);
      let end = -1;
      for (let j = sep + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { end = j; break; }
      }
      if (end === -1) throw new Exit2(`error: parse ${i + 1}`);
      blocks.push({ path, oldLines: lines.slice(i + 1, sep), newLines: lines.slice(sep + 1, end) });
      prevPath = path;
      prevEnd = end;
      i = end + 1;
    } else {
      i++;
    }
  }
  return blocks.map((b) => (tree: Tree): void => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(b.path);
    if (cur === null) throw new Fail('missing', b.path);
    const fp = splitFile(cur);
    const found = findOccurrences(fp.lines, b.oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.pos.length > 1) throw new Fail('ambiguous', b.path);
    const body: BodyLine[] = [
      ...b.oldLines.map((t): BodyLine => ({ kind: 'old', text: t })),
      ...b.newLines.map((t): BodyLine => ({ kind: 'new', text: t })),
    ];
    fp.lines = applyBody(fp.lines, body, found.pos[0]!, found.tier);
    tree.now.set(b.path, joinFile(fp));
  });
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches
// ---------------------------------------------------------------------------

/** One chunk of an Update File section: an optional anchor and its body. */
interface V4AChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}
interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: V4AChunk[];
}

/** A V4A header line `*** Add File:` / `*** Move to:` etc: the path after it, or null when no match. */
function v4aHeader(line: string, prefix: string): string | null {
  if (line === prefix) return '';
  if (line.startsWith(prefix + ' ')) return line.slice(prefix.length + 1).trim();
  return null;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) { last = k; break; }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: V4ASection[] = [];
  let i = first + 1;
  while (i < last) {
    const L = lines[i]!;
    if (blank(L)) { i++; continue; }
    const addPath = v4aHeader(L, '*** Add File:');
    if (addPath !== null) {
      const addLines: string[] = [];
      i++;
      while (i < last) {
        const b = lines[i]!;
        if (v4aHeader(b, '*** Add File:') !== null || v4aHeader(b, '*** Delete File:') !== null || v4aHeader(b, '*** Update File:') !== null) break;
        if (b.startsWith('+')) { addLines.push(b.slice(1)); i++; }
        else if (blank(b)) { addLines.push(''); i++; }
        else throw new Exit2(`error: parse ${i + 1}`);
      }
      while (addLines.length > 0 && addLines[addLines.length - 1] === '') addLines.pop();
      sections.push({ kind: 'add', path: addPath, moveTo: null, addLines, chunks: [] });
      continue;
    }
    const delPath = v4aHeader(L, '*** Delete File:');
    if (delPath !== null) {
      sections.push({ kind: 'delete', path: delPath, moveTo: null, addLines: [], chunks: [] });
      i++;
      continue;
    }
    const updPath = v4aHeader(L, '*** Update File:');
    if (updPath !== null) {
      const sec: V4ASection = { kind: 'update', path: updPath, moveTo: null, addLines: [], chunks: [] };
      const updateLine = i;
      i++;
      const mv = i < last ? v4aHeader(lines[i]!, '*** Move to:') : null;
      if (mv !== null) {
        sec.moveTo = mv;
        i++;
      }
      let curChunk: V4AChunk | null = null;
      while (i < last) {
        const b = lines[i]!;
        if (v4aHeader(b, '*** Add File:') !== null || v4aHeader(b, '*** Delete File:') !== null || v4aHeader(b, '*** Update File:') !== null) break;
        if (v4aHeader(b, '*** Move to:') !== null) throw new Exit2(`error: parse ${i + 1}`);
        if (b.startsWith('@@')) {
          const anchorText = b.slice(2).trim();
          curChunk = { anchor: anchorText === '' ? null : anchorText, body: [], eof: false };
          sec.chunks.push(curChunk);
          i++;
          continue;
        }
        if (b === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${i + 1}`);
          curChunk.eof = true;
          curChunk = null;
          i++;
          continue;
        }
        if (b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b === '') {
          if (curChunk === null) {
            if (sec.chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
            curChunk = { anchor: null, body: [], eof: false };
            sec.chunks.push(curChunk);
          }
          if (b.startsWith(' ')) curChunk.body.push({ kind: 'ctx', text: b.slice(1) });
          else if (b.startsWith('-')) curChunk.body.push({ kind: 'old', text: b.slice(1) });
          else if (b.startsWith('+')) curChunk.body.push({ kind: 'new', text: b.slice(1) });
          else curChunk.body.push({ kind: 'ctx', text: '' });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (sec.chunks.length > 0) {
        const lc = sec.chunks[sec.chunks.length - 1]!;
        while (lc.body.length > 0 && lc.body[lc.body.length - 1]!.kind === 'ctx' && lc.body[lc.body.length - 1]!.text === '') lc.body.pop();
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
      sections.push(sec);
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }

  return sections.map((sec) => (tree: Tree): void => {
    if (sec.kind === 'add') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const cur = tree.get(sec.path);
    if (cur === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const fp = splitFile(cur);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        const found = findOccurrences(fp.lines, [chunk.anchor], strict, cursor);
        if (found === null) throw new Fail('no-match', sec.path);
        cursor = found.pos[0]! + 1;
      }
      const O = chunk.body.filter((b) => b.kind !== 'new').map((b) => b.text);
      const N = chunk.body.filter((b) => b.kind !== 'old').map((b) => b.text);
      if (O.length === 0) {
        const at = chunk.eof ? fp.lines.length : cursor;
        fp.lines = applyBody(fp.lines, chunk.body, at, 0);
        cursor = at + N.length;
        continue;
      }
      const found = findOccurrences(fp.lines, O, strict, cursor);
      if (found === null) throw new Fail('no-match', sec.path);
      let at: number | null = null;
      for (const p of found.pos) {
        if (chunk.eof) {
          if (p + O.length === fp.lines.length) { at = p; break; }
        } else {
          at = p;
          break;
        }
      }
      if (at === null) throw new Fail('no-match', sec.path);
      fp.lines = applyBody(fp.lines, chunk.body, at, found.tier);
      cursor = at + N.length;
    }
    const out = joinFile(fp);
    if (sec.moveTo !== null) {
      tree.now.set(sec.moveTo, out);
      tree.now.set(sec.path, null);
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, out);
    }
  });
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits (unchanged from the starter)
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
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
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? searchReplaceEdits(lines, strict)
      : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const consumed = new Set<string>();
  const rows: Array<{ key: string; line: string }> = [];
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original(oldP);
    const wasNew = tree.original(newP);
    const nowOld = tree.get(oldP);
    const nowNew = tree.get(newP);
    if (wasOld !== null && wasNew === null && nowOld === null && nowNew !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
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
