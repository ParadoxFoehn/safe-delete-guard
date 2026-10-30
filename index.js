/**
 * safe-delete-guard — 在工具执行前拦下永久删除命令（Host 插件）
 *
 * 它解决的问题
 *   可逆删除工具只在"被调用"时生效；真正的事故常常是命令直接绕过它，
 *   例如用一层 cmd /c 清缓存，引号转义把参数塌成盘根，递归删掉整个盘。
 *   这里挂一个全局 tools.guard，在**执行前**看命令字符串：命中破坏性删除
 *   就拒绝，并在拒绝消息里给出可逆工具的替代命令。
 *
 * 拦截口径（宁严勿松，但每条都说明怎么放行）
 *   递归/整盘：rd /s、del /s、Remove-Item -Recurse、rm -r*、format、diskpart、
 *              Clear-RecycleBin、cipher /w、sdelete、shred、mkfs、shutil.rmtree、
 *              fs.rmSync、robocopy /MIR
 *   单点永久删除：del、erase、Remove-Item、rm、unlink、os.remove、git clean -f
 *   命令包装：cmd /c 一律拒（套一层，内容不可见）
 *   脚本文件：.cmd/.bat/.ps1 只允许跑"工具目录"里的，其余先看内容再说
 *   放行：命令里出现可逆工具（默认 safe-delete.py）、或带 -WhatIf（只看不删）
 *
 * 配置（cordis.patch.yml 的 config）
 *   reversibleCommand  string   可逆删除命令前缀，默认 'py.cmd dsh-tools\\safe-delete.py'
 *   allowScriptDirs    string[] 额外允许运行脚本的目录（绝对路径）
 *   blockFlatDeletes   boolean  单点删除是否也拦，默认 true
 *
 * 边界（README「已知的边界」有完整版）
 *   只看命令行字符串：脚本文件内容、生成出来的子表达式看不见。
 */

import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const SHELL_TOOLS = new Set(['pwsh', 'bash', 'shell', 'powershell']);
// 代码执行类只匹配"强模式"（递归/整盘），避免把普通代码里的 remove 当删除命令
const CODE_TOOLS = new Set(['run_code', 'node', 'python']);

// 递归 / 整盘 / 抹除
const RECURSIVE = [
  { re: /\b(rd|rmdir)\s+\/s\b/i, label: 'rd /s（递归删目录）' },
  { re: /\bdel\b[^\n]*?\s\/s\b/i, label: 'del /s（递归删文件）' },
  { re: /\bremove-item\b[^\n]*?-recurse/i, label: 'Remove-Item -Recurse' },
  { re: /\brm\s+-[a-z]*r/i, label: 'rm -r / -rf' },
  { re: /\bformat\s+[a-z]:/i, label: 'format（格式化磁盘）' },
  { re: /\bdiskpart\b/i, label: 'diskpart' },
  { re: /\bclear-recyclebin\b/i, label: 'Clear-RecycleBin' },
  { re: /\bcipher\s+\/w/i, label: 'cipher /w' },
  { re: /\bsdelete\b/i, label: 'sdelete' },
  { re: /\b(shred|mkfs)\b/i, label: 'shred / mkfs' },
  { re: /\bshutil\.rmtree\b/i, label: 'shutil.rmtree' },
  { re: /\b(rmSync|rmdirSync|unlinkSync)\b/i, label: 'Node fs.rmSync / rmdirSync' },
  { re: /\brobocopy\b[^\n]*\/mir\b/i, label: 'robocopy /MIR（镜像会删多余文件）' }
];

// 单点永久删除（不进回收站）
const FLAT = [
  { re: /\b(del|erase)\b/i, label: 'del / erase' },
  { re: /\bremove-item\b/i, label: 'Remove-Item' },
  { re: /\brm\s+/i, label: 'rm' },
  { re: /\bunlink\s+/i, label: 'unlink' },
  { re: /\bos\.remove\(|\bos\.unlink\(/i, label: 'Python os.remove / os.unlink' },
  { re: /\bgit\s+clean\s+-[a-z]*f/i, label: 'git clean -f' }
];

// 命令包装：外面套一层 cmd，里面是什么看不见
const CMD_C = /\bcmd(\.exe)?\s+\/c\b/i;

// 允许运行脚本的"工具目录"特征（按路径段判断，不绑死某台机器的绝对路径）
const TOOL_SEGMENTS = [
  '\\dsh-tools\\', '\\dsh-plugins\\',
  '\\.dsh\\skills\\', '\\.dsh\\workflows\\', '\\.dsh\\plugins\\', '\\.dsh\\bin\\'
];

// 已知的、内容可信的工具包装器（裸名即可运行）
const TOOL_WRAPPERS = new Set([
  'py.cmd', 'py.ps1', 'boot.cmd', 'cross_ocr.cmd', 'moss-transcribe.cmd',
  'dsh-doctor.cmd', 'dsh-web.cmd', 'plugin.cmd', 'asar.cmd', 'fix-ports.cmd'
]);

const DEFAULT_REVERSIBLE = 'py.cmd dsh-tools\\safe-delete.py';

function logBlock(entry) {
  const line = JSON.stringify(entry) + '\n';
  const dirs = [];
  if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'dsh-safe-delete'));
  dirs.push(path.join(os.tmpdir(), 'dsh-safe-delete'));
  for (const dir of dirs) {
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(path.join(dir, 'guard.jsonl'), line, 'utf8');
      return;
    } catch {
      /* 换下一个位置；审计失败不影响拦截 */
    }
  }
}

function makeDeny(reversible) {
  return function deny(hit, command, extra) {
    const shown = command.replace(/\s+/g, ' ').trim().slice(0, 300);
    const lines = [
      `【删除拦截】这条命令会永久删除文件，而且不进回收站：${hit.label}`,
      `命令：${shown}`,
      ''
    ];
    if (extra) lines.push(extra, '');
    lines.push(
      '删除一律走可逆工具，别直接删。改成：',
      `  ${reversible} "<路径>" --dry-run   先看清单（展开后的绝对路径 + 文件数）`,
      `  ${reversible} "<路径>"             回收进隔离区（可还原）`,
      '真删（不可逆）才用 --purge <id> --yes。',
      '只在预览不落地的话，PowerShell 命令加 -WhatIf 也能放行。'
    );
    return lines.join('\n');
  };
}

function scriptViolation(text, workdir, extraDirs) {
  const CALL_WORDS = new Set(['start', 'call', '-file', '-f']);
  // 只在"命令位"检查：每条命令的首 token，或 start/call/-File 后面那个。
  // 否则 Set-Content 写一个 .ps1 也会被误判成执行它。
  for (const seg of text.split(/[\n;|&]+/)) {
    const toks = seg.trim().split(/[\s"'`]+/).filter(Boolean);
    for (let i = 0; i < toks.length; i++) {
      const low = toks[i].toLowerCase();
      const prev = i > 0 ? toks[i - 1].toLowerCase() : '';
      if (i !== 0 && !CALL_WORDS.has(prev)) continue;
      if (!/\.(cmd|bat|ps1)$/.test(low)) continue;
      const base = low.split(/[\\/]/).pop();
      if (TOOL_WRAPPERS.has(base)) continue;
      let p = toks[i];
      if (!/^[a-z]:[\\/]/i.test(p)) {
        const wd = (workdir || '').replace(/[\\/]+$/, '');
        p = (wd ? wd + '\\' : '') + p.replace(/^\.[\\/]/, '');
      }
      const norm = p.toLowerCase().replace(/\\{2,}/g, '\\');
      if (TOOL_SEGMENTS.some((s) => norm.includes(s))) continue;
      if (extraDirs.some((d) => norm.startsWith(d + '\\') || norm === d)) continue;
      return toks[i];
    }
  }
  return null;
}

export const name = 'safe-delete-guard';
export const inject = ['tools', 'webServer'];

export function apply(ctx, config = {}) {
  try { installRoutes(ctx); } catch (e) { console.error('[safe-delete-guard] routes:', e); }
  const reversible = typeof config.reversibleCommand === 'string' && config.reversibleCommand.trim()
    ? config.reversibleCommand.trim()
    : DEFAULT_REVERSIBLE;
  const extraDirs = Array.isArray(config.allowScriptDirs)
    ? config.allowScriptDirs
        .filter((d) => typeof d === 'string' && d.trim())
        .map((d) => d.trim().toLowerCase().replace(/[\\/]+$/, ''))
    : [];
  const blockFlat = config.blockFlatDeletes !== false;
  const deny = makeDeny(reversible);

  ctx.tools.guard((exec) => {
    if (!SHELL_TOOLS.has(exec.name) && !CODE_TOOLS.has(exec.name)) return undefined;
    const args = exec.arguments ?? {};
    const command = [args.command, args.code, args.script, args.cmd]
      .filter((v) => typeof v === 'string')
      .join('\n');
    if (!command.trim()) return undefined;

    // 可逆通道与只读预览，放行
    if (/safe-delete\.py/i.test(command)) return undefined;
    if (/-whatif\b/i.test(command)) return undefined;

    const hay = command.replace(/\s+/g, ' ');
    const workdir = typeof args.workdir === 'string' ? args.workdir : '';

    if (CMD_C.test(hay)) {
      logBlock({
        at: new Date().toISOString(), tool: exec.name, agent: exec.agent?.id ?? '',
        rule: 'cmd /c（套脚本）', command: command.slice(0, 2000)
      });
      return deny(
        { label: 'cmd /c（再用一层 cmd 套命令，内容不可见）' },
        command,
        '命令直接写；需要跑工具就用工具目录里的脚本（py.cmd 等），不要用 cmd /c 套一层。'
      );
    }

    const bad = scriptViolation(hay, workdir, extraDirs);
    if (bad) {
      logBlock({
        at: new Date().toISOString(), tool: exec.name, agent: exec.agent?.id ?? '',
        rule: '外部脚本 ' + bad, command: command.slice(0, 2000)
      });
      return deny(
        { label: `非工具目录的脚本：${bad}` },
        command,
        '脚本内容没法在执行前看清。先 read 它、确认没有删除逻辑，再单独跑；或把它挪进工具目录。'
      );
    }

    const list = SHELL_TOOLS.has(exec.name) ? RECURSIVE.concat(blockFlat ? FLAT : []) : RECURSIVE;
    const hit = list.find((p) => p.re.test(hay));
    if (!hit) return undefined;

    logBlock({
      at: new Date().toISOString(), tool: exec.name, agent: exec.agent?.id ?? '',
      rule: hit.label, command: command.slice(0, 2000)
    });
    return deny(hit, command);
  });
}


// ─────────────────────────────────────────────────────────────────────────────
// 回收站数据接口（给 Client 的悬浮面板用）
// 只读 + 两个动作：打开目录 / 清空。全部 loopback-only。
// ─────────────────────────────────────────────────────────────────────────────

function sendJson(res, status, body) {
  try {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(body));
  } catch { /* connection gone */ }
}

function isLoopback(req) {
  const host = String((req.headers && req.headers.host) || '').toLowerCase().split(':')[0];
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}

const CONFIG_PATH = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'dsh-safe-delete', 'config.json');

function readConfig() {
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) || {}; } catch { return {}; }
}

function writeConfig(patch) {
  const cur = readConfig();
  const next = Object.assign({}, cur, patch);
  try {
    mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 1), 'utf8');
  } catch { /* 写不进去就只在内存里生效 */ }
  return next;
}

function retentionDays() {
  const cfg = readConfig();
  const v = Number(cfg.retentionDays != null ? cfg.retentionDays : process.env.SAFE_DELETE_RETENTION_DAYS);
  return Number.isFinite(v) && v >= 0 ? v : 7;
}

/** 可选回收站位置：默认（每盘根）+ 每个存在的盘符。 */
function trashOptions() {
  const opts = [{ value: '', label: '默认：每个盘根下的 .dsh-trash' }];
  for (let c = 67; c <= 90; c++) {
    const drv = String.fromCharCode(c) + ':\\';
    if (drv.toUpperCase().startsWith('C:')) continue;   // 禁止往系统盘写
    try {
      if (existsSync(drv)) {
        const v = drv + '.dsh-trash';
        opts.push({ value: v, label: v });
      }
    } catch { /* skip */ }
  }
  return opts;
}

/** 把所有已回收条目搬到新位置（同卷改名，跨卷退化为复制+删除）。 */
function migrateTo(target, limit) {
  const dest = path.resolve(target);
  if (/^c:/i.test(dest)) return { ok: false, error: '禁止把回收站放到 C 盘' };
  let moved = 0, failed = 0;
  const items = collect();
  const batch = Number(limit) > 0 ? items.slice(0, Number(limit)) : items;
  for (const e of batch) {
    const rel = path.relative(e.root, e.dir);
    const dst = path.join(dest, rel);
    try {
      mkdirSync(path.dirname(dst), { recursive: true });
      if (existsSync(dst)) { failed += 1; continue; }
      try {
        renameSync(e.dir, dst);
      } catch {
        cpSync(e.dir, dst, { recursive: true });
        rmSync(e.dir, { recursive: true, force: true });
      }
      moved += 1;
    } catch { failed += 1; }
  }
  for (const r of trashRoots()) pruneEmpty(r);
  pruneEmpty(dest);
  return { ok: true, moved, failed, dest, remaining: collect().length };
}

function trashRoots() {
  const roots = new Set();
  const env = (process.env.SAFE_DELETE_TRASH || '').trim();
  if (env) roots.add(path.resolve(env));
  const cfgTrash = String((readConfig().trash || '')).trim();
  if (cfgTrash) roots.add(path.resolve(cfgTrash));
  for (let c = 67; c <= 90; c++) {
    const p = String.fromCharCode(c) + ':\\.dsh-trash';
    try { if (existsSync(p)) roots.add(p); } catch { /* skip */ }
  }
  try {
    const idx = path.join(process.env.LOCALAPPDATA || '', 'dsh-safe-delete', 'index.jsonl');
    if (existsSync(idx)) {
      for (const line of readFileSync(idx, 'utf8').split('\n')) {
        const s = line.trim();
        if (!s) continue;
        try { const d = JSON.parse(s); if (d.root) roots.add(path.resolve(d.root)); } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
  return [...roots];
}

function walkManifests(dir, depth, out) {
  if (depth <= 0 || out.length > 4000) return;
  let names;
  try { names = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of names) {
    if (!e.isDirectory()) continue;
    const full = path.join(dir, e.name);
    const mf = path.join(full, 'manifest.json');
    if (existsSync(mf)) out.push(mf);
    else walkManifests(full, depth - 1, out);
  }
}

function collect() {
  const entries = [];
  for (const root of trashRoots()) {
    const found = [];
    walkManifests(root, 3, found);
    for (const mf of found) {
      try {
        const d = JSON.parse(readFileSync(mf, 'utf8'));
        const items = Array.isArray(d.items) ? d.items : [];
        const files = items.reduce((n, i) => n + (Number(i.files) || 0), 0);
        const bytes = items.reduce((n, i) => n + (Number(i.bytes) || 0), 0);
        const rel = d.entryRel || d.id;
        let session = d.session || '';
        let turnLabel = d.turnLabel || '';
        if (!session || !turnLabel) {
          const parts = String(rel).split(/[\\/]+/);
          if (!session && parts.length >= 3) session = parts[0];
          if (!turnLabel && parts.length >= 3) turnLabel = parts[1];
        }
        entries.push({
          root,
          id: d.id,
          created: d.created || '',
          session: session || '未命名会话',
          turnLabel: turnLabel || '手动',
          files,
          bytes,
          dir: path.dirname(mf),
        });
      } catch { /* skip */ }
    }
  }
  return entries;
}

function diskInfo() {
  const roots = trashRoots();
  const root = roots.find((r) => { try { return existsSync(r); } catch { return false; } }) || roots[0] || '';
  const vol = root ? path.parse(root).root : '';
  try {
    const st = statfsSync(vol || '.');
    const free = Number(st.bavail) * Number(st.bsize);
    const total = Number(st.blocks) * Number(st.bsize);
    const cfg = readConfig();
    const lowGb = Number(cfg.lowFreeGb != null ? cfg.lowFreeGb : (process.env.SAFE_DELETE_LOW_FREE_GB || 1));
    const lowPct = Number(cfg.lowPercent != null ? cfg.lowPercent : 5);
    const low = total > 0
      ? (free / total) * 100 < lowPct || free < lowGb * 1024 * 1024 * 1024
      : false;
    return { root: vol, free, total, low, lowGb, lowPct };
  } catch {
    return { root: vol, free: 0, total: 0, low: false };
  }
}

function summarize() {
  const entries = collect();
  const bySession = new Map();
  for (const e of entries) {
    if (!bySession.has(e.session)) {
      let ctime = 0;
      try { ctime = statSync(path.join(e.root, e.session)).birthtimeMs || 0; } catch { /* skip */ }
      bySession.set(e.session, { name: e.session, files: 0, bytes: 0, createdAt: ctime, lastAt: '', turns: new Map() });
    }
    const s = bySession.get(e.session);
    s.files += e.files;
    s.bytes += e.bytes;
    if (e.created && String(e.created) > String(s.lastAt || '')) s.lastAt = e.created;
    if (!s.turns.has(e.turnLabel)) {
      const m = /^第(\d+)轮$/.exec(e.turnLabel);
      s.turns.set(e.turnLabel, {
        label: e.turnLabel,
        turn: m ? Number(m[1]) : 0,
        files: 0,
        bytes: 0,
        createdAt: e.created,
        lastAt: e.created,
      });
    }
    const t = s.turns.get(e.turnLabel);
    t.files += e.files;
    t.bytes += e.bytes;
    if (e.created && (!t.createdAt || e.created < t.createdAt)) t.createdAt = e.created;
    if (e.created && String(e.created) > String(t.lastAt || '')) t.lastAt = e.created;
  }
  const sessions = [...bySession.values()].map((s) => {
    const turns = [...s.turns.values()].sort((a, b) => b.turn - a.turn);
    return { name: s.name, files: s.files, bytes: s.bytes, createdAt: s.createdAt, lastAt: s.lastAt, turns };
  });
  sessions.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const latest = entries.slice().sort((a, b) => String(b.created).localeCompare(String(a.created)))[0];
  const current = latest ? sessions.find((s) => s.name === latest.session) || null : null;
  const total = sessions.reduce((acc, s) => ({ files: acc.files + s.files, bytes: acc.bytes + s.bytes }), { files: 0, bytes: 0 });
  const ret = retentionDays();
  return { ok: true, sessions, current, total, retentionDays: ret, count: entries.length, disk: diskInfo() };
}

/** 自底向上剪掉空目录（只删空目录，不碰文件）。 */
function pruneEmpty(root) {
  let pruned = 0;
  for (let round = 0; round < 40; round++) {
    let changed = false;
    const walk = (dir) => {
      let entries = [];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const full = path.join(dir, e.name);
        walk(full);
        try {
          if (readdirSync(full).length === 0) {
            rmdirSync(full);
            pruned += 1;
            changed = true;
          }
        } catch { /* 占用中就先留着 */ }
      }
    };
    walk(root);
    if (!changed) break;
  }
  return pruned;
}

function emptyTrash() {
  let removed = 0;
  let freed = 0;
  const roots = new Set();
  for (const e of collect()) {
    try {
      freed += e.bytes;
      rmSync(e.dir, { recursive: true, force: true });
      removed += 1;
      roots.add(e.root);
    } catch { /* keep going */ }
  }
  let pruned = 0;
  for (const root of trashRoots()) pruned += pruneEmpty(root);
  return { ok: true, removed, freed, pruned, roots: trashRoots() };
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 65536) raw = raw.slice(0, 65536); });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function safeName(v) {
  const s = String(v == null ? '' : v);
  if (!s || s === '.' || s === '..') return '';
  if (/[\\/:*?"<>|]/.test(s)) return '';
  return s;
}

/** 删掉某个一级（会话）或二级（轮次）目录。目录已经不在了也算成功。 */
function deleteScope(session, turn) {
  const name = safeName(session);
  const turnName = turn ? safeName(turn) : '';
  if (!name || (turn && !turnName)) return { ok: false, error: 'bad name' };
  let removed = 0;
  let freed = 0;
  const touchedRoots = new Set();
  // 删不掉的条目必须报出去，不能静默成功（2026-10-30 修）：
  // 文件被占用时 rmSync 会抛 EBUSY/EPERM，目录和 manifest.json 都还在 ——
  // 清单是按磁盘上的 manifest 扫出来的，所以那条会继续出现，而界面却显示"已删除"。
  const failed = [];
  for (const e of collect()) {
    if (e.session !== name) continue;
    if (turn && e.turnLabel !== turnName) continue;
    touchedRoots.add(e.root);
    try {
      rmSync(e.dir, { recursive: true, force: true });
      removed += 1;
      freed += e.bytes;
    } catch (err) {
      failed.push({
        dir: e.dir,
        session: name,
        turn: turnName,
        error: String((err && (err.code || err.message)) || err),
      });
    }
  }
  // 删完统一剪掉空目录（轮次 / 会话）
  for (const root of touchedRoots) pruneEmpty(root);
  return {
    ok: failed.length === 0,
    removed,
    freed,
    failed,
    alreadyGone: removed === 0 && failed.length === 0,
  };
}

function installRoutes(ctx) {
  const web = ctx.webServer || (ctx.get && ctx.get('webServer'));
  if (!web) return;
  const guard = (req, res, want) => {
    if (!isLoopback(req)) { sendJson(res, 403, { ok: false, error: 'loopback only' }); return false; }
    if (req.method !== want && !(want === 'GET' && req.method === 'HEAD')) {
      sendJson(res, 405, { ok: false, error: want + ' only' });
      return false;
    }
    return true;
  };

  ctx.effect(() => web.register({
    kind: 'exact',
    path: '/safe-delete/api/config',
    handler: (req, res) => {
      if (!isLoopback(req)) { sendJson(res, 403, { ok: false, error: 'loopback only' }); return; }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const cfg = readConfig();
        sendJson(res, 200, {
          ok: true,
          trashDir: cfg.trash || '',
          retentionDays: retentionDays(),
          effectiveRoots: trashRoots(),
          options: trashOptions(),
          configPath: CONFIG_PATH,
        });
        return;
      }
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'GET or POST only' }); return; }
      readJsonBody(req).then((body) => {
        const patch = {};
        if (typeof body.trash === 'string') {
          const v = body.trash.trim();
          if (/^c:/i.test(v)) { sendJson(res, 400, { ok: false, error: '禁止把回收站放到 C 盘' }); return; }
          patch.trash = v;
        }
        if (body.lowFreeGb != null) {
          const g = Number(body.lowFreeGb);
          if (!Number.isFinite(g) || g < 0) { sendJson(res, 400, { ok: false, error: 'lowFreeGb 非法' }); return; }
          patch.lowFreeGb = g;
        }
        if (body.retentionDays != null) {
          const d = Number(body.retentionDays);
          if (!Number.isFinite(d) || d < 0 || d > 3650) {
            sendJson(res, 400, { ok: false, error: 'retentionDays 必须是 0–3650 的数字' });
            return;
          }
          patch.retentionDays = d;
        }
        const next = writeConfig(patch);
        sendJson(res, 200, { ok: true, config: next, effectiveRoots: trashRoots() });
      });
    },
  }), 'safe-delete-guard: config route');


  ctx.effect(() => web.register({
    kind: 'exact',
    path: '/safe-delete/api/migrate',
    handler: (req, res) => {
      if (!isLoopback(req)) { sendJson(res, 403, { ok: false, error: 'loopback only' }); return; }
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST only' }); return; }
      const cfg = readConfig();
      const target = String(cfg.trash || '').trim();
      if (!target) { sendJson(res, 400, { ok: false, error: '未设置自定义位置' }); return; }
      readJsonBody(req).then((body) => {
        try { sendJson(res, 200, migrateTo(target, body && body.limit)); }
        catch (e) { sendJson(res, 500, { ok: false, error: String(e) }); }
      });
    },
  }), 'safe-delete-guard: migrate route');

  ctx.effect(() => web.register({
    kind: 'exact',
    path: '/safe-delete/api/trash',
    handler: (req, res) => {
      if (!guard(req, res, 'GET')) return;
      try { sendJson(res, 200, summarize()); } catch (e) { sendJson(res, 500, { ok: false, error: String(e) }); }
    },
  }), 'safe-delete-guard: trash route');


  ctx.effect(() => web.register({
    kind: 'exact',
    path: '/safe-delete/api/delete',
    handler: (req, res) => {
      if (!guard(req, res, 'POST')) return;
      readJsonBody(req).then((body) => {
        try {
          const out = deleteScope(body && body.session, body && body.turn);
          sendJson(res, out.ok ? 200 : 400, out);
        } catch (e) { sendJson(res, 500, { ok: false, error: String(e) }); }
      });
    },
  }), 'safe-delete-guard: delete route');

  ctx.effect(() => web.register({
    kind: 'exact',
    path: '/safe-delete/api/open',
    handler: (req, res) => {
      if (!guard(req, res, 'POST')) return;
      const roots = trashRoots();
      if (!roots.length) { sendJson(res, 200, { ok: false, error: 'trash not found' }); return; }
      try { spawn('explorer.exe', [roots[0]], { detached: true, stdio: 'ignore' }).unref(); } catch { /* ignore */ }
      sendJson(res, 200, { ok: true, path: roots[0] });
    },
  }), 'safe-delete-guard: open route');

  ctx.effect(() => web.register({
    kind: 'exact',
    path: '/safe-delete/api/empty',
    handler: (req, res) => {
      if (!guard(req, res, 'POST')) return;
      try { sendJson(res, 200, emptyTrash()); } catch (e) { sendJson(res, 500, { ok: false, error: String(e) }); }
    },
  }), 'safe-delete-guard: empty route');
}