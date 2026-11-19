// github-core-clone-01 — a GitHub-compatible git forge in one process, Node 22 stdlib only.
//
// Serves git smart HTTP (upload-pack v2, receive-pack v0), REST v3, GraphQL v4 and MCP
// (2026-07-28 discover + legacy initialize) from one in-memory store. No git binary, no
// outside service, no package. Deterministic: no wall clock or Math.random in any state;
// timestamps derive from a monotonic counter seeded at 2025-01-01T00:00:00Z.

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';

// -------------------------------------------------------------------------------------------
// scenario seed (wire.ts, fixed): the viewer login is derived from it, exactly as the suite does
// -------------------------------------------------------------------------------------------

const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64_MASK = 0xffffffffffffffffn;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)];
  }
}

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

function scenarioUsers(): ScenarioUser[] {
  const rng = new Rng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < 12; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

const USERS = scenarioUsers();
const VIEWER: ScenarioUser = USERS[0]!;
const VIEWER_LOGIN = VIEWER.login;
const VIEWER_NAME = VIEWER.name;
const VIEWER_EMAIL = VIEWER.email;

// -------------------------------------------------------------------------------------------
// deterministic clock: a monotonic counter over a fixed epoch (never Date.now / Math.random)
// -------------------------------------------------------------------------------------------

const EPOCH_SEC = 1_735_689_600; // 2025-01-01T00:00:00Z
let clockSeq = 0;
function nextSeq(): number {
  clockSeq += 1;
  return clockSeq;
}
function isoNow(): string {
  return new Date((EPOCH_SEC + clockSeq) * 1000).toISOString();
}
function identLine(): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${EPOCH_SEC + clockSeq} +0000`;
}

// -------------------------------------------------------------------------------------------
// git object model
// -------------------------------------------------------------------------------------------

export const ZERO_OID = '0'.repeat(40);
type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObj {
  type: ObjType;
  data: Buffer;
}
const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const HEX40 = /^[0-9a-f]{40}$/;

function isOid(v: string): boolean {
  return HEX40.test(v);
}

function hashObject(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  h.update(data);
  return h.digest('hex');
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    entries.push({
      mode: data.subarray(off, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const l = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const r = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(l, r);
}

function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

function buildCommit(tree: string, parents: string[], message: string): Buffer {
  const who = identLine();
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

interface TagView {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    if (sp >= 0) headers.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as ObjType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

// -------------------------------------------------------------------------------------------
// pkt-line codec
// -------------------------------------------------------------------------------------------

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}
const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

/** Decode pkt-lines from the start of buf; returns packets and the offset of the first unframed byte. */
function decodePktLines(buf: Buffer): { packets: Packet[]; rest: number } {
  const packets: Packet[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const len = Number.parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      off += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, rest: off };
}

// -------------------------------------------------------------------------------------------
// packfile read / write
// -------------------------------------------------------------------------------------------

function readVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

interface RawEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/** Read a packfile (v2/v3, plain + OFS/REF deltas) into objects. Throws on corruption. */
function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObj | undefined): Map<string, GitObj> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let i = 0; i < declaredCount; i += 1) {
    const entryOffset = offset;
    const header = readVarint(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let byte = pack[offset]!;
      offset += 1;
      let value = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset++]!;
        value = ((value + 1) * 128) + (byte & 0x7f);
      }
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const objects = new Map<string, GitObj>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): GitObj => {
    const cached = (entry as unknown as { _resolved?: GitObj })._resolved;
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let obj: GitObj;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      obj = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.typeCode === 7) {
      const baseEntry = resolvedByOid.get(entry.baseOid!);
      if (baseEntry) {
        const base = resolve(baseEntry);
        obj = { type: base.type, data: applyDelta(base.data, entry.data) };
      } else {
        const external = resolveBase?.(entry.baseOid!);
        if (!external) throw new Error('ref-delta base missing');
        obj = { type: external.type, data: applyDelta(external.data, entry.data) };
      }
    } else {
      obj = { type: CODE_TYPE[entry.typeCode]!, data: entry.data };
    }
    const oid = hashObject(obj.type, obj.data);
    (entry as unknown as { _resolved?: GitObj })._resolved = obj;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return obj;
  };
  for (const entry of raw) {
    const obj = resolve(entry);
    const oid = hashObject(obj.type, obj.data);
    if (!objects.has(oid)) objects.set(oid, obj);
  }
  return objects;
}

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

function writePack(objects: GitObj[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// -------------------------------------------------------------------------------------------
// store
// -------------------------------------------------------------------------------------------

interface Label {
  name: string;
  color: string;
}
interface Comment {
  id: number;
  body: string;
  created_at: string;
}
interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  seq: number;
  created_at: string;
  updated_at: string;
}
interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}
interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  seq: number;
  created_at: string;
  baseShaAtCreate: string;
  files: PullFile[];
}
interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  objects: Map<string, GitObj>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextNumber: number;
  seq: number;
}

const repos = new Map<string, Repo>();
let nextRepoId = 5000;
let nextEntityId = 1;
let nextCommentId = 1;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}
function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}
function createRepoRecord(name: string, description: string, isPrivate: boolean): Repo {
  const repo: Repo = {
    id: nextRepoId++,
    name,
    owner: VIEWER_LOGIN,
    description,
    private: isPrivate,
    defaultBranch: 'main',
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: [],
    pulls: [],
    nextNumber: 1,
    seq: nextSeq(),
  };
  repos.set(repoKey(VIEWER_LOGIN, name), repo);
  return repo;
}

// -------------------------------------------------------------------------------------------
// git graph helpers (all synchronous, in-memory)
// -------------------------------------------------------------------------------------------

function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** Every object reachable from roots (commit -> tree+parents, tag -> target, tree -> entries). */
function collectReachable(repo: Repo, roots: Iterable<string>, allowMissing = false): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) {
      if (allowMissing) continue;
      throw new Error(`missing object ${oid}`);
    }
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      queue.push(c.tree);
      for (const p of c.parents) queue.push(p);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push(e.oid);
    }
  }
  return seen;
}

/** True when `anc` is reachable from `desc` by parent links (or equal). */
function isAncestor(repo: Repo, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const seen = new Set<string>();
  const queue = [desc];
  while (queue.length) {
    const oid = queue.pop()!;
    if (oid === anc) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return false;
}

/** Peel a ref target to its commit (through annotated tags). */
function peelToCommit(repo: Repo, oid: string): string {
  let cur = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'tag') return cur;
    cur = parseTag(obj.data).object;
  }
  return cur;
}

/** Flatten a tree to path -> {mode, oid}. */
function flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, { mode: string; oid: string }>()): Map<string, { mode: string; oid: string }> {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') flattenTree(repo, e.oid, path, out);
    else out.set(path, { mode: e.mode, oid: e.oid });
  }
  return out;
}

/** Build (and store) a tree from a flat path map; returns the root tree oid. */
function buildTreeFromFlat(repo: Repo, flat: Map<string, { mode: string; oid: string }>): string {
  interface Node {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of flat) {
    const segs = path.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i += 1) {
      const name = segs[i]!;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segs[segs.length - 1]!, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, e] of node.files) entries.push({ mode: e.mode, name, oid: e.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] === 0x0a) n += 1;
  if (data[data.length - 1] !== 0x0a) n += 1;
  return n;
}

/** Diff two trees (by root oid) into pull-request file entries. */
function diffTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string): PullFile[] {
  const base = baseTreeOid ? flattenTree(repo, baseTreeOid) : new Map<string, { mode: string; oid: string }>();
  const head = flattenTree(repo, headTreeOid);
  const files: PullFile[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) {
      const oldData = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
      const del = countLines(oldData);
      files.push({ filename: path, status: 'removed', additions: 0, deletions: del, changes: del });
    } else if (!b && h) {
      const newData = repo.objects.get(h.oid)?.data ?? Buffer.alloc(0);
      const add = countLines(newData);
      files.push({ filename: path, status: 'added', additions: add, deletions: 0, changes: add });
    } else if (b && h && b.oid !== h.oid) {
      const oldData = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
      const newData = repo.objects.get(h.oid)?.data ?? Buffer.alloc(0);
      const add = countLines(newData);
      const del = countLines(oldData);
      files.push({ filename: path, status: 'modified', additions: add, deletions: del, changes: add + del });
    }
  }
  return files;
}

/**
 * Three-way merge of flat trees: result starts at `target`, takes every path `head` changed
 * relative to `mergeBase`. Returns {flat, conflict}: a conflict is a path both sides changed
 * to different content.
 */
function mergeFlats(
  mergeBase: Map<string, { mode: string; oid: string }>,
  head: Map<string, { mode: string; oid: string }>,
  target: Map<string, { mode: string; oid: string }>,
): { flat: Map<string, { mode: string; oid: string }>; conflict: boolean } {
  const result = new Map(target);
  let conflict = false;
  const paths = new Set([...mergeBase.keys(), ...head.keys(), ...target.keys()]);
  for (const path of paths) {
    const m = mergeBase.get(path);
    const h = head.get(path);
    const t = target.get(path);
    const headChanged = (m?.oid ?? null) !== (h?.oid ?? null);
    const targetChanged = (m?.oid ?? null) !== (t?.oid ?? null);
    if (!headChanged) continue;
    if (targetChanged && (h?.oid ?? null) !== (t?.oid ?? null)) {
      conflict = true;
      continue;
    }
    if (h) result.set(path, h);
    else result.delete(path);
  }
  return { flat: result, conflict };
}

/** Create a commit on a ref from a flat file map; returns the new commit oid. */
function commitFlat(repo: Repo, ref: string, flat: Map<string, { mode: string; oid: string }>, message: string): string {
  const treeOid = buildTreeFromFlat(repo, flat);
  const parent = repo.refs.get(ref);
  const parents = parent ? [parent] : [];
  const data = buildCommit(treeOid, parents, message.endsWith('\n') ? message : `${message}\n`);
  const oid = putObject(repo, 'commit', data);
  repo.refs.set(ref, oid);
  return oid;
}

/** The tip commit oid of a ref, or null. */
function refTip(repo: Repo, ref: string): string | null {
  return repo.refs.get(ref) ?? null;
}

/** Depth-limited fetch set: commits within `depth` generations of `wants` (+ their trees/blobs). */
function fetchSet(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowBoundaries: string[],
  depth: number | null,
): { objects: Map<string, GitObj>; shallow: string[]; unshallow: string[] } {
  // Commits to include.
  const includedCommits = new Set<string>();
  const boundary = new Set<string>();
  if (depth === null) {
    for (const oid of collectReachable(repo, wants)) {
      const obj = repo.objects.get(oid);
      if (obj?.type === 'commit') includedCommits.add(oid);
    }
  } else {
    // BFS by generation from wants.
    const gen = new Map<string, number>();
    const queue: string[] = [];
    for (const w of wants) {
      if (isOid(w) && repo.objects.get(w)?.type === 'commit') {
        gen.set(w, 0);
        queue.push(w);
      }
    }
    while (queue.length) {
      const oid = queue.shift()!;
      const g = gen.get(oid)!;
      if (g >= depth) continue;
      includedCommits.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) {
        if (!gen.has(p)) {
          gen.set(p, g + 1);
          queue.push(p);
        }
      }
    }
    // Boundary: included commits with a parent outside the set.
    for (const oid of includedCommits) {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) {
        if (!includedCommits.has(p)) {
          boundary.add(oid);
          break;
        }
      }
    }
  }
  // Objects the client already holds: closure of non-shallow haves; for shallow haves, only the
  // have commit itself plus its tree/blobs (its ancestors are NOT held — that is the point of shallow).
  const held = new Set<string>();
  const shallowSet = new Set(shallowBoundaries);
  const fullHaves: string[] = [];
  for (const h of haves) {
    if (shallowSet.has(h)) {
      const obj = repo.objects.get(h);
      if (obj?.type === 'commit') {
        held.add(h);
        const c = parseCommit(obj.data);
        held.add(c.tree);
        for (const e of flattenTree(repo, c.tree).values()) held.add(e.oid);
      }
    } else {
      fullHaves.push(h);
    }
  }
  if (fullHaves.length) {
    for (const oid of collectReachable(repo, fullHaves, true)) held.add(oid);
  }
  // Assemble the object set: reachable from included commits, minus held. With a depth
  // limit only the included commits' own trees/blobs are sent (never their parents).
  const wanted = new Set<string>();
  if (depth === null) {
    for (const oid of includedCommits) {
      for (const o of collectReachable(repo, [oid], true)) wanted.add(o);
    }
  } else {
    const addTree = (treeOid: string): void => {
      if (wanted.has(treeOid)) return;
      const obj = repo.objects.get(treeOid);
      if (!obj || obj.type !== 'tree') return;
      wanted.add(treeOid);
      for (const e of parseTree(obj.data)) {
        if (e.mode === '40000') addTree(e.oid);
        else wanted.add(e.oid);
      }
    };
    for (const oid of includedCommits) {
      wanted.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      addTree(parseCommit(obj.data).tree);
    }
  }
  // Tags wanted directly are included whole.
  for (const w of wants) {
    const obj = repo.objects.get(w);
    if (obj?.type === 'tag') {
      for (const o of collectReachable(repo, [w], true)) wanted.add(o);
    }
  }
  const objects = new Map<string, GitObj>();
  for (const oid of wanted) {
    if (held.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj) objects.set(oid, obj);
  }
  const shallow = [...boundary].filter((oid) => objects.has(oid) || includedCommits.has(oid));
  const unshallow = shallowBoundaries.filter((oid) => includedCommits.has(oid) && !boundary.has(oid));
  return { objects, shallow, unshallow };
}

/** Squash-merge a pull request onto its base branch. Returns {ok, sha} or {ok:false, reason}. */
function squashMerge(repo: Repo, pull: Pull): { ok: true; sha: string } | { ok: false; reason: string } {
  const baseRef = `refs/heads/${pull.base.ref}`;
  const headRef = `refs/heads/${pull.head.ref}`;
  const baseTip = repo.refs.get(baseRef);
  const headTip = repo.refs.get(headRef);
  if (!baseTip || !headTip) return { ok: false, reason: 'branch not found' };
  const mergeBaseOid = pull.baseShaAtCreate;
  const baseCommit = parseCommit(repo.objects.get(baseTip)!.data);
  const headCommit = parseCommit(repo.objects.get(headTip)!.data);
  const mergeBaseCommit = repo.objects.get(mergeBaseOid);
  const mergeBaseTree = mergeBaseCommit?.type === 'commit' ? parseCommit(mergeBaseCommit.data).tree : null;
  const mergeBaseFlat = mergeBaseTree ? flattenTree(repo, mergeBaseTree) : new Map<string, { mode: string; oid: string }>();
  const headFlat = flattenTree(repo, headCommit.tree);
  const targetFlat = flattenTree(repo, baseCommit.tree);
  const { flat, conflict } = mergeFlats(mergeBaseFlat, headFlat, targetFlat);
  if (conflict) return { ok: false, reason: 'merge conflict' };
  const treeOid = buildTreeFromFlat(repo, flat);
  const message = pull.title.endsWith('\n') ? pull.title : `${pull.title}\n`;
  const data = buildCommit(treeOid, [baseTip], message);
  const sha = putObject(repo, 'commit', data);
  repo.refs.set(baseRef, sha);
  pull.merged = true;
  pull.merged_at = isoNow();
  pull.merge_commit_sha = sha;
  pull.state = 'closed';
  return { ok: true, sha };
}

/** Is this pull request currently mergeable (no conflict if merged now)? */
function pullMergeable(repo: Repo, pull: Pull): string {
  if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
  const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
  const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`);
  if (!baseTip || !headTip) return 'UNKNOWN';
  const mergeBaseCommit = repo.objects.get(pull.baseShaAtCreate);
  const mergeBaseTree = mergeBaseCommit?.type === 'commit' ? parseCommit(mergeBaseCommit.data).tree : null;
  const mergeBaseFlat = mergeBaseTree ? flattenTree(repo, mergeBaseTree) : new Map<string, { mode: string; oid: string }>();
  const headFlat = flattenTree(repo, parseCommit(repo.objects.get(headTip)!.data).tree);
  const targetFlat = flattenTree(repo, parseCommit(repo.objects.get(baseTip)!.data).tree);
  return mergeFlats(mergeBaseFlat, headFlat, targetFlat).conflict ? 'CONFLICTING' : 'MERGEABLE';
}

// -------------------------------------------------------------------------------------------
// HTTP plumbing
// -------------------------------------------------------------------------------------------

const JSON_TYPE = 'application/json; charset=utf-8';
let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = {
    'content-type': JSON_TYPE,
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  };
  if (status !== 204) headers['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, headers);
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...extraHeaders });
  res.end(body);
}

function errJson(status: number, message: string): { status: number; body: { message: string } } {
  return { status, body: { message } };
}

function authed(req: IncomingMessage): boolean {
  const auth = req.headers.authorization ?? '';
  return auth.startsWith('Bearer ') && auth.slice(7).trim() !== '';
}

function segmentsOf(req: IncomingMessage): string[] {
  const raw = (req.url ?? '/').split('?')[0] ?? '/';
  return raw
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function parseJsonBody(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function asStr(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}
function b64decode(b64: string): string {
  return Buffer.from(b64.replace(/\s+/g, ''), 'base64').toString('utf8');
}

// -------------------------------------------------------------------------------------------
// REST serializers
// -------------------------------------------------------------------------------------------

function repoJson(repo: Repo): Record<string, unknown> {
  const full = `${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    node_id: globalId('Repository', String(repo.id)),
    name: repo.name,
    full_name: full,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: isoNow(),
    updated_at: isoNow(),
    html_url: `https://example.invalid/${full}`,
    url: `/api/v3/repos/${full}`,
    clone_url: `https://example.invalid/${full}.git`,
    git_url: `git://example.invalid/${full}.git`,
    ssh_url: `git@example.invalid:${full}.git`,
    homepage: null,
    language: null,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.owner}/${repo.name}/${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
    user: { login: VIEWER_LOGIN, id: VIEWER.id, type: 'User' },
    assignee: null,
    assignees: [],
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.state === 'closed' ? issue.updated_at : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    comments: issue.comments.length,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    locked: false,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const additions = pull.files.reduce((n, f) => n + f.additions, 0);
  const deletions = pull.files.reduce((n, f) => n + f.deletions, 0);
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.owner}/${repo.name}/${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head.ref, sha: pull.head.sha, label: `${repo.owner}:${pull.head.ref}`, user: { login: VIEWER_LOGIN, id: VIEWER.id, type: 'User' } },
    base: { ref: pull.base.ref, sha: pull.base.sha, label: `${repo.owner}:${pull.base.ref}`, user: { login: VIEWER_LOGIN, id: VIEWER.id, type: 'User' } },
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    mergeable: pull.state === 'open' ? pullMergeable(repo, pull) === 'MERGEABLE' : null,
    user: { login: VIEWER_LOGIN, id: VIEWER.id, type: 'User' },
    created_at: pull.created_at,
    updated_at: pull.created_at,
    closed_at: pull.state === 'closed' ? pull.merged_at : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    draft: false,
    additions,
    deletions,
    changed_files: pull.files.length,
    commits: 1,
  };
}

function commentJson(repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', `${repo.owner}/${repo.name}/${issue.number}/${comment.id}`),
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER.id, type: 'User' },
    created_at: comment.created_at,
    updated_at: comment.created_at,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
  };
}

function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------------------------
// REST helpers
// -------------------------------------------------------------------------------------------

function pageParams(q: URLSearchParams): { page: number; perPage: number | null } {
  const perPageRaw = q.get('per_page');
  const perPage = perPageRaw === null ? null : Math.max(1, Math.min(100, Number.parseInt(perPageRaw, 10) || 30));
  const page = Math.max(1, Number.parseInt(q.get('page') ?? '1', 10) || 1);
  return { page, perPage };
}

function paginate<T>(items: T[], page: number, perPage: number | null): T[] {
  if (perPage === null) return items;
  return items.slice((page - 1) * perPage, page * perPage);
}

function linkHeader(req: IncomingMessage, basePath: string, q: URLSearchParams, page: number, perPage: number, hasNext: boolean): string | null {
  if (!hasNext) return null;
  const host = req.headers.host ?? '127.0.0.1';
  const params = new URLSearchParams(q);
  params.set('page', String(page + 1));
  params.set('per_page', String(perPage));
  return `<http://${host}${basePath}?${params.toString()}>; rel="next"`;
}

/** Resolve a ref name (branch, full ref, or oid) to a commit oid, or null. */
function resolveRef(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (repo.refs.has(ref)) return repo.refs.get(ref)!;
  const branchRef = `refs/heads/${ref}`;
  if (repo.refs.has(branchRef)) return repo.refs.get(branchRef)!;
  if (isOid(ref) && repo.objects.has(ref)) return ref;
  return null;
}

/** Commits reachable from `tip`, newest first (BFS by commit, parents after). */
function listCommits(repo: Repo, tip: string): { sha: string; message: string }[] {
  const out: { sha: string; message: string }[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const c = parseCommit(obj.data);
    out.push({ sha: oid, message: c.message });
    for (const p of c.parents) queue.push(p);
  }
  return out;
}

function createIssueRecord(repo: Repo, title: string, body: string, labels: Label[]): Issue {
  const seq = nextSeq();
  const now = isoNow();
  const issue: Issue = {
    id: nextEntityId++,
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    labels,
    comments: [],
    seq,
    created_at: now,
    updated_at: now,
  };
  repo.issues.push(issue);
  return issue;
}

function createPullRecord(repo: Repo, title: string, body: string, headRef: string, headSha: string, baseRef: string, baseSha: string): Pull {
  const seq = nextSeq();
  const now = isoNow();
  const headCommit = repo.objects.get(headSha);
  const baseCommit = repo.objects.get(baseSha);
  const headTree = headCommit?.type === 'commit' ? parseCommit(headCommit.data).tree : '';
  const baseTree = baseCommit?.type === 'commit' ? parseCommit(baseCommit.data).tree : null;
  const files = headTree ? diffTrees(repo, baseTree, headTree) : [];
  const pull: Pull = {
    id: nextEntityId++,
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    head: { ref: headRef, sha: headSha },
    base: { ref: baseRef, sha: baseSha },
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    seq,
    created_at: now,
    baseShaAtCreate: baseSha,
    files,
  };
  repo.pulls.push(pull);
  return pull;
}

// -------------------------------------------------------------------------------------------
// REST v3 handler. seg[0] === 'api', seg[1] === 'v3'.
// -------------------------------------------------------------------------------------------

async function handleRest(req: IncomingMessage, res: ServerResponse, seg: string[], q: URLSearchParams, rawBody: Buffer): Promise<void> {
  const method = req.method ?? 'GET';
  const rest = seg.slice(2); // after api/v3

  // Every REST reply is JSON with a request id; no token -> 401.
  if (!authed(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }

  const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  let parsed: unknown = {};
  if (needsBody) {
    const r = parseJsonBody(rawBody);
    if (!r.ok) {
      sendJson(res, 400, { message: 'Invalid JSON' });
      return;
    }
    parsed = r.value;
  }
  const body = isRecord(parsed) ? parsed : {};

  // GET /api/v3/ (root) and /api/v3/meta
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method === 'GET') {
      sendJson(res, 200, { installed_version: '1.0.0', version: '1.0.0' });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (rest.length === 1 && rest[0] === 'user') {
    if (method === 'GET') {
      sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER.id, name: VIEWER_NAME, type: 'User', email: VIEWER_EMAIL });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // /user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST') {
      const name = asStr(body.name);
      if (name === '') {
        sendJson(res, 422, { message: 'name is required' });
        return;
      }
      if (getRepo(VIEWER_LOGIN, name)) {
        sendJson(res, 422, { message: `Repository ${VIEWER_LOGIN}/${name} already exists` });
        return;
      }
      const repo = createRepoRecord(name, asStr(body.description), body.private === true);
      sendJson(res, 201, repoJson(repo));
      return;
    }
    if (method === 'GET') {
      const { page, perPage } = pageParams(q);
      const all = [...repos.values()].filter((r) => r.owner === VIEWER_LOGIN).sort((a, b) => a.seq - b.seq);
      const effectivePerPage = perPage ?? 30;
      const items = paginate(all, page, effectivePerPage);
      const hasNext = page * effectivePerPage < all.length;
      const extra: Record<string, string> = {};
      const link = linkHeader(req, '/api/v3/user/repos', q, page, effectivePerPage, hasNext);
      if (link) extra.link = link;
      sendJson(res, 200, items.map(repoJson), extra);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // /repos/{owner}/{name}[...]
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1]!;
    const name = rest[2]!;
    const repo = getRepo(owner, name);
    const tail = rest.slice(3);
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const repoPath = `/api/v3/repos/${owner}/${name}`;

    // /repos/{o}/{r}
    if (tail.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'PATCH') {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'DELETE') {
        repos.delete(repoKey(owner, name));
        res.writeHead(204, { 'x-github-request-id': nextRequestId() });
        res.end();
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    // /branches
    if (tail[0] === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        const list: Record<string, unknown>[] = [];
        for (const [ref, oid] of repo.refs) {
          if (ref.startsWith('refs/heads/')) list.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid } });
        }
        sendJson(res, 200, list);
        return;
      }
      if (tail.length === 2 && method === 'GET') {
        const branch = tail[1]!;
        const oid = repo.refs.get(`refs/heads/${branch}`);
        if (!oid) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        sendJson(res, 200, { name: branch, commit: { sha: oid } });
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    // /commits
    if (tail[0] === 'commits') {
      if (tail.length === 1 && method === 'GET') {
        const tip = resolveRef(repo, q.get('sha'));
        if (!tip) {
          sendJson(res, 200, []);
          return;
        }
        const commits = listCommits(repo, tip).map((c) => {
          const obj = repo.objects.get(c.sha)!;
          const parsed = parseCommit(obj.data);
          return {
            sha: c.sha,
            commit: { message: parsed.message.replace(/\n$/, ''), author: { name: VIEWER_NAME, email: VIEWER_EMAIL }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL } },
            author: { login: VIEWER_LOGIN },
            committer: { login: VIEWER_LOGIN },
            parents: parsed.parents.map((p) => ({ sha: p })),
          };
        });
        sendJson(res, 200, commits);
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    // /git/refs
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (tail.length === 2 && method === 'POST') {
        const ref = asStr(body.ref);
        const sha = asStr(body.sha);
        if (!ref.startsWith('refs/') || !isOid(sha) || !repo.objects.has(sha)) {
          sendJson(res, 422, { message: 'Invalid ref or sha' });
          return;
        }
        if (repo.refs.has(ref)) {
          sendJson(res, 422, { message: 'Reference already exists' });
          return;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha } });
        return;
      }
      if (tail.length >= 3 && method === 'GET') {
        const ref = tail.slice(2).join('/');
        const oid = repo.refs.get(ref);
        if (!oid) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        sendJson(res, 200, { ref, object: { sha: oid } });
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    // /contents/{path}
    if (tail[0] === 'contents') {
      const filePath = tail.slice(1).join('/');
      if (filePath === '') {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const branch = asStr((body as Record<string, unknown>).branch ?? q.get('branch') ?? '');
      const refName = branch === '' ? repo.defaultBranch : branch;
      const tip = resolveRef(repo, refName);
      if (method === 'GET') {
        const refTip = resolveRef(repo, q.get('ref'));
        if (!refTip) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        const commitObj = repo.objects.get(refTip);
        if (!commitObj || commitObj.type !== 'commit') {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        const treeOid = parseCommit(commitObj.data).tree;
        const flat = flattenTree(repo, treeOid);
        const entry = flat.get(filePath);
        if (entry) {
          const blob = repo.objects.get(entry.oid);
          const data = blob?.data ?? Buffer.alloc(0);
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            content: data.toString('base64'),
            sha: entry.oid,
            size: data.length,
            name: filePath.split('/').pop(),
            path: filePath,
          });
          return;
        }
        // Directory?
        const prefix = `${filePath}/`;
        const children = new Map<string, { type: string; oid: string; path: string }>();
        for (const [p, e] of flat) {
          if (!p.startsWith(prefix)) continue;
          const restPath = p.slice(prefix.length);
          const first = restPath.split('/')[0]!;
          if (restPath.includes('/')) {
            if (!children.has(first)) {
              // find the subtree oid for this directory
              const dirTree = findSubtreeOid(repo, treeOid, `${filePath}/${first}`);
              children.set(first, { type: 'dir', oid: dirTree ?? '', path: `${filePath}/${first}` });
            }
          } else {
            children.set(first, { type: 'file', oid: e.oid, path: p });
          }
        }
        if (children.size === 0) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        const list = [...children.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([childName, c]) => ({
            type: c.type,
            name: childName,
            path: c.path,
            sha: c.oid,
            size: c.type === 'file' ? (repo.objects.get(c.oid)?.data.length ?? 0) : 0,
          }));
        sendJson(res, 200, list);
        return;
      }
      if (method === 'PUT') {
        const contentB64 = asStr(body.content);
        if (contentB64 === '') {
          sendJson(res, 422, { message: 'content is required' });
          return;
        }
        let content: Buffer;
        try {
          content = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
        } catch {
          sendJson(res, 400, { message: 'content is not valid base64' });
          return;
        }
        const message = asStr(body.message, `Update ${filePath}`);
        const ref = `refs/heads/${refName}`;
        let currentTip = repo.refs.get(ref);
        // Creating a branch implicitly: start from the default branch tip.
        if (!currentTip && refName !== repo.defaultBranch) {
          currentTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
        }
        const currentFlat = currentTip ? flattenTree(repo, parseCommit(repo.objects.get(currentTip)!.data).tree) : new Map<string, { mode: string; oid: string }>();
        const existing = currentFlat.get(filePath);
        const givenSha = asStr(body.sha);
        if (existing && givenSha !== '' && givenSha.toLowerCase() !== existing.oid.toLowerCase()) {
          sendJson(res, 409, { message: 'sha does not match the current blob' });
          return;
        }
        const isUpdate = existing !== undefined;
        const blobOid = putObject(repo, 'blob', content);
        const nextFlat = new Map(currentFlat);
        nextFlat.set(filePath, { mode: '100644', oid: blobOid });
        const commitSha = commitFlat(repo, ref, nextFlat, message);
        sendJson(res, isUpdate ? 200 : 201, {
          content: { name: filePath.split('/').pop(), path: filePath, sha: blobOid, size: content.length, encoding: 'base64', type: 'file' },
          commit: { sha: commitSha, message },
        });
        return;
      }
      if (method === 'DELETE') {
        if (!tip) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        const flat = flattenTree(repo, parseCommit(repo.objects.get(tip)!.data).tree);
        const existing = flat.get(filePath);
        if (!existing) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        const givenSha = asStr(body.sha);
        if (givenSha !== '' && givenSha.toLowerCase() !== existing.oid.toLowerCase()) {
          sendJson(res, 409, { message: 'sha does not match the current blob' });
          return;
        }
        const message = asStr(body.message, `Delete ${filePath}`);
        const ref = `refs/heads/${refName}`;
        const nextFlat = new Map(flat);
        nextFlat.delete(filePath);
        const commitSha = commitFlat(repo, ref, nextFlat, message);
        sendJson(res, 200, { commit: { sha: commitSha, message } });
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    // /labels
    if (tail[0] === 'labels') {
      if (method === 'POST' && tail.length === 1) {
        const name = asStr(body.name);
        if (name === '') {
          sendJson(res, 422, { message: 'name is required' });
          return;
        }
        const color = asStr(body.color, 'ededed');
        const label = { name, color };
        repo.labels.set(name, label);
        sendJson(res, 201, label);
        return;
      }
      if (method === 'GET' && tail.length === 1) {
        sendJson(res, 200, [...repo.labels.values()]);
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    // /issues
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const title = asStr(body.title);
          const labelsRaw = Array.isArray(body.labels) ? body.labels : [];
          const labels: Label[] = [];
          for (const raw of labelsRaw) {
            const name = typeof raw === 'string' ? raw : asStr((raw as Record<string, unknown>)?.name);
            const found = repo.labels.get(name);
            if (!found) {
              sendJson(res, 422, { message: `Label ${name} does not exist` });
              return;
            }
            labels.push(found);
          }
          const issue = createIssueRecord(repo, title, asStr(body.body), labels);
          sendJson(res, 201, issueJson(repo, issue));
          return;
        }
        if (method === 'GET') {
          const state = q.get('state') ?? 'open';
          const sort = q.get('sort') ?? 'created';
          const direction = q.get('direction') ?? 'desc';
          let list = [...repo.issues];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          if (sort === 'created') {
            list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          }
          const { page, perPage } = pageParams(q);
          sendJson(res, 200, paginate(list, page, perPage).map((i) => issueJson(repo, i)));
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const num = Number.parseInt(tail[1] ?? '', 10);
      const issue = repo.issues.find((i) => i.number === num);
      if (tail.length === 2) {
        if (!issue) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
        if (method === 'PATCH') {
          if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          issue.updated_at = isoNow();
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (!issue) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (method === 'POST') {
          const commentBody = asStr(body.body);
          const comment: Comment = { id: nextCommentId++, body: commentBody, created_at: isoNow() };
          issue.comments.push(comment);
          sendJson(res, 201, commentJson(repo, issue, comment));
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => commentJson(repo, issue, c)));
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    // /pulls
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const headRef = asStr(body.head);
          const baseRef = asStr(body.base, repo.defaultBranch);
          const headTip = repo.refs.get(`refs/heads/${headRef}`);
          const baseTip = repo.refs.get(`refs/heads/${baseRef}`);
          if (!headTip || !baseTip) {
            sendJson(res, 422, { message: 'head or base branch not found' });
            return;
          }
          if (headRef === baseRef) {
            sendJson(res, 422, { message: 'head and base are the same' });
            return;
          }
          const existing = repo.pulls.find((p) => p.head.ref === headRef && p.base.ref === baseRef && p.state === 'open');
          if (existing) {
            sendJson(res, 422, { message: 'A pull request already exists for this head and base' });
            return;
          }
          const pull = createPullRecord(repo, asStr(body.title), asStr(body.body), headRef, headTip, baseRef, baseTip);
          sendJson(res, 201, pullJson(repo, pull));
          return;
        }
        if (method === 'GET') {
          const state = q.get('state') ?? 'open';
          let list = [...repo.pulls];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, b) => b.seq - a.seq);
          const { page, perPage } = pageParams(q);
          sendJson(res, 200, paginate(list, page, perPage).map((p) => pullJson(repo, p)));
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const num = Number.parseInt(tail[1] ?? '', 10);
      const pull = repo.pulls.find((p) => p.number === num);
      if (tail.length === 2) {
        if (!pull) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, pullJson(repo, pull));
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (tail.length === 3 && tail[2] === 'files') {
        if (!pull) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, pull.files);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (tail.length === 3 && tail[2] === 'merge') {
        if (!pull) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (method === 'PUT') {
          if (pull.merged) {
            sendJson(res, 200, { merged: true, sha: pull.merge_commit_sha, message: 'Already merged' });
            return;
          }
          const result = squashMerge(repo, pull);
          if (!result.ok) {
            sendJson(res, 405, { message: 'Merge conflict' });
            return;
          }
          sendJson(res, 200, { merged: true, sha: result.sha, message: `Merged pull request #${pull.number}` });
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

/** The subtree oid of `dirPath` inside `treeOid`, or null. */
function findSubtreeOid(repo: Repo, treeOid: string, dirPath: string): string | null {
  const segs = dirPath.split('/').filter((s) => s !== '');
  let cur = treeOid;
  for (const seg of segs) {
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === seg && e.mode === '40000');
    if (!entry) return null;
    cur = entry.oid;
  }
  return cur;
}

// -------------------------------------------------------------------------------------------
// git smart HTTP
// -------------------------------------------------------------------------------------------

const AGENT = 'github-core-clone/1.0';

function v2Advertisement(): Buffer {
  const lines = [
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done filter\n',
    'object-format=sha1\n',
  ];
  return Buffer.concat([...lines.map((l) => pktLine(l)), FLUSH]);
}

function v0RefLines(repo: Repo, caps: string): Buffer[] {
  const parts: Buffer[] = [];
  const refs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headRef);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    return parts;
  }
  let first = true;
  const pushLine = (line: string): void => {
    if (first) {
      parts.push(pktLine(`${line}\0${caps}\n`));
      first = false;
    } else {
      parts.push(pktLine(`${line}\n`));
    }
  };
  pushLine(`${headTip ?? ZERO_OID} HEAD`);
  for (const [ref, oid] of refs) {
    pushLine(`${oid} ${ref}`);
    const obj = repo.objects.get(oid);
    if (obj?.type === 'tag') {
      const peeled = peelToCommit(repo, oid);
      parts.push(pktLine(`${peeled} ${ref}^{}\n`));
    }
  }
  return parts;
}

function gitAdvertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', v2: boolean): Buffer {
  if (v2) return v2Advertisement();
  const preamble = `# service=${service}\n`;
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT} side-band-64k thin-pack ofs-delta shallow multi_ack object-format=sha1`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  return Buffer.concat([pktLine(preamble), ...v0RefLines(repo, caps), FLUSH]);
}

interface LsRef {
  oid: string;
  name: string;
  symrefTarget?: string;
  peeled?: string;
  unborn?: boolean;
}

function listRefs(repo: Repo, prefixes: string[]): LsRef[] {
  const out: LsRef[] = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (prefixes.length === 0) {
    if (headTip) out.push({ oid: headTip, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}` });
    else out.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}`, unborn: true });
  }
  const refs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  for (const [ref, oid] of refs) {
    if (!keep(ref)) continue;
    const entry: LsRef = { oid, name: ref };
    const obj = repo.objects.get(oid);
    if (obj?.type === 'tag') entry.peeled = peelToCommit(repo, oid);
    out.push(entry);
  }
  return out;
}

function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const data = Buffer.concat([Buffer.from([1]), pack.subarray(off, off + CHUNK)]);
    parts.push(pktLine(data));
  }
  return parts;
}

/** Handle POST git-upload-pack (v2 or v0) and git-receive-pack. */
function handleGitPost(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  try {
    if (service === 'git-receive-pack') {
      handleReceivePack(repo, res, body);
      return;
    }
    if (isV2) handleUploadPackV2(repo, res, body);
    else handleUploadPackV0(repo, res, body);
  } catch {
    // Never die on a malformed git request: the suite probes survival after bad input.
    sendJson(res, 400, { message: 'Bad git request' });
  }
}

function parseV2Lines(body: Buffer): string[] {
  const { packets } = decodePktLines(body);
  const lines: string[] = [];
  for (const p of packets) {
    if (p.kind === 'data') lines.push(p.payload.toString('utf8'));
  }
  return lines;
}

function handleUploadPackV2(repo: Repo, res: ServerResponse, body: Buffer): void {
  const lines = parseV2Lines(body);
  const command = lines.find((l) => l.startsWith('command='))?.slice('command='.length).trim() ?? '';
  if (command === 'ls-refs') {
    const prefixes: string[] = [];
    let peel = false;
    for (const l of lines) {
      if (l.startsWith('ref-prefix ')) prefixes.push(l.slice('ref-prefix '.length).trim());
      if (l.trim() === 'peel') peel = true;
    }
    const refs = listRefs(repo, prefixes);
    const parts: Buffer[] = [];
    for (const r of refs) {
      let line: string;
      if (r.unborn) {
        line = `unborn ${r.name}${r.symrefTarget ? ` symref-target:${r.symrefTarget}` : ''}`;
      } else {
        line = `${r.oid} ${r.name}`;
        if (r.symrefTarget) line += ` symref-target:${r.symrefTarget}`;
        if (peel && r.peeled) line += ` peeled:${r.peeled}`;
      }
      parts.push(pktLine(`${line}\n`));
    }
    parts.push(FLUSH);
    sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
    return;
  }
  if (command === 'fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallowIn: string[] = [];
    let depth: number | null = null;
    for (const l of lines) {
      const t = l.trim();
      if (t.startsWith('want ')) wants.push(t.slice(5).trim());
      else if (t.startsWith('have ')) haves.push(t.slice(5).trim());
      else if (t.startsWith('shallow ')) shallowIn.push(t.slice(8).trim());
      else if (t.startsWith('deepen ')) {
        const n = Number.parseInt(t.slice(7).trim(), 10);
        if (Number.isFinite(n)) depth = n;
      }
    }
    const parts: Buffer[] = [];
    const { objects, shallow, unshallow } = fetchSet(repo, wants, haves, shallowIn, depth);
    // acknowledgments
    parts.push(pktLine('acknowledgments\n'));
    if (objects.size === 0 && haves.length > 0) {
      for (const h of haves) parts.push(pktLine(`ACK ${h}\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(DELIM);
    // shallow-info
    if (depth !== null || shallowIn.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
      for (const s of unshallow) parts.push(pktLine(`unshallow ${s}\n`));
      parts.push(DELIM);
    }
    // packfile
    if (objects.size > 0) {
      parts.push(pktLine('packfile\n'));
      const pack = writePack([...objects.values()]);
      parts.push(...sidebandPack(pack));
    }
    parts.push(FLUSH);
    sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
    return;
  }
  sendJson(res, 400, { message: 'Unknown v2 command' });
}

function handleUploadPackV0(repo: Repo, res: ServerResponse, body: Buffer): void {
  const { packets, rest } = decodePktLines(body);
  // v0 fetch: wants (with features on first line), optional shallow/deepen, flush, haves, done, flush.
  const lines: string[] = [];
  let sawFlush = false;
  for (const p of packets) {
    if (p.kind === 'flush') {
      sawFlush = true;
      continue;
    }
    if (p.kind === 'data') lines.push(p.payload.toString('utf8'));
  }
  if (!sawFlush && lines.length === 0) throw new Error('malformed v0 fetch');
  void rest;
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowIn: string[] = [];
  let depth: number | null = null;
  for (const l of lines) {
    const t = l.trim();
    if (t.startsWith('want ')) wants.push(t.slice(5).split(' ')[0]!);
    else if (t.startsWith('have ')) haves.push(t.slice(5).trim());
    else if (t.startsWith('shallow ')) shallowIn.push(t.slice(8).trim());
    else if (t.startsWith('deepen ')) {
      const n = Number.parseInt(t.slice(7).trim(), 10);
      if (Number.isFinite(n)) depth = n;
    }
  }
  const { objects, shallow, unshallow } = fetchSet(repo, wants, haves, shallowIn, depth);
  const parts: Buffer[] = [];
  if (objects.size === 0 && haves.length > 0) {
    for (const h of haves) parts.push(pktLine(`ACK ${h}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  if (objects.size > 0) {
    const pack = writePack([...objects.values()]);
    parts.push(...sidebandPack(pack));
  }
  parts.push(FLUSH);
  sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(repo: Repo, res: ServerResponse, body: Buffer): void {
  const { packets, rest } = decodePktLines(body);
  const commands: PushCommand[] = [];
  let sawFlush = false;
  for (const p of packets) {
    if (p.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (p.kind !== 'data') continue;
    let line = p.payload.toString('utf8');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const parts = trimmed.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const packBytes = body.subarray(rest);
  if (commands.some((c) => c.newOid !== ZERO_OID) && packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack error';
    }
  } else if (commands.some((c) => c.newOid !== ZERO_OID) && packBytes.length === 0) {
    unpackOk = false;
    unpackDetail = 'unpack error: no pack';
  }
  void sawFlush;
  const results: { ref: string; ok: boolean; reason: string }[] = [];
  if (!unpackOk) {
    for (const c of commands) results.push({ ref: c.ref, ok: false, reason: 'unpack error' });
  } else {
    for (const c of commands) {
      const current = repo.refs.get(c.ref);
      if (c.newOid === ZERO_OID) {
        // delete
        if (!current) {
          results.push({ ref: c.ref, ok: false, reason: 'ref does not exist' });
        } else if (current !== c.oldOid) {
          results.push({ ref: c.ref, ok: false, reason: 'old value does not match' });
        } else {
          repo.refs.delete(c.ref);
          results.push({ ref: c.ref, ok: true, reason: '' });
        }
        continue;
      }
      const newObj = repo.objects.get(c.newOid);
      if (!newObj || (newObj.type !== 'commit' && newObj.type !== 'tag')) {
        results.push({ ref: c.ref, ok: false, reason: 'object not found' });
        continue;
      }
      if (!current) {
        if (c.oldOid !== ZERO_OID) {
          results.push({ ref: c.ref, ok: false, reason: 'old value does not match' });
          continue;
        }
        repo.refs.set(c.ref, c.newOid);
        results.push({ ref: c.ref, ok: true, reason: '' });
        continue;
      }
      if (current !== c.oldOid) {
        results.push({ ref: c.ref, ok: false, reason: 'old value does not match' });
        continue;
      }
      const newCommit = peelToCommit(repo, c.newOid);
      const oldCommit = peelToCommit(repo, current);
      if (!isAncestor(repo, oldCommit, newCommit)) {
        results.push({ ref: c.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(c.ref, c.newOid);
      results.push({ ref: c.ref, ok: true, reason: '' });
    }
  }
  reportLines.push(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`);
  for (const r of results) {
    reportLines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  }
  const report = Buffer.concat(reportLines.map((l) => pktLine(l)));
  const band1 = Buffer.concat([Buffer.from([1]), report]);
  const parts: Buffer[] = [pktLine(band1), FLUSH];
  sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
}

// -------------------------------------------------------------------------------------------
// GraphQL v4 — a small parser + executor for the documents gh / github-mcp-server send
// -------------------------------------------------------------------------------------------

type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: Map<string, GqlValue> };

interface GqlField {
  alias: string | null;
  name: string;
  args: Map<string, GqlValue>;
  selections: GqlField[] | null;
  fragmentType: string | null;
}

interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Map<string, GqlValue>;
  selections: GqlField[];
}

type Token =
  | { t: 'punct'; v: string }
  | { t: 'name'; v: string }
  | { t: 'string'; v: string }
  | { t: 'int'; v: number };

function tokenizeGql(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ t: 'punct', v: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$'.includes(c)) {
      tokens.push({ t: 'punct', v: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const n = src[j + 1]!;
          out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n;
          j += 2;
        } else {
          out += src[j]!;
          j += 1;
        }
      }
      tokens.push({ t: 'string', v: out });
      i = j + 1;
      continue;
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && src[j]! >= '0' && src[j]! <= '9') j += 1;
      tokens.push({ t: 'int', v: Number.parseInt(src.slice(i, j), 10) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j += 1;
      tokens.push({ t: 'name', v: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  return tokens;
}

class GqlParser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return t;
  }
  private expectPunct(v: string): void {
    const t = this.next();
    if (t.t !== 'punct' || t.v !== v) throw new Error(`expected ${v} in GraphQL document`);
  }
  private expectName(): string {
    const t = this.next();
    if (t.t !== 'name') throw new Error('expected a name in GraphQL document');
    return t.v;
  }

  parseDocument(): GqlOperation[] {
    const ops: GqlOperation[] = [];
    while (this.pos < this.tokens.length) {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  private parseOperation(): GqlOperation {
    let kind: 'query' | 'mutation' = 'query';
    const t = this.peek();
    if (t?.t === 'name' && (t.v === 'query' || t.v === 'mutation')) {
      kind = t.v;
      this.next();
    }
    let name: string | null = null;
    const nt = this.peek();
    if (nt?.t === 'name') {
      name = this.next().v as string;
    }
    const variables = new Map<string, GqlValue>();
    if (this.peek()?.t === 'punct' && (this.peek() as { v: string }).v === '(') {
      this.next();
      while (!(this.peek()?.t === 'punct' && (this.peek() as { v: string }).v === ')')) {
        const dollar = this.next();
        if (dollar.t !== 'punct' || dollar.v !== '$') throw new Error('expected $ in variable definition');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        // optional default value
        if (this.peek()?.t === 'punct' && (this.peek() as { v: string }).v === '=') {
          this.next();
          this.parseValue();
        }
        variables.set(varName, { kind: 'null' });
      }
      this.expectPunct(')');
    }
    const selections = this.parseSelectionSet();
    return { kind, name, variables, selections };
  }

  private parseType(): void {
    const t = this.peek();
    if (t?.t === 'punct' && t.v === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek()?.t === 'punct' && (this.peek() as { v: string }).v === '!') this.next();
  }

  private parseSelectionSet(): GqlField[] {
    this.expectPunct('{');
    const fields: GqlField[] = [];
    while (!(this.peek()?.t === 'punct' && (this.peek() as { v: string }).v === '}')) {
      fields.push(this.parseSelection());
    }
    this.expectPunct('}');
    return fields;
  }

  private parseSelection(): GqlField {
    const t = this.peek();
    if (t?.t === 'punct' && t.v === '...') {
      this.next();
      const nt = this.peek();
      if (nt?.t === 'name' && nt.v === 'on') {
        this.next();
        const typeName = this.expectName();
        const selections = this.parseSelectionSet();
        return { alias: null, name: '...', args: new Map(), selections, fragmentType: typeName };
      }
      throw new Error('named fragments are not supported');
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek()?.t === 'punct' && (this.peek() as { v: string }).v === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = new Map<string, GqlValue>();
    if (this.peek()?.t === 'punct' && (this.peek() as { v: string }).v === '(') {
      this.next();
      while (!(this.peek()?.t === 'punct' && (this.peek() as { v: string }).v === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.set(argName, this.parseValue());
      }
      this.expectPunct(')');
    }
    let selections: GqlField[] | null = null;
    if (this.peek()?.t === 'punct' && (this.peek() as { v: string }).v === '{') {
      selections = this.parseSelectionSet();
    }
    return { alias, name, args, selections, fragmentType: null };
  }

  private parseValue(): GqlValue {
    const t = this.next();
    if (t.t === 'punct' && t.v === '$') return { kind: 'var', name: this.expectName() };
    if (t.t === 'string') return { kind: 'string', value: t.v };
    if (t.t === 'int') return { kind: 'int', value: t.v };
    if (t.t === 'punct' && t.v === '[') {
      const values: GqlValue[] = [];
      while (!(this.peek()?.t === 'punct' && (this.peek() as { v: string }).v === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.t === 'punct' && t.v === '{') {
      const fields = new Map<string, GqlValue>();
      while (!(this.peek()?.t === 'punct' && (this.peek() as { v: string }).v === '}')) {
        const key = this.expectName();
        this.expectPunct(':');
        fields.set(key, this.parseValue());
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.t === 'name') {
      if (t.v === 'true') return { kind: 'bool', value: true };
      if (t.v === 'false') return { kind: 'bool', value: false };
      if (t.v === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.v };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

function resolveValue(v: GqlValue, variables: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'var':
      return variables[v.name] ?? null;
    case 'string':
      return v.value;
    case 'int':
      return v.value;
    case 'bool':
      return v.value;
    case 'null':
      return null;
    case 'enum':
      return v.value;
    case 'list':
      return v.values.map((x) => resolveValue(x, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, val] of v.fields) out[k] = resolveValue(val, variables);
      return out;
    }
  }
}

function resolveArgs(field: GqlField, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of field.args) out[k] = resolveValue(v, variables);
  return out;
}

// -------------------------------------------------------------------------------------------
// GraphQL schema (field sets for validation) and resolvers
// -------------------------------------------------------------------------------------------

const GQL_SCHEMA: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  User: ['login', 'id', 'name', 'email'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'updatedAt'],
  Ref: ['name', 'target'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'labels', 'comments', 'repository', 'url', 'locked'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'author', 'createdAt', 'updatedAt', 'headRef', 'baseRef', 'url'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changes', 'status'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'args', 'type'],
  __EnumValue: ['name', 'description'],
  __InputValue: ['name', 'description'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  Node: ['id'],
};

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'closedAt', 'labels', 'comments', 'repository', 'url', 'locked'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'author', 'createdAt', 'updatedAt', 'headRef', 'baseRef', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'updatedAt'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

type GqlObj =
  | { __type: 'Query' }
  | { __type: 'Mutation' }
  | { __type: 'User'; login: string }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'Ref'; name: string }
  | { __type: 'Issue'; repo: Repo; issue: Issue }
  | { __type: 'IssueConnection'; repo: Repo; nodes: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | { __type: 'PullRequest'; repo: Repo; pull: Pull }
  | { __type: 'PullRequestConnection'; repo: Repo; nodes: Pull[] }
  | { __type: 'PullRequestChangedFileConnection'; files: PullFile[] }
  | { __type: 'PullRequestChangedFile'; file: PullFile }
  | { __type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __type: '__Type'; typeName: string }
  | { __type: 'CreateIssuePayload'; repo: Repo; issue: Issue }
  | { __type: 'CloseIssuePayload'; repo: Repo; issue: Issue }
  | { __type: 'CreatePullRequestPayload'; repo: Repo; pull: Pull }
  | { __type: 'MergePullRequestPayload'; repo: Repo; pull: Pull }
  | { __type: 'AddCommentPayload'; repo: Repo; issue: Issue; comment: Comment };

function cursorEncode(index: number): string {
  return Buffer.from(`idx:${index}`, 'utf8').toString('base64');
}
function cursorDecode(cursor: string | null | undefined): number | null {
  if (!cursor) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('idx:')) return null;
    const n = Number.parseInt(text.slice(4), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): GqlObj {
  let list = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
  const direction = orderBy && typeof orderBy.direction === 'string' ? orderBy.direction : 'ASC';
  list.sort((a, b) => (direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
  const afterIndex = cursorDecode(typeof args.after === 'string' ? args.after : null);
  const start = afterIndex === null ? 0 : afterIndex + 1;
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(start, start + first);
  const lastIndex = page.length > 0 ? start + page.length - 1 : start - 1;
  const hasNextPage = lastIndex + 1 < list.length;
  return {
    __type: 'IssueConnection',
    repo,
    nodes: page,
    pageInfo: { hasNextPage, endCursor: page.length > 0 ? cursorEncode(lastIndex) : null },
  };
}

function executeSelections(selections: GqlField[], obj: GqlObj, variables: Record<string, unknown>, errors: { message: string }[]): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const typeName = obj.__type === 'Query' || obj.__type === 'Mutation' ? obj.__type : obj.__type;
  const allowed = GQL_SCHEMA[typeName] ?? [];
  for (const field of selections) {
    if (field.name === '...') {
      // inline fragment: apply when the type matches (or is the Node interface)
      if (field.fragmentType && field.fragmentType !== typeName && field.fragmentType !== 'Node') continue;
      const nested = executeSelections(field.selections ?? [], obj, variables, errors);
      Object.assign(data, nested);
      continue;
    }
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      data[key] = typeName;
      continue;
    }
    if (!allowed.includes(field.name)) {
      errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      data[key] = null;
      continue;
    }
    try {
      const value = resolveField(obj, field, variables, errors);
      data[key] = value;
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err) });
      data[key] = null;
    }
  }
  return data;
}

/** Resolve one field to a JSON value; nested objects are executed against their selections. */
function resolveField(obj: GqlObj, field: GqlField, variables: Record<string, unknown>, errors: { message: string }[]): unknown {
  const args = resolveArgs(field, variables);
  const sel = field.selections;
  const sub = (child: GqlObj): unknown => {
    if (!sel) return scalarOf(child);
    return executeSelections(sel, child, variables, errors);
  };
  switch (obj.__type) {
    case 'Query': {
      if (field.name === 'viewer') return sub({ __type: 'User', login: VIEWER_LOGIN });
      if (field.name === 'repository') {
        const repo = getRepo(asStr(args.owner), asStr(args.name));
        if (!repo) return null;
        return sub({ __type: 'Repository', repo });
      }
      if (field.name === 'node') {
        const decoded = decodeGlobalId(asStr(args.id));
        if (!decoded) return null;
        if (decoded.kind === 'Repository') {
          const repo = [...repos.values()].find((r) => String(r.id) === decoded.key);
          if (!repo) return null;
          return sub({ __type: 'Repository', repo });
        }
        if (decoded.kind === 'Issue') {
          const [owner, name, num] = decoded.key.split('/');
          const repo = getRepo(owner ?? '', name ?? '');
          const issue = repo?.issues.find((i) => i.number === Number(num));
          if (!repo || !issue) return null;
          return sub({ __type: 'Issue', repo, issue });
        }
        if (decoded.kind === 'PullRequest') {
          const [owner, name, num] = decoded.key.split('/');
          const repo = getRepo(owner ?? '', name ?? '');
          const pull = repo?.pulls.find((p) => p.number === Number(num));
          if (!repo || !pull) return null;
          return sub({ __type: 'PullRequest', repo, pull });
        }
        return null;
      }
      if (field.name === '__type') {
        return sub({ __type: '__Type', typeName: asStr(args.name) });
      }
      return null;
    }
    case 'Mutation': {
      if (field.name === 'createIssue') {
        const input = isRecord(args.input) ? args.input : {};
        const decoded = decodeGlobalId(asStr(input.repositoryId));
        if (!decoded || decoded.kind !== 'Repository') throw new Error('createIssue: unknown repositoryId');
        const repo = [...repos.values()].find((r) => String(r.id) === decoded.key);
        if (!repo) throw new Error('createIssue: repository not found');
        const issue = createIssueRecord(repo, asStr(input.title), asStr(input.body), []);
        return sub({ __type: 'CreateIssuePayload', repo, issue });
      }
      if (field.name === 'closeIssue') {
        const input = isRecord(args.input) ? args.input : {};
        const decoded = decodeGlobalId(asStr(input.issueId));
        if (!decoded || decoded.kind !== 'Issue') throw new Error('closeIssue: unknown issueId');
        const [owner, name, num] = decoded.key.split('/');
        const repo = getRepo(owner ?? '', name ?? '');
        const issue = repo?.issues.find((i) => i.number === Number(num));
        if (!repo || !issue) throw new Error('closeIssue: issue not found');
        issue.state = 'closed';
        issue.updated_at = isoNow();
        return sub({ __type: 'CloseIssuePayload', repo, issue });
      }
      if (field.name === 'createPullRequest') {
        const input = isRecord(args.input) ? args.input : {};
        const decoded = decodeGlobalId(asStr(input.repositoryId));
        if (!decoded || decoded.kind !== 'Repository') throw new Error('createPullRequest: unknown repositoryId');
        const repo = [...repos.values()].find((r) => String(r.id) === decoded.key);
        if (!repo) throw new Error('createPullRequest: repository not found');
        const headRef = asStr(input.headRefName);
        const baseRef = asStr(input.baseRefName);
        const headTip = repo.refs.get(`refs/heads/${headRef}`);
        const baseTip = repo.refs.get(`refs/heads/${baseRef}`);
        if (!headTip || !baseTip) throw new Error('createPullRequest: head or base branch not found');
        const existing = repo.pulls.find((p) => p.head.ref === headRef && p.base.ref === baseRef && p.state === 'open');
        if (existing) throw new Error('createPullRequest: pull request already exists');
        const pull = createPullRecord(repo, asStr(input.title), asStr(input.body), headRef, headTip, baseRef, baseTip);
        return sub({ __type: 'CreatePullRequestPayload', repo, pull });
      }
      if (field.name === 'mergePullRequest') {
        const input = isRecord(args.input) ? args.input : {};
        const decoded = decodeGlobalId(asStr(input.pullRequestId));
        if (!decoded || decoded.kind !== 'PullRequest') throw new Error('mergePullRequest: unknown pullRequestId');
        const [owner, name, num] = decoded.key.split('/');
        const repo = getRepo(owner ?? '', name ?? '');
        const pull = repo?.pulls.find((p) => p.number === Number(num));
        if (!repo || !pull) throw new Error('mergePullRequest: pull request not found');
        if (!pull.merged) {
          const result = squashMerge(repo, pull);
          if (!result.ok) throw new Error(`mergePullRequest: ${result.reason}`);
        }
        return sub({ __type: 'MergePullRequestPayload', repo, pull });
      }
      if (field.name === 'addComment') {
        const input = isRecord(args.input) ? args.input : {};
        const decoded = decodeGlobalId(asStr(input.subjectId));
        if (!decoded || decoded.kind !== 'Issue') throw new Error('addComment: unknown subjectId');
        const [owner, name, num] = decoded.key.split('/');
        const repo = getRepo(owner ?? '', name ?? '');
        const issue = repo?.issues.find((i) => i.number === Number(num));
        if (!repo || !issue) throw new Error('addComment: issue not found');
        const comment: Comment = { id: nextCommentId++, body: asStr(input.body), created_at: isoNow() };
        issue.comments.push(comment);
        return sub({ __type: 'AddCommentPayload', repo, issue, comment });
      }
      return null;
    }
    case 'User': {
      if (field.name === 'login') return obj.login;
      if (field.name === 'id') return globalId('User', obj.login);
      if (field.name === 'name') return VIEWER_NAME;
      if (field.name === 'email') return VIEWER_EMAIL;
      return null;
    }
    case 'Repository': {
      const repo = obj.repo;
      switch (field.name) {
        case 'id':
          return globalId('Repository', String(repo.id));
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return sub({ __type: 'User', login: repo.owner });
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (!tip) return null;
          return sub({ __type: 'Ref', name: repo.defaultBranch });
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'description':
          return repo.description;
        case 'url':
          return `https://example.invalid/${repo.owner}/${repo.name}`;
        case 'createdAt':
        case 'updatedAt':
          return '2025-01-01T00:00:00.000Z';
        case 'issue': {
          const issue = repo.issues.find((i) => i.number === args.number);
          if (!issue) return null;
          return sub({ __type: 'Issue', repo, issue });
        }
        case 'issues':
          return sub(issuesConnection(repo, args));
        case 'pullRequests': {
          let list = [...repo.pulls].sort((a, b) => a.seq - b.seq);
          if (typeof args.first === 'number') list = list.slice(0, args.first);
          return sub({ __type: 'PullRequestConnection', repo, nodes: list });
        }
        case 'pullRequest': {
          const pull = repo.pulls.find((p) => p.number === args.number);
          if (!pull) return null;
          return sub({ __type: 'PullRequest', repo, pull });
        }
        default:
          return null;
      }
    }
    case 'Ref':
      return obj.name;
    case 'Issue': {
      const issue = obj.issue;
      switch (field.name) {
        case 'id':
          return globalId('Issue', `${obj.repo.owner}/${obj.repo.name}/${issue.number}`);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'body':
          return issue.body;
        case 'author':
          return sub({ __type: 'User', login: VIEWER_LOGIN });
        case 'createdAt':
          return issue.created_at;
        case 'updatedAt':
          return issue.updated_at;
        case 'url':
          return `https://example.invalid/${obj.repo.owner}/${obj.repo.name}/issues/${issue.number}`;
        default:
          return null;
      }
    }
    case 'IssueConnection': {
      if (field.name === 'nodes') return obj.nodes.map((issue) => sub({ __type: 'Issue', repo: obj.repo, issue }));
      if (field.name === 'totalCount') return obj.nodes.length;
      if (field.name === 'pageInfo') return sub({ __type: 'PageInfo', hasNextPage: obj.pageInfo.hasNextPage, endCursor: obj.pageInfo.endCursor });
      if (field.name === 'edges') {
        return obj.nodes.map((issue, i) => ({ node: sub({ __type: 'Issue', repo: obj.repo, issue }), cursor: cursorEncode(i) }));
      }
      return null;
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return obj.hasNextPage;
      if (field.name === 'hasPreviousPage') return false;
      if (field.name === 'endCursor') return obj.endCursor;
      if (field.name === 'startCursor') return null;
      return null;
    }
    case 'PullRequest': {
      const pull = obj.pull;
      switch (field.name) {
        case 'id':
          return globalId('PullRequest', `${obj.repo.owner}/${obj.repo.name}/${pull.number}`);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged':
          return pull.merged;
        case 'mergeable':
          return pullMergeable(obj.repo, pull);
        case 'headRefName':
          return pull.head.ref;
        case 'baseRefName':
          return pull.base.ref;
        case 'files': {
          let files = pull.files;
          if (typeof args.first === 'number') files = files.slice(0, args.first);
          return sub({ __type: 'PullRequestChangedFileConnection', files });
        }
        case 'author':
          return sub({ __type: 'User', login: VIEWER_LOGIN });
        case 'createdAt':
          return pull.created_at;
        case 'updatedAt':
          return pull.created_at;
        case 'url':
          return `https://example.invalid/${obj.repo.owner}/${obj.repo.name}/pull/${pull.number}`;
        default:
          return null;
      }
    }
    case 'PullRequestConnection': {
      if (field.name === 'nodes') return obj.nodes.map((pull) => sub({ __type: 'PullRequest', repo: obj.repo, pull }));
      if (field.name === 'totalCount') return obj.nodes.length;
      if (field.name === 'pageInfo') return sub({ __type: 'PageInfo', hasNextPage: false, endCursor: null });
      return null;
    }
    case 'PullRequestChangedFileConnection': {
      if (field.name === 'nodes') return obj.files.map((f) => sub({ __type: 'PullRequestChangedFile', file: f }));
      if (field.name === 'totalCount') return obj.files.length;
      if (field.name === 'pageInfo') return sub({ __type: 'PageInfo', hasNextPage: false, endCursor: null });
      return null;
    }
    case 'PullRequestChangedFile': {
      if (field.name === 'path') return obj.file.filename;
      if (field.name === 'additions') return obj.file.additions;
      if (field.name === 'deletions') return obj.file.deletions;
      if (field.name === 'changes') return obj.file.changes;
      if (field.name === 'status') return obj.file.status.toUpperCase();
      return null;
    }
    case '__Type': {
      const name = obj.typeName;
      if (field.name === 'name') return name;
      if (field.name === 'kind') return TYPE_ENUM_VALUES[name] ? 'ENUM' : 'OBJECT';
      if (field.name === 'fields') {
        const list = TYPE_FIELDS[name] ?? [];
        return list.map((n) => ({ name: n }));
      }
      if (field.name === 'enumValues') {
        const list = TYPE_ENUM_VALUES[name] ?? [];
        return list.map((n) => ({ name: n }));
      }
      if (field.name === 'description') return null;
      return null;
    }
    case 'CreateIssuePayload':
      if (field.name === 'issue') return sub({ __type: 'Issue', repo: obj.repo, issue: obj.issue });
      return null;
    case 'CloseIssuePayload':
      if (field.name === 'issue') return sub({ __type: 'Issue', repo: obj.repo, issue: obj.issue });
      return null;
    case 'CreatePullRequestPayload':
      if (field.name === 'pullRequest') return sub({ __type: 'PullRequest', repo: obj.repo, pull: obj.pull });
      return null;
    case 'MergePullRequestPayload':
      if (field.name === 'pullRequest') return sub({ __type: 'PullRequest', repo: obj.repo, pull: obj.pull });
      return null;
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') {
        // commentEdge's selections are on IssueCommentEdge: resolve its `node` against the comment.
        const nodeSel = (field.selections ?? []).find((s) => s.name === 'node');
        const nodeObj: GqlObj = { __type: 'IssueComment', repo: obj.repo, issue: obj.issue, comment: obj.comment };
        const node = nodeSel?.selections ? executeSelections(nodeSel.selections, nodeObj, variables, errors) : { id: null, body: obj.comment.body };
        return { node };
      }
      return null;
    }
    case 'IssueComment': {
      if (field.name === 'id') return globalId('IssueComment', `${obj.repo.owner}/${obj.repo.name}/${obj.issue.number}/${obj.comment.id}`);
      if (field.name === 'body') return obj.comment.body;
      if (field.name === 'author') return sub({ __type: 'User', login: VIEWER_LOGIN });
      if (field.name === 'createdAt') return obj.comment.created_at;
      return null;
    }
    default:
      return null;
  }
}

function scalarOf(obj: GqlObj): unknown {
  return null;
}

function executeGraphQLOperation(op: GqlOperation, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors: { message: string }[] } {
  const errors: { message: string }[] = [];
  const root: GqlObj = op.kind === 'mutation' ? { __type: 'Mutation' } : { __type: 'Query' };
  const data = executeSelections(op.selections, root, variables, errors);
  return { data, errors };
}

async function handleGraphql(req: IncomingMessage, res: ServerResponse, rawBody: Buffer): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (!authed(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  const parsed = parseJsonBody(rawBody);
  if (!parsed.ok) {
    sendJson(res, 400, { errors: [{ message: 'Invalid JSON' }] });
    return;
  }
  const value = parsed.value;
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (!isRecord(entry) || typeof entry.query !== 'string') {
      return { data: null, errors: [{ message: 'A GraphQL operation needs a query string' }] };
    }
    const variables = isRecord(entry.variables) ? (entry.variables as Record<string, unknown>) : {};
    let ops: GqlOperation[];
    try {
      ops = new GqlParser(tokenizeGql(entry.query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
    }
    let op = ops[0]!;
    if (typeof entry.operationName === 'string') {
      const named = ops.find((o) => o.name === entry.operationName);
      if (named) op = named;
    }
    const { data, errors } = executeGraphQLOperation(op, variables);
    const out: Record<string, unknown> = { data };
    if (errors.length > 0) out.errors = errors;
    return out;
  };
  if (Array.isArray(value)) {
    sendJson(res, 200, value.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(value));
}

// -------------------------------------------------------------------------------------------
// MCP — JSON-RPC 2.0 Streamable HTTP, modern 2026-07-28 discover + legacy initialize
// -------------------------------------------------------------------------------------------

const MCP_SERVER_NAME = 'github-core-clone';
const MCP_SERVER_VERSION = '1.0.0';

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, unknown>; required: string[] };
}

const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function mcpResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}
function mcpError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
function toolTextResult(data: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}
function toolErrorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callMcpTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = MCP_TOOLS.find((t) => t.name === name);
  if (!tool) return toolErrorResult(`Unknown tool: ${name}`);
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolErrorResult(`Missing required argument: ${required}`);
    }
  }
  const owner = asStr(args.owner, VIEWER_LOGIN);
  const repoName = asStr(args.repo ?? args.name);
  switch (name) {
    case 'create_repo': {
      const repo = getRepo(VIEWER_LOGIN, repoName);
      if (repo) return toolTextResult(repoJson(repo));
      const created = createRepoRecord(repoName, asStr(args.description), args.private === true);
      return toolTextResult(repoJson(created));
    }
    case 'get_repo': {
      const repo = getRepo(owner, repoName);
      if (!repo) return toolErrorResult(`Repository ${owner}/${repoName} not found`);
      return toolTextResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = getRepo(owner, repoName);
      if (!repo) return toolErrorResult(`Repository ${owner}/${repoName} not found`);
      const issue = createIssueRecord(repo, asStr(args.title), asStr(args.body), []);
      return toolTextResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = getRepo(owner, repoName);
      if (!repo) return toolErrorResult(`Repository ${owner}/${repoName} not found`);
      const state = asStr(args.state, 'open');
      let list = [...repo.issues];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      return toolTextResult(list.map((i) => issueJson(repo, i)));
    }
    case 'create_pull_request': {
      const repo = getRepo(owner, repoName);
      if (!repo) return toolErrorResult(`Repository ${owner}/${repoName} not found`);
      const headRef = asStr(args.head);
      const baseRef = asStr(args.base, repo.defaultBranch);
      const headTip = repo.refs.get(`refs/heads/${headRef}`);
      const baseTip = repo.refs.get(`refs/heads/${baseRef}`);
      if (!headTip || !baseTip) return toolErrorResult('head or base branch not found');
      const existing = repo.pulls.find((p) => p.head.ref === headRef && p.base.ref === baseRef && p.state === 'open');
      if (existing) return toolTextResult(pullJson(repo, existing));
      const pull = createPullRecord(repo, asStr(args.title), asStr(args.body), headRef, headTip, baseRef, baseTip);
      return toolTextResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = getRepo(owner, repoName);
      if (!repo) return toolErrorResult(`Repository ${owner}/${repoName} not found`);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(asStr(args.pull_number), 10);
      const pull = repo.pulls.find((p) => p.number === number);
      if (!pull) return toolErrorResult(`Pull request #${number} not found`);
      if (!pull.merged) {
        const result = squashMerge(repo, pull);
        if (!result.ok) return toolErrorResult(`Merge failed: ${result.reason}`);
      }
      return toolTextResult({ merged: true, number: pull.number, sha: pull.merge_commit_sha, state: pull.state });
    }
    default:
      return toolErrorResult(`Unknown tool: ${name}`);
  }
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, rawBody: Buffer): Promise<void> {
  const method = req.method ?? 'POST';
  if (method === 'DELETE') {
    sendJson(res, 200, {});
    return;
  }
  if (method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }
  if (!authed(req)) {
    sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
    return;
  }
  const parsed = parseJsonBody(rawBody);
  if (!parsed.ok) {
    res.writeHead(400, { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId() });
    res.end(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
    return;
  }
  const body = parsed.value;
  if (!isRecord(body) || typeof body.method !== 'string') {
    sendJson(res, 400, { jsonrpc: '2.0', id: isRecord(body) ? (body.id ?? null) : null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const id = body.id ?? null;
  const params = isRecord(body.params) ? body.params : {};
  // Notifications carry no id and get no JSON-RPC response.
  if (id === null && body.method.startsWith('notifications/')) {
    res.writeHead(202, { 'x-github-request-id': nextRequestId() });
    res.end();
    return;
  }
  switch (body.method) {
    case 'server/discover': {
      sendJson(res, 200, mcpResult(id, {
        supportedVersions: ['2026-07-28'],
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION } },
      }));
      return;
    }
    case 'initialize': {
      const requested = asStr(params.protocolVersion);
      const negotiated = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : '2025-11-25';
      sendJson(res, 200, mcpResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      }));
      return;
    }
    case 'ping': {
      sendJson(res, 200, mcpResult(id, {}));
      return;
    }
    case 'tools/list': {
      sendJson(res, 200, mcpResult(id, { tools: MCP_TOOLS }));
      return;
    }
    case 'tools/call': {
      const toolName = asStr(params.name);
      const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      const known = MCP_TOOLS.some((t) => t.name === toolName);
      if (!known) {
        sendJson(res, 200, mcpError(id, -32602, `Unknown tool: ${toolName}`));
        return;
      }
      sendJson(res, 200, mcpResult(id, callMcpTool(toolName, args)));
      return;
    }
    default: {
      sendJson(res, 200, mcpError(id, -32601, `Method not found: ${body.method}`));
      return;
    }
  }
}

// -------------------------------------------------------------------------------------------
// server
// -------------------------------------------------------------------------------------------

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const seg = segmentsOf(req);
        const method = req.method ?? 'GET';
        const q = queryOf(req);

        // Health probe: no auth.
        if (method === 'GET' && seg.length === 1 && seg[0] === 'healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        if (seg.length >= 2 && seg[1]!.endsWith('.git')) {
          const owner = seg[0]!;
          const repoName = seg[1]!.slice(0, -4);
          const repo = getRepo(owner, repoName);
          if (seg.length === 4 && seg[2] === 'info' && seg[3] === 'refs' && method === 'GET') {
            if (!repo) {
              sendJson(res, 404, { message: 'Not Found' });
              return;
            }
            const service = q.get('service');
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
              sendJson(res, 400, { message: 'Unknown service' });
              return;
            }
            const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2' && service === 'git-upload-pack';
            const body = gitAdvertisement(repo, service, isV2);
            sendRaw(res, 200, body, `application/x-${service}-advertisement`);
            return;
          }
          if (seg.length === 3 && (seg[2] === 'git-upload-pack' || seg[2] === 'git-receive-pack') && method === 'POST') {
            if (!repo) {
              sendJson(res, 404, { message: 'Not Found' });
              return;
            }
            const raw = await readBody(req);
            handleGitPost(repo, seg[2], req, res, raw);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // GraphQL v4
        if (seg.length === 2 && seg[0] === 'api' && seg[1] === 'graphql') {
          const raw = await readBody(req);
          await handleGraphql(req, res, raw);
          return;
        }

        // MCP
        if (seg.length === 1 && seg[0] === 'mcp') {
          const raw = await readBody(req);
          await handleMcp(req, res, raw);
          return;
        }

        // REST v3
        if (seg.length >= 2 && seg[0] === 'api' && seg[1] === 'v3') {
          const raw = await readBody(req);
          await handleRest(req, res, seg, q, raw);
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      }
    })();
  });
}
