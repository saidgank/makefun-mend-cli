// main.ts is mend, the CLI SPEC.md specifies: one patch tool for every AI edit format. It reads a patch as a
// unified diff, as SEARCH/REPLACE blocks, as a V4A patch or as JSON editor calls, finds the lines each edit
// names at the first of three matching tiers (exact, trailing whitespace ignored, leading and trailing
// whitespace ignored, with re-indentation at the third tier), and writes every change or none, printing what
// it changed or why it failed. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): the hand-over and runner.ts stay as the kit has them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 outcome: the single line to print (SPEC.md section 2). */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit's failure: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines (section 3): split at \n, one trailing \r removed each, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A safe path (section 3). */
function safePath(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file held as its lines, its own line break, and whether it ends with one (section 3). */
interface FileState {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let finalBreak = false;
  if (text.endsWith(br)) {
    parts.pop();
    finalBreak = true;
  }
  return { lines: parts, br, finalBreak };
}

function serializeFile(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.finalBreak ? st.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
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

/* Matching lines (section 5). */

const normLine = (s: string, tier: number): string =>
  tier === 0 ? s : tier === 1 ? s.replace(/[ \t]+$/, '') : s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** Every position at which O occurs in lines at one tier; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  const want = o.map((l) => normLine(l, tier));
  for (let i = 0; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (normLine(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Match {
  tier: number;
  positions: number[];
}

/** The first tier at which O occurs at least once, or null. */
function matchTiers(lines: string[], o: string[], strict: boolean): Match | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const positions = occurrences(lines, o, tier);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line) or a new line. */
interface NPart {
  text: string;
  ctx: boolean;
  oi: number;
}

/** The lines N is written as, once O matched at `pos` (section 5: context from the file, tier-2 re-indent). */
function writtenLines(fileLines: string[], pos: number, o: string[], parts: NPart[], tier: number): string[] {
  let leadF = '';
  let leadP = '';
  if (tier === 2) {
    leadF = /^[ \t]*/.exec(fileLines[pos]!)![0];
    leadP = /^[ \t]*/.exec(o[0]!)![0];
  }
  return parts.map((part) => {
    if (part.ctx) return fileLines[pos + part.oi]!;
    if (tier === 2) {
      const t = part.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(leadP)) return leadF + t.slice(leadP.length);
    }
    return part.text;
  });
}

/* Format detection (section 4). */

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

/* Unified diffs (section 6). */

/** A path as a header names it: a real path, or /dev/null (no file). */
type Named = { path: string } | { devnull: true };

const namedPath = (n: Named | null): string | null => (n !== null && 'path' in n ? n.path : null);
const namedDevNull = (n: Named | null): boolean => n !== null && 'devnull' in n;

/** The path a `--- ` or `+++ ` line names: after the four characters, up to the first tab, spaces removed. */
function headerPath(line: string): Named {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return { devnull: true };
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return { path: t };
}

/** The two paths of a `diff --git a/<X> b/<Y>` line, or null when the line is not of that form. */
function diffGitPaths(line: string): [Named, Named] | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const sep = rest.indexOf(' b/');
  if (sep < 0) return null;
  const x = rest.slice(2, sep);
  const y = rest.slice(sep + 3);
  if (x === '' || y === '') return null;
  return [{ path: x }, { path: y }];
}

interface UBodyLine {
  ch: string; // ' ' context, '-' old, '+' new, '\\' no-newline marker
  text: string;
  bare: boolean; // a bare empty line: a context line whose text is empty
}

interface UHunk {
  a: number;
  body: UBodyLine[];
  bsLast: boolean; // a '\' line follows the hunk's last context or '+' line
}

interface USection {
  diffOld: Named | null;
  diffNew: Named | null;
  hasPair: boolean;
  pairOld: Named | null;
  pairNew: Named | null;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UHunk[];
}

function unifiedParse(lines: string[]): USection[] {
  const secs: USection[] = [];
  let cur: USection | null = null;
  let hunk: UHunk | null = null;
  const newSection = (): USection => {
    const s: USection = {
      diffOld: null,
      diffNew: null,
      hasPair: false,
      pairOld: null,
      pairNew: null,
      renameFrom: undefined,
      renameTo: undefined,
      newFile: false,
      deletedFile: false,
      hunks: [],
    };
    secs.push(s);
    return s;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const no = i + 1;
    if (line.startsWith('diff --git ')) {
      const paths = diffGitPaths(line);
      if (paths === null) throw new Exit2(`error: parse ${no}`);
      cur = newSection();
      cur.diffOld = paths[0];
      cur.diffNew = paths[1];
      hunk = null;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ')) {
      if (cur !== null && !cur.hasPair && cur.hunks.length === 0 && hunk === null) {
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(lines[i + 1]!);
        cur.hasPair = true;
      } else {
        cur = newSection();
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(lines[i + 1]!);
        cur.hasPair = true;
      }
      hunk = null;
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${no}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${no}`);
      hunk = { a: Number(m[1]), body: [], bsLast: false };
      cur.hunks.push(hunk);
      continue;
    }
    if (hunk !== null && (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\'))) {
      hunk.body.push(line === '' ? { ch: ' ', text: '', bare: true } : { ch: line[0]!, text: line.slice(1), bare: false });
      continue;
    }
    hunk = null;
    if (cur !== null && cur.hunks.length === 0) {
      // The section's header, before its first hunk.
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${no + 1}`);
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.deletedFile = true;
        continue;
      }
    }
    // Anything else, outside bodies and headers, is ignored (prose, code fences).
  }
  for (const s of secs) {
    for (const h of s.hunks) {
      while (h.body.length > 0 && h.body[h.body.length - 1]!.bare) h.body.pop();
      let last = -1;
      h.body.forEach((b, bi) => {
        if (b.ch === ' ' || b.ch === '+') last = bi;
      });
      h.bsLast = last >= 0 && h.body[last + 1]?.ch === '\\';
    }
  }
  if (secs.length === 0) throw new Exit2('error: parse 1');
  return secs;
}

/** Apply one section's hunks to a file's text, in order (section 6). */
function applyHunks(text: string, hunks: UHunk[], strict: boolean, errPath: string): string {
  const st = parseFile(text);
  let d = 0;
  for (const h of hunks) {
    const o: string[] = [];
    const parts: NPart[] = [];
    for (const b of h.body) {
      if (b.ch === ' ') {
        parts.push({ text: b.text, ctx: true, oi: o.length });
        o.push(b.text);
      } else if (b.ch === '-') o.push(b.text);
      else if (b.ch === '+') parts.push({ text: b.text, ctx: false, oi: -1 });
    }
    if (o.length > 0) {
      const m = matchTiers(st.lines, o, strict);
      if (m === null) throw new Fail('no-match', errPath);
      const target = h.a - 1 + d;
      let pos = m.positions[0]!;
      for (const p of m.positions) {
        if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
      }
      const atEnd = pos + o.length === st.lines.length;
      const written = writtenLines(st.lines, pos, o, parts, m.tier);
      st.lines.splice(pos, o.length, ...written);
      if (atEnd) st.finalBreak = !h.bsLast;
    } else {
      const at = Math.max(0, Math.min(h.a + d, st.lines.length));
      const atEnd = at === st.lines.length;
      st.lines.splice(at, 0, ...parts.map((p) => p.text));
      if (atEnd) st.finalBreak = !h.bsLast;
    }
    d += parts.length - o.length;
  }
  return serializeFile(st);
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    let oldN: Named | null = null;
    let newN: Named | null = null;
    if (sec.hasPair) {
      oldN = sec.pairOld;
      newN = sec.pairNew;
    } else if (sec.renameFrom !== undefined || sec.renameTo !== undefined) {
      oldN = sec.renameFrom !== undefined ? { path: sec.renameFrom } : sec.diffOld;
      newN = sec.renameTo !== undefined ? { path: sec.renameTo } : sec.diffNew;
    } else {
      oldN = sec.diffOld;
      newN = sec.diffNew;
    }
    const oldPath = namedPath(oldN);
    const newPath = namedPath(newN);
    // Every path the edit names is checked for safety before anything else about it (section 10).
    for (const p of [oldPath, newPath]) {
      if (p !== null && !safePath(p)) throw new Fail('unsafe', p);
    }
    const creation = namedDevNull(oldN) || sec.newFile;
    const deletion = namedDevNull(newN) || sec.deletedFile;
    if (creation) {
      if (newPath === null) return;
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const outLines: string[] = [];
      let bs = false;
      for (const h of sec.hunks) {
        for (let bi = 0; bi < h.body.length; bi += 1) {
          const b = h.body[bi]!;
          if (b.ch === '+') {
            outLines.push(b.text);
            bs = h.body[bi + 1]?.ch === '\\';
          }
        }
      }
      tree.now.set(newPath, serializeFile({ lines: outLines, br: '\n', finalBreak: !bs }));
      return;
    }
    if (deletion) {
      if (oldPath === null) return;
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    if (oldPath === null || newPath === null) return;
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    if (oldPath !== newPath && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    const result = applyHunks(before, sec.hunks, strict, oldPath);
    if (oldPath === newPath) {
      tree.now.set(oldPath, result);
    } else {
      tree.now.set(oldPath, null);
      tree.now.set(newPath, result);
      tree.moves.push([oldPath, newPath]);
    }
  };
}

/* SEARCH/REPLACE blocks (section 7). */

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function srParse(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchNo = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchNo}`);
    let k = i + 1;
    const oldLines: string[] = [];
    while (k < lines.length && lines[k]!.trimEnd() !== '=======') {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') throw new Exit2(`error: parse ${searchNo}`);
      oldLines.push(lines[k]!);
      k += 1;
    }
    if (k >= lines.length) throw new Exit2(`error: parse ${searchNo}`);
    k += 1;
    const newLines: string[] = [];
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') {
      newLines.push(lines[k]!);
      k += 1;
    }
    if (k >= lines.length) throw new Exit2(`error: parse ${searchNo}`);
    blocks.push({ path, oldLines, newLines });
    prevPath = path;
    prevEnd = k + 1;
    i = k + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks;
}

function srEdit(block: SRBlock, strict: boolean): Edit {
  return (tree) => {
    const p = block.path;
    if (!safePath(p)) throw new Fail('unsafe', p);
    if (block.oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, serializeFile({ lines: [...block.newLines], br: '\n', finalBreak: true }));
      return;
    }
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    const st = parseFile(text);
    const m = matchTiers(st.lines, block.oldLines, strict);
    if (m === null) throw new Fail('no-match', p);
    if (m.positions.length > 1) throw new Fail('ambiguous', p);
    const pos = m.positions[0]!;
    const parts = block.newLines.map((t) => ({ text: t, ctx: false, oi: -1 }));
    const written = writtenLines(st.lines, pos, block.oldLines, parts, m.tier);
    st.lines.splice(pos, block.oldLines.length, ...written);
    tree.now.set(p, serializeFile(st));
  };
}

/* V4A patches (section 8). */

interface VChunk {
  anchor: string | null;
  body: { ch: string; text: string }[];
  eof: boolean;
}

/** The first line at or after `from` equal to the anchor, at the first tier where one is. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const want = normLine(anchor, tier);
    for (let i = from; i < lines.length; i += 1) {
      if (normLine(lines[i]!, tier) === want) return i;
    }
  }
  return -1;
}

/** The first occurrence of O at or after `from`, at the first tier with one (EOF chunks: ending at the last line). */
function matchFrom(lines: string[], o: string[], strict: boolean, from: number, eofOnly: boolean): { tier: number; pos: number } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const ps = occurrences(lines, o, tier).filter((p) => p >= from && (!eofOnly || p + o.length === lines.length));
    if (ps.length > 0) return { tier, pos: ps[0]! };
  }
  return null;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const fb = lines.findIndex((l) => !blank(l));
  if (fb < 0) throw new Exit2('error: parse 1');
  if (lines[fb]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${fb + 1}`);
  let lb = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      lb = i;
      break;
    }
  }
  if (lines[lb]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  interface Raw {
    text: string;
    no: number;
  }
  interface Sec {
    kind: 'add' | 'del' | 'upd';
    path: string;
    no: number;
    raw: Raw[];
  }
  const secs: Sec[] = [];
  let cur: Sec | null = null;
  const heads: [string, Sec['kind']][] = [
    ['*** Add File: ', 'add'],
    ['*** Delete File: ', 'del'],
    ['*** Update File: ', 'upd'],
  ];
  for (let i = fb + 1; i < lb; i += 1) {
    const line = lines[i]!;
    let matched: Sec | null = null;
    for (const [prefix, kind] of heads) {
      if (line.startsWith(prefix)) {
        matched = { kind, path: line.slice(prefix.length).trim(), no: i + 1, raw: [] };
        break;
      }
    }
    if (matched !== null) {
      secs.push(matched);
      cur = matched;
      continue;
    }
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    cur.raw.push({ text: line, no: i + 1 });
  }
  if (secs.length === 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  for (const sec of secs) {
    // Blank lines at the end of a section (empty or only whitespace) are not part of it.
    const raw = [...sec.raw];
    while (raw.length > 0 && raw[raw.length - 1]!.text.trim() === '') raw.pop();
    if (sec.kind === 'add') {
      const content: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) content.push(r.text.slice(1));
        else if (r.text === '') content.push('');
        else throw new Exit2(`error: parse ${r.no}`);
      }
      const path = sec.path;
      edits.push((tree) => {
        if (!safePath(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, serializeFile({ lines: content, br: '\n', finalBreak: true }));
      });
    } else if (sec.kind === 'del') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.no}`);
      const path = sec.path;
      edits.push((tree) => {
        if (!safePath(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      edits.push(v4aUpdate(sec.path, sec.no, raw, strict));
    }
  }
  return edits;
}

function v4aUpdate(path: string, secNo: number, raw: { text: string; no: number }[], strict: boolean): Edit {
  let idx = 0;
  let moveTo: string | undefined;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  for (; idx < raw.length; idx += 1) {
    const { text: line, no } = raw[idx]!;
    if (line.startsWith('@@')) {
      const anchor = line.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
      chunks.push(cur);
    } else if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line === '') {
      if (cur === null) {
        cur = { anchor: null, body: [], eof: false };
        chunks.push(cur);
      } else if (cur.eof) throw new Exit2(`error: parse ${no}`);
      cur.body.push(line === '' ? { ch: ' ', text: '' } : { ch: line[0]!, text: line.slice(1) });
    } else if (line.trimEnd() === '*** End of File') {
      if (cur === null) {
        cur = { anchor: null, body: [], eof: true };
        chunks.push(cur);
      } else cur.eof = true;
    } else throw new Exit2(`error: parse ${no}`);
  }
  if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${secNo}`);
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (moveTo !== undefined && !safePath(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== undefined && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const st = parseFile(text);
    let cursor = 0;
    for (const chunk of chunks) {
      const o: string[] = [];
      const parts: NPart[] = [];
      for (const b of chunk.body) {
        if (b.ch === ' ') {
          parts.push({ text: b.text, ctx: true, oi: o.length });
          o.push(b.text);
        } else if (b.ch === '-') o.push(b.text);
        else if (b.ch === '+') parts.push({ text: b.text, ctx: false, oi: -1 });
      }
      if (chunk.anchor !== null) {
        const ai = findAnchor(st.lines, chunk.anchor, cursor, strict);
        if (ai < 0) throw new Fail('no-match', path);
        cursor = ai + 1;
      }
      if (o.length === 0) {
        const at = chunk.eof ? st.lines.length : Math.min(cursor, st.lines.length);
        const written = parts.map((p) => p.text);
        st.lines.splice(at, 0, ...written);
        cursor = at + written.length;
      } else {
        const found = matchFrom(st.lines, o, strict, cursor, chunk.eof);
        if (found === null) throw new Fail('no-match', path);
        const written = writtenLines(st.lines, found.pos, o, parts, found.tier);
        st.lines.splice(found.pos, o.length, ...written);
        cursor = found.pos + written.length;
      }
    }
    const out = serializeFile(st);
    if (moveTo !== undefined) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

/* JSON edits (section 9). */

/** One JSON edit object, or null when it is not one (a parse fault). */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const needFile = (tree: Tree): string => {
    if (!safePath(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = needFile(tree);
      const crlf = parseFile(before).br === '\r\n';
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
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = needFile(tree);
      const st = parseFile(before);
      if (line < 0 || line > st.lines.length) throw new Fail('no-match', p);
      st.lines.splice(line, 0, ...add);
      tree.now.set(p, serializeFile(st));
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

/* The command line, the run, and the write (sections 1, 2 and 10). */

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
    else if (kind === 'unified') edits = unifiedParse(lines).map((s) => unifiedEdit(s, strict));
    else if (kind === 'search-replace') edits = srParse(lines).map((b) => srEdit(b, strict));
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const finalOf = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p));
  const consumed = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const [o, n] of tree.moves) {
    if (consumed.has(o) || consumed.has(n)) continue;
    if (tree.original(o) !== null && finalOf(o) === null && tree.original(n) === null && finalOf(n) !== null) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      consumed.add(o);
      consumed.add(n);
    }
  }
  for (const p of changed) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
