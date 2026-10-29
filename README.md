# safe-delete-guard

给 DeepSeek Harness（DSH）用的删除拦截插件：**在执行前**拦下永久删除类命令，并把删除引导到可逆通道。

> 仓库：<https://github.com/ParadoxFoehn/safe-delete-guard> · 不是"让 AI 更聪明"，而是让"删错了"这件事有退路。

## 为什么会有它

一个真实事故：DSH 用 `cmd /c rd /s /q` 清 `__pycache__`，引号转义把参数塌成了盘根，
递归删掉整个 D 盘；`rd /s /q` 不进回收站，SSD 又立即下发 TRIM，数据恢复工具读到的是空白。

复盘下来，问题不在"模型会不会犯错"（一定会），而在：

1. **命令的目标是展开后才确定的**——写的时候没人看见展开后的样子；
2. **删除不可逆**——没有回收站、没有快照；
3. **没有任何一层在"执行前"看一眼**——工具只在被调用时生效，绕过它的命令畅通无阻。

这个插件补的是第 3 条。第 2 条由配套的 [safe-delete.py](tools/safe-delete.py) 补。

## 它做什么 / 不做什么

| | |
|---|---|
| 做 | 在 `tools.guard`（同步、执行前）检查 shell / 代码执行工具的命令字符串，命中破坏性删除就拒绝 |
| 做 | 拒绝消息里直接给出可逆删除的替代命令，让"下一步该敲什么"是明确的 |
| 做 | 每次拦截写一行审计日志（谁、什么工具、命中哪条规则、原命令） |
| 不做 | 不读脚本内容——`.cmd`/`.ps1`/`py x.py` 里面做了什么，它看不见 |
| 不做 | 不替代沙箱。它靠字符串匹配，只防"顺手"，防不住"刻意" |
| 不做 | 不跨 profile 生效：装在哪套 profile，就只管哪套 |

## 安装

前提：DSH 客户端 + 允许运行 `plugin_manager`（需要完全访问权限）。

```bash
plugin_manager install_bundle target <这个仓库的绝对路径>
```

装完立即生效（`application: applied`），不用重启。之后改 `index.js` 想即时生效：
`set_bundle enabled:false` → `enabled:true`，会重新加载模块。

卸载：

```bash
plugin_manager remove_bundle @local/safe-delete-guard
```

> 卸载后没有任何拦截——第三层会退回到"只能靠自觉"。

## 配置

写在 `cordis.patch.yml` 的 `config` 里（不改代码）：

```yaml
- insert:
    - id: safe-delete-guard
      name: '@local/safe-delete-guard'
      config:
        reversibleCommand: 'py.cmd dsh-tools\safe-delete.py'   # 拒绝消息里推荐的可逆命令
        allowScriptDirs:                                        # 额外允许运行脚本的目录（绝对路径）
          - 'D:\work\scripts'
        blockFlatDeletes: true                                  # false = 只拦递归/整盘，单点删除放行
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `reversibleCommand` | `py.cmd dsh-tools\safe-delete.py` | 拒绝消息里的替代命令前缀；换成你自己的可逆删除工具 |
| `allowScriptDirs` | `[]` | 额外允许"直接运行"的脚本目录（绝对路径） |
| `blockFlatDeletes` | `true` | 是否也拦单点删除（`del`、`Remove-Item`、`rm`） |

## 拦截清单

**递归 / 整盘**
`rd /s`、`rmdir /s`、`del /s`、`Remove-Item -Recurse`、`rm -r` / `rm -rf`、`format X:`、`diskpart`、
`Clear-RecycleBin`、`cipher /w`、`sdelete`、`shred`、`mkfs`、`shutil.rmtree`、`fs.rmSync` / `rmdirSync`、`robocopy /MIR`

**单点永久删除**（`blockFlatDeletes` 可关）
`del`、`erase`、`Remove-Item`、`rm`、`unlink`、`os.remove`、`git clean -f`

**命令包装**
`cmd /c`、`cmd.exe /c` 一律拒——外面套一层，里面是什么看不见。

**脚本文件**
`.cmd` / `.bat` / `.ps1` 只允许运行"工具目录"里的：路径里含 `dsh-tools\`、`dsh-plugins\`、
`.dsh\skills\`、`.dsh\workflows\`、`.dsh\plugins\`、`.dsh\bin\` 的放行；已知包装器（`py.cmd`、`boot.cmd` 等）按裸名放行；
其余要求先 `read` 内容再跑。只检查"命令位"（每条命令的首 token，或 `start`/`call`/`-File` 之后那个），
所以 `Set-Content x.ps1` 这类写文件不会被误判。

## 放行方式

- 命令里出现 `safe-delete.py`（可逆通道本身）
- 命令带 `-WhatIf`（PowerShell 只看不删）

## 审计

`%LOCALAPPDATA%\dsh-safe-delete\guard.jsonl`（写不进去时退到 `%TEMP%\dsh-safe-delete\`），一行一条：

```json
{"at":"2026-10-29T04:07:37.681Z","tool":"pwsh","agent":"session-…","rule":"rd /s（递归删目录）","command":"cmd /c rd /s /q E:\\tmp\\x"}
```

排查"为什么这条命令被拦"时先看它；想知道"最近有没有人想删东西"，也看它。

## 配套工具：safe-delete.py

`tools/safe-delete.py` 是一个可逆删除实现（Python 3，无第三方依赖），插件拒绝消息里推荐的就是它：

```bash
python tools/safe-delete.py <路径>              # 回收进同盘隔离区（默认）
python tools/safe-delete.py <路径> --dry-run    # 只看会删什么
python tools/safe-delete.py --list              # 隔离区里有什么
python tools/safe-delete.py --restore <id>      # 原样还原
python tools/safe-delete.py --purge <id> --yes  # 永久删除（不可逆）
python tools/safe-delete.py --show-cfg          # 看白名单与保护清单
```

要点：

- **默认不是系统回收站**：系统回收站超配额时会被 Windows **静默变成永久删除**。隔离区是纯改名，
  秒级、不占额外空间、还原是原子操作。要系统回收站加 `--to bin`（超大文件会被拦下提醒）。
- 隔离区优先 `<盘符>:\.dsh-trash\<时间戳>\`；盘根不可写时（例如沙箱是 workspace-write）退到
  `<工作区>\_回收站\`——必须同卷，跨卷改名就不原子了。
- **目录是可见的**：`D:\.dsh-trash` 就是个普通文件夹，不设隐藏属性，资源管理器地址栏粘路径就能进。
- **保留期默认 7 天**：每次回收前顺手清一次，超过保留期的自动永久删除（`--retention-days 0` 关掉，
  或环境变量 `SAFE_DELETE_RETENTION_DAYS`）；`--purge-older-than` 仍可手动按天数清。
- **目录可自定义**：`--trash-dir <目录>` 或 `SAFE_DELETE_TRASH`，**必须与目标同卷**——跨卷改名不是原子的，
  不同卷的目录会被忽略并回落到盘根默认位置。
- 允许删除的根默认是"临时目录 + 工作区（调用时的当前目录）"，可用 `--allow <dir>` 或环境变量
  `SAFE_DELETE_ALLOW`（分号分隔）扩展；工作区可用 `SAFE_DELETE_HOME` 指定。
- 保护清单：系统目录、盘根、用户目录根、`$DSH_HOME`、DSH 安装目录，以及工作区里的
  `dsh-tools` / `文档` / `Memory` / `知识库`（这些不存在时自动跳过）。目标是它们的**祖先**也拒。
- `--list` / `--restore` 会在全局索引不可用时扫描回收目录里的 `manifest.json` 兜底。
- **配置文件**：`%LOCALAPPDATA%\dsh-safe-delete\config.json`，界面里的设置写在这里，工具也读它
  （优先级：命令行参数 > 环境变量 > 配置文件 > 默认）。键：`trash`（自定义隔离区）、`retentionDays`、
  `lowFreeGb`、`lowPercent`。
- **禁止往 C 盘写**：C 盘不出现在下拉选项里，配置接口会拒绝 `c:` 开头的路径，
  工具里也会忽略 C 盘的隔离区设置（回落到盘根默认）。

## 回收站面板（Web UI）

插件装好后，Harness 右上角会有一个**圆形悬浮球**（可拖动，位置记忆在 localStorage）：

- **悬停** → 一行摘要「共 N 个文件 · X MB」
- **点击** → 屏幕正中弹出窗口，可拖动

窗口内容：

| 区域 | 说明 |
|---|---|
| 标题行 | 回收站 · 刷新 · 总量 · ×（关闭） |
| 左栏（宽） | **一级目录 = 会话**，按会话目录建立时间排序；每条显示文件数、轮次、最近时间、**红色倒计时**「预计 N 日后自动删除」 |
| 右栏（窄） | **二级目录 = 选中会话的各轮次**，同样带文件数/大小/倒计时 |
| 每行末尾 | 「删除」胶囊按钮 → 弹窗二次确认（永久删除，不进回收站） |
| 底部左 | ⚙ 设置 |
| 底部右 | 前往回收站 / 清空回收站（两段确认） |

设置页可以改：**回收站位置**（下拉，只列存在的盘符，C 盘除外）、**自动删除天数**、以及一段功能说明。
换位置保存时会提示「检测到回收站位置变更，将迁移所有文件」，确认后**逐批迁移并实时显示进度**
（已迁移 N / M 项 + 进度条）。

**磁盘保护**：插件会读隔离区所在卷的剩余空间。低于阈值（默认剩余 < 1GB 或 < 5%）时：

- 悬浮球变红，悬停常驻提示「磁盘空间不足，回收站将清空」（移开鼠标后改为每 60 秒提示一次）
- 这时候再删除文件，**工具会按放入时间从最旧的回收记录开始永久删除**，先腾出空间再放新的


## 注意事项

1. **会有误报**。字符串匹配天生如此：`echo "del /s"` 也会被拦，**连提交信息里写 `cmd /c` 都会**（
   它只看整条命令的字符串）。拒绝消息里写了怎么绕（`-WhatIf` 或走工具）。
2. **别把它当唯一防线**。它防"顺手"，不防"刻意"。真正的结构性防线是沙箱（DSH 的
   `workspace-write` 模式）——那个不靠匹配，错了也拦得住。
3. **脚本内容它管不了**。`py x.py`、`node x.js`、`bash x.sh` 在它看来只是"跑了个脚本"。
   要更严就得在 `subprocess` 层做，代价是误杀面从"一条命令"扩大到"整台机器起的进程"，不建议。
4. **升级可能失效**。它依赖 Host 的 `ctx.tools.guard` 与其参数形状；DSH 大版本改动后请重新验证
   （造个测试目录试一条 `Remove-Item -Recurse`）。
5. **只覆盖装了它的 profile**。桌面端和 web 端是两套 profile，要分别装。
6. **Linux/macOS 未验证**。路径判定按 Windows 写的（盘符、反斜杠）；bash 工具名虽在列表里，别指望开箱即用。
7. **审计日志会一直长**。没有轮转，长期使用记得自己清理或加到定时任务里。

## 自测

```bash
mkdir /tmp/safe-delete-demo && echo hi > /tmp/safe-delete-demo/a.txt
# Windows: mkdir C:\tmp\demo && echo hi > C:\tmp\demo\a.txt

# 应该被拦（两条都应该）
Remove-Item -Recurse -Force C:\tmp\demo
cmd /c rd /s /q C:\tmp\demo

# 应该放行
Remove-Item -Recurse -Force C:\tmp\demo -WhatIf
```

## English

A DSH (DeepSeek Harness) Host plugin that denies destructive delete commands *before* they run and points
the model at a reversible delete tool. It hooks `ctx.tools.guard` (synchronous, global) and inspects the
command string of shell / code tools: `rd /s`, `del /s`, `Remove-Item -Recurse`, `rm -rf`, `format`,
`shutil.rmtree`, `fs.rmSync`, `robocopy /MIR`, any `cmd /c` wrapper, and running `.cmd`/`.bat`/`.ps1`
files outside tool directories. `safe-delete.py` and `-WhatIf` pass through.

It matches strings only: it catches slips, not deliberate obfuscation. Pair it with a real sandbox
(DSH's `workspace-write`) — that one holds regardless of what a model writes.

## License

MIT. 见 [LICENSE](LICENSE)。
