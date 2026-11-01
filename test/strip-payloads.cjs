// 单元测试：stripDataPayloads 是否把「数据载荷」和「真命令」分得开
// 说明：本文件里的删除命令字面量是测试用例，不是要执行的命令。
const fs = require('node:fs');

const src = fs.readFileSync(process.argv[2], 'utf8');
const start = src.indexOf('const DATA_FLAGS');
const end = src.indexOf('function scriptViolation');
if (start < 0 || end < 0) {
  console.error('找不到函数区段');
  process.exit(2);
}
const code = src.slice(start, end);
const stripDataPayloads = new Function(code + '; return stripDataPayloads;')();

const RULE = /(rd|rmdir)\s+\/s|del\b[^\n]*\s\/s|remove-item[^\n]*-recurse|rm\s+-[a-z]*r/i;

// [名称, 输入, 期望是否命中]
const cases = [
  ['评论正文（不该拦）', 'bili comment reply BV1 123 "正文里提到 rm -f 不该被拦"', false],
  ['JSON 载荷（不该拦）', 'curl.exe -X POST -d "{\\"msg\\":\\"del /s /q D:\\\\tmp\\"}" https://x', false],
  ['--message 载荷（不该拦）', 'git commit --message "fix: 说明里写了 Remove-Item -Recurse 的历史"', false],
  ['裸命令（该拦）', 'Remove-Item -Recurse -Force D:\\tmp\\x', true],
  ['带引号路径的真命令（该拦）', 'Remove-Item -Recurse "D:\\tmp\\my dir"', true],
  ['bash -c 执行（该拦）', 'bash -c "rm -rf /tmp/x"', true],
  ['powershell -Command 执行（该拦）', 'powershell -Command "Remove-Item -Recurse D:\\tmp"', true],
  ['Write-Output 数据（不该拦）', 'echo "del /s /q 是危险命令，文档里举例"', false]
];

let fail = 0;
for (const [name, input, expect] of cases) {
  const out = stripDataPayloads(input);
  const hit = RULE.test(out);
  const ok = hit === expect;
  if (!ok) fail += 1;
  console.log((ok ? 'OK   ' : 'FAIL ') + (hit ? 'BLOCK ' : 'PASS  ') + name);
}
console.log('\n' + (fail === 0 ? '全部通过' : fail + ' 条不符预期'));
process.exit(fail === 0 ? 0 : 1);
