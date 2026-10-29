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

import { appendFileSync, mkdirSync } from 'node:fs';
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
export const inject = ['tools'];

export function apply(ctx, config = {}) {
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
