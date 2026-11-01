// 单元测试：normalizeScriptPath（0003 的路径归一化）
const fs = require('node:fs');

const src = fs.readFileSync(process.argv[2], 'utf8');
const start = src.indexOf('function normalizeScriptPath');
const end = src.indexOf('function scriptViolation');
const code = src.slice(start, end);
const normalizeScriptPath = new Function(code + '; return normalizeScriptPath;')();

const TOOL_SEGMENTS = ['\\dsh-tools\\', '\\dsh-plugins\\', '\\.dsh\\skills\\'];

// [名称, 输入路径, 期望：是否被认作工具目录（=放行）]
const cases = [
  ['反斜杠绝对路径（放行）', 'D:\\Harness工作区\\dsh-tools\\x.ps1', true],
  ['正斜杠绝对路径（放行）', 'D:/Harness工作区/dsh-tools/x.ps1', true],
  ['MSYS 前缀（放行）', '/d/Harness工作区/dsh-tools/x.ps1', true],
  ['技能目录（放行）', 'D:/Harness工作区/.dsh/skills/comfyui-imagegen/scripts/a.ps1', true],
  ['反斜杠非工具目录（拦）', 'D:\\tmp\\evil.ps1', false],
  ['UNC 路径（拦，但前缀不能被压坏）', '\\\\server\\share\\evil.ps1', false],
  ['重复分隔符（放行）', 'D:\\\\Harness工作区\\\\dsh-tools\\\\x.ps1', true]
];

let fail = 0;
for (const [name, input, expect] of cases) {
  const norm = normalizeScriptPath(input);
  const inTool = TOOL_SEGMENTS.some((s) => norm.includes(s));
  const ok = inTool === expect;
  if (!ok) fail += 1;
  console.log((ok ? 'OK   ' : 'FAIL ') + name + '  ->  ' + norm);
}
// UNC 前缀单独验一遍
const uncNorm = normalizeScriptPath('\\\\server\\share\\evil.ps1');
const uncOk = uncNorm.startsWith('\\\\');
console.log((uncOk ? 'OK   ' : 'FAIL ') + 'UNC 前缀保留  ->  ' + uncNorm);
if (!uncOk) fail += 1;

console.log('\n' + (fail === 0 ? '全部通过' : fail + ' 条不符预期'));
process.exit(fail === 0 ? 0 : 1);
