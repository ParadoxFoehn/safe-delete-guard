# -*- coding: utf-8 -*-
r"""
safe-delete.py -- 可逆删除。默认把目标"回收"进同盘私有隔离区，不直接抹掉。

为什么要有它（2026-10-29 定）
    起因：群友的 DSH 用 `cmd /c rd /s /q` 清 __pycache__，引号转义把参数塌成 D:\\，
    递归删掉整个 D 盘。`rd /s /q` 不进回收站，SSD 又立即 TRIM，数据没能恢复。
    教训不在"AI 会不会犯错"，而在"犯错时删掉的东西能不能拿回来"。
    所以这里把三件事做成默认：
      1) 删除 = 移动到同盘 <盘符>:\\.dsh-trash\\<时间戳>\\<名字>  —— 只是改名，秒级、必定可还原
      2) 系统目录 / 盘根 / 工具与规则目录 一律拒删（连"删它的祖先"也拒）
      3) 每次删除留 manifest + 审计索引；--restore 还原，--purge 才真删（要 --yes）

用法
    py.cmd dsh-tools\\safe-delete.py <路径> [<路径>...]           # 回收（默认）
    py.cmd dsh-tools\\safe-delete.py <路径> --dry-run             # 只看会删什么
    py.cmd dsh-tools\\safe-delete.py <路径> --to bin              # 走系统回收站
    py.cmd dsh-tools\\safe-delete.py --list                       # 看隔离区里有什么
    py.cmd dsh-tools\\safe-delete.py --restore <id>               # 还原
    py.cmd dsh-tools\\safe-delete.py --purge <id> --yes            # 永久删除（不可逆）
    py.cmd dsh-tools\\safe-delete.py --purge-older-than 7 --yes
    py.cmd dsh-tools\\safe-delete.py --show-cfg                   # 看保护清单与白名单
    ... --json                                                     # 机器可读（一次一条 JSON）
    ... --allow-outside                                            # 明确允许删白名单之外的路径

为什么默认不是系统回收站
    系统回收站有配额的。超出配额的删除会被 Windows **静默变成永久删除**，不提示、不进回收站。
    隔离区是纯改名：不占额外空间、不受配额影响、还原是原子操作。
    要系统回收站显式加 --to bin（大文件会先被拦下，提醒你改走隔离区）。

    隔离区位置：优先 <盘符>:\.dsh-trash\；盘根不可写时（sandbox=workspace-write 实测就是这样）
    退到同卷的 D:\Harness工作区\_回收站\。两种位置 --list / --restore 都认。

退出码：0 成功；2 被保护规则拒绝 / 参数错误；3 执行失败
"""
import argparse
import ctypes
import datetime
import json
import os
import sys
import time

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

WORKSPACE = os.path.abspath(os.environ.get("SAFE_DELETE_HOME") or os.getcwd())
TEMP = os.path.abspath(os.environ.get("TEMP") or r"C:\Windows\Temp")
TRASH_DIRNAME = ".dsh-trash"
WORKSPACE_TRASH = os.path.join(WORKSPACE, "_回收站")
EXTRA_ROOTS = [p.strip() for p in (os.environ.get("SAFE_DELETE_ALLOW") or "").split(";") if p.strip()]
# 隔离区目录：默认每个盘根下 <X>:\.dsh-trash，可用环境变量 SAFE_DELETE_TRASH 或 --trash-dir 指定
TRASH_OVERRIDE = (os.environ.get("SAFE_DELETE_TRASH") or "").strip() or None
# 自动清理：隔离区里的东西放满这么多天就永久删除；0 = 不自动清
try:
    RETENTION_DAYS = float(os.environ.get("SAFE_DELETE_RETENTION_DAYS") or 7)
except ValueError:
    RETENTION_DAYS = 7.0
DSH_HOME = os.environ.get("DSH_HOME") or os.path.join(
    os.environ.get("USERPROFILE", r"C:\Users\Default"), ".dsh")
DSH_ROOT = os.environ.get("DSH_ROOT") or r"D:\Software\DeepSeekHarness"
STATE_DIR = os.path.join(os.environ.get("LOCALAPPDATA") or TEMP, "dsh-safe-delete")
INDEX = os.path.join(STATE_DIR, "index.jsonl")

WARN_FILES = 500
WARN_BYTES = 1024 ** 3
BIN_MAX_BYTES = 2 * 1024 ** 3

FILE_ATTRIBUTE_REPARSE_POINT = 0x400


class Refuse(Exception):
    def __init__(self, code, message, hint=""):
        Exception.__init__(self, message)
        self.code = code
        self.message = message
        self.hint = hint


def _long(p):
    """把 8.3 短名（如 技术部~1）展开成长名，否则路径比较会假不匹配。"""
    try:
        buf = ctypes.create_unicode_buffer(32768)
        n = ctypes.windll.kernel32.GetLongPathNameW(ctypes.c_wchar_p(p), buf, 32768)
        if n:
            return buf.value
    except Exception:
        pass
    return p


def _nc(p):
    """规范成可比较的绝对路径：abspath 会把 .. 抹平，normcase 统一大小写。"""
    p = _long(os.path.abspath(p))
    p = os.path.normcase(p)
    if len(p) > 3 and p.endswith("\\"):
        p = p.rstrip("\\")
    return p


def _under(child, parent):
    c, p = _nc(child), _nc(parent)
    if c == p:
        return True
    if not p.endswith("\\"):
        p += "\\"
    return c.startswith(p)


def _drive_root(path):
    return os.path.splitdrive(os.path.abspath(path))[0] + "\\"


def _protected():
    """(不可删前缀, 不可删祖先) 两组：前者＝目标落在里面就拒；后者＝目标是它的父目录也拒。

    只收**真实存在**的路径——不存在的路径按字符串算祖先会误伤
    （比如把 D:\\projects 当成 D:\\projects\\文档 的祖先）。
    """
    up = os.environ.get("USERPROFILE", "")
    local = os.environ.get("LOCALAPPDATA", "")
    roaming = os.environ.get("APPDATA", "")
    under = [
        r"C:\Windows",
        r"C:\Program Files",
        r"C:\Program Files (x86)",
        r"C:\ProgramData",
        r"C:\System Volume Information",
        r"C:\Recovery",
        r"C:\Boot",
        r"C:\$Recycle.Bin",
        r"C:\PerfLogs",
        DSH_ROOT,
        DSH_HOME,
        os.path.join(WORKSPACE, "dsh-tools"),
        os.path.join(WORKSPACE, "文档"),
        os.path.join(WORKSPACE, "Memory"),
        os.path.join(WORKSPACE, "知识库"),
        WORKSPACE_TRASH,
    ]
    ancestor = list(under) + [
        WORKSPACE,
        os.path.join(WORKSPACE, "会话"),
        TEMP,
        "C:\\", "D:\\", "E:\\", "F:\\", "G:\\",
        os.environ.get("SystemDrive", "C:") + "\\",
    ]
    if up:
        ancestor += [up, os.path.join(up, "Desktop"), os.path.join(up, "Documents"),
                     os.path.join(up, "Downloads")]
    if local:
        ancestor.append(local)
    if roaming:
        ancestor.append(roaming)
    seen, uniq_under, uniq_anc = set(), [], []
    for p in under:
        k = _nc(p)
        if k in seen or not os.path.exists(p):
            continue
        seen.add(k)
        uniq_under.append(p)
    seen2 = set()
    for p in ancestor:
        k = _nc(p)
        if k in seen2 or not os.path.exists(p):
            continue
        seen2.add(k)
        uniq_anc.append(p)
    return uniq_under, uniq_anc


def _allow_roots(extra=None):
    """允许删除的根：临时目录 + 工作区（默认 = 调用时的当前目录）+ 环境/参数的额外目录。"""
    roots = [TEMP, WORKSPACE] + EXTRA_ROOTS + list(extra or [])
    return [os.path.abspath(r) for r in roots if r]


def _trash_candidates(path, override=None):
    """隔离区候选，按优先级：

    1. 显式指定的目录（--trash-dir / SAFE_DELETE_TRASH）——必须与目标同卷
    2. 盘根 <X>:\\.dsh-trash
    3. 同卷的工作区 _回收站（盘根写不进去时兜底，比如 sandbox=workspace-write）

    同卷是硬要求：跨卷 rename 不是原子的。
    """
    out = []
    vol = os.path.splitdrive(os.path.abspath(path))[0].lower()
    for cand in (override, TRASH_OVERRIDE):
        if not cand:
            continue
        c = os.path.abspath(cand)
        if os.path.splitdrive(c)[0].lower() == vol:
            out.append(c)
    out.append(os.path.join(_drive_root(path), TRASH_DIRNAME))
    if vol == os.path.splitdrive(WORKSPACE)[0].lower():
        out.append(WORKSPACE_TRASH)
    return out


def _trash_root(path):
    return _trash_candidates(path)[0]


def _all_trash_roots(extra=()):
    """静态隔离区根：不读索引（否则和 _read_index 互相递归）。
    索引里记录的额外根（自定义 --trash-dir 建的）由调用方作为 extra 传进来。"""
    roots = {WORKSPACE_TRASH}
    for letter in "CDEFGHIJKLMNOPQRSTUVWXYZ":
        roots.add(letter + ":\\.dsh-trash")
    if TRASH_OVERRIDE:
        roots.add(os.path.abspath(TRASH_OVERRIDE))
    for r in extra:
        if r:
            roots.add(os.path.abspath(r))
    return roots


def _auto_purge(days, verbose=True):
    """隔离区里超过保留期的东西永久删除。返回删掉的 id 列表。"""
    if days is None or days <= 0:
        return []
    cutoff = time.time() - float(days) * 86400
    removed = []
    for rec in _read_index():
        entry = rec.get("entry_dir") or ""
        if not entry or not os.path.isdir(entry):
            continue
        try:
            ts = datetime.datetime.fromisoformat(rec["created"]).timestamp()
        except Exception:
            continue
        if ts >= cutoff:
            continue
        try:
            _rimraf(entry, [rec.get("root")])
            removed.append(rec["id"])
        except Exception as e:
            if verbose:
                sys.stderr.write("[warn] 自动清理失败 %s：%s\n" % (rec["id"], e))
    if removed and verbose:
        sys.stderr.write("[清理] 隔离区超过 %.0f 天，已永久删除 %d 项\n" % (days, len(removed)))
    return removed


def _in_trash(p, extra=()):
    return any(_under(p, r) for r in _all_trash_roots(extra))


def _is_reparse(path):
    try:
        st = os.lstat(path)
    except OSError:
        return False
    return bool(getattr(st, "st_file_attributes", 0) & FILE_ATTRIBUTE_REPARSE_POINT)


def _measure(path):
    """返回 (kind, 文件数, 字节数)。不跟随 symlink / junction。"""
    if os.path.islink(path) or _is_reparse(path):
        return "link", 1, 0
    if os.path.isfile(path):
        try:
            return "file", 1, os.path.getsize(path)
        except OSError:
            return "file", 1, 0
    if not os.path.isdir(path):
        return "other", 0, 0
    files, size = 0, 0
    stack = [path]
    while stack:
        cur = stack.pop()
        try:
            with os.scandir(cur) as it:
                for e in it:
                    try:
                        if e.is_dir(follow_symlinks=False):
                            if e.is_symlink():
                                files += 1
                            else:
                                stack.append(e.path)
                        else:
                            files += 1
                            size += e.stat(follow_symlinks=False).st_size
                    except OSError:
                        files += 1
        except OSError:
            pass
    return "dir", files, size


def _check(path, args):
    """通过就返回 (kind, files, bytes)；不合规抛 Refuse。"""
    ap = os.path.abspath(path)
    if not os.path.exists(ap):
        raise Refuse("not_found", "不存在：%s" % ap, "拼错路径了？换一个再试。")
    if len(_nc(ap)) <= 3:
        raise Refuse("drive_root", "拒绝删除盘符根目录：%s" % ap, "盘根一律不动。")
    under, ancestor = _protected()
    if not _under(ap, TEMP):
        for p in under:
            if _under(ap, p):
                raise Refuse("protected", "拒绝删除受保护目录：%s" % p,
                             "系统目录 / 工具目录 / 规则目录一律不可删；要清理请指明它下面的具体子项。")
    for p in ancestor:
        if _nc(p) == _nc(ap):
            raise Refuse("protected_self", "这是受保护的根目录本身，不能删：%s" % p,
                         "要清理就指向它下面的具体子项。")
        if _under(p, ap):
            raise Refuse("ancestor", "拒绝删除包含受保护路径的目录：%s" % p,
                         "这个目标把 %s 套在里面了，先缩小范围。" % p)
    if _in_trash(ap, [getattr(args, "trash_dir", None)]):
        raise Refuse("in_trash", "目标已在隔离区里：%s" % ap,
                     "永久删除用 --purge <id> --yes。")
    if _is_reparse(ap):
        raise Refuse("reparse", "目标是 symlink / junction，不跟着走：%s" % ap,
                     "要删链接本身请先手工 os.unlink，或明确告诉我你指的是链接还是目标。")
    allowed = _allow_roots(getattr(args, "allow", None))
    if not any(_under(ap, r) for r in allowed):
        if not args.allow_outside:
            raise Refuse("outside", "不在允许删除的根目录内：%s" % ap,
                         "白名单：%s。确实要删加 --allow-outside。"
                         % " ; ".join(allowed))
    return _measure(ap)


def _unhide(path):
    """隔离区要看得见：清掉隐藏属性（老版本建的目录会带）。"""
    try:
        k32 = ctypes.windll.kernel32
        attr = k32.GetFileAttributesW(ctypes.c_wchar_p(path))
        if attr == 0xFFFFFFFF or not (attr & 0x2):
            return
        k32.SetFileAttributesW(ctypes.c_wchar_p(path), attr & ~0x2)
    except Exception:
        pass


def _now_id():
    return time.strftime("%Y%m%d-%H%M%S") + "-" + ("%04x" % (os.getpid() & 0xFFFF))


def _iso(path, kind, files, size):
    return {"orig": path, "kind": kind, "files": files, "bytes": size}


def _do_trash(items, args):
    entry_id = _now_id()
    first = items[0]["orig"]
    for it in items[1:]:
        if _nc(_drive_root(it["orig"])) != _nc(_drive_root(first)):
            raise Refuse("cross_drive", "一次只能处理同一个盘上的目标：%s 与 %s 不同盘。"
                         % (first, it["orig"]),
                         "分两次跑；跨盘改名不是原子的，这里不做。")
    root = None
    for cand in _trash_candidates(first, getattr(args, "trash_dir", None)):
        try:
            os.makedirs(os.path.join(cand, entry_id), exist_ok=False)
            root = cand
            break
        except FileExistsError:
            continue
        except OSError:
            continue
    if not root:
        raise Refuse("trash_unwritable",
                     "隔离区建不出来（盘根和工作区都不可写）：%s" % first,
                     "检查 sandbox 策略；别改成直接删，先告诉我。")
    entry_dir = os.path.join(root, entry_id)
    _unhide(root)
    moved = []
    for it in items:
        src = it["orig"]
        base = os.path.basename(src.rstrip("\\")) or "item"
        dest = os.path.join(entry_dir, base)
        n = 1
        while os.path.exists(dest):
            n += 1
            dest = os.path.join(entry_dir, "%s (%d)" % (base, n))
        try:
            os.rename(src, dest)
        except OSError as e:
            raise Refuse("move_failed", "移动到隔离区失败：%s -> %s（%s）" % (src, dest, e),
                         "同盘改名失败通常是权限或被占用；先别重试，告诉我具体路径。")
        moved.append(dict(it, dest=dest))
    manifest = {
        "id": entry_id,
        "created": datetime.datetime.now().isoformat(timespec="seconds"),
        "tool": "safe-delete.py",
        "mode": "trash",
        "root": root,
        "cwd": os.getcwd(),
        "items": moved,
    }
    with open(os.path.join(entry_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    _append_index(manifest)
    return entry_id, root, moved


def _do_bin(items):
    if sys.platform != "win32":
        raise Refuse("os", "系统回收站模式只在 Windows 可用。")
    user32 = ctypes.windll.shell32

    class SHFILEOPSTRUCTW(ctypes.Structure):
        _fields_ = [
            ("hwnd", ctypes.c_void_p),
            ("wFunc", ctypes.c_uint),
            ("pFrom", ctypes.c_wchar_p),
            ("pTo", ctypes.c_wchar_p),
            ("fFlags", ctypes.c_ushort),
            ("fAnyOperationsAborted", ctypes.c_int),
            ("hNameMappings", ctypes.c_void_p),
            ("lpszProgressTitle", ctypes.c_wchar_p),
        ]

    FO_DELETE = 3
    FOF_ALLOWUNDO = 0x40
    FOF_NOCONFIRMATION = 0x10
    FOF_SILENT = 0x4
    FOF_NOERRORUI = 0x400
    flags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI
    done = []
    for it in items:
        src = it["orig"]
        op = SHFILEOPSTRUCTW()
        op.wFunc = FO_DELETE
        op.pFrom = src + "\0\0"
        op.pTo = None
        op.fFlags = flags
        rc = user32.SHFileOperationW(ctypes.byref(op))
        if rc != 0:
            raise Refuse("bin_failed", "系统回收站拒绝：%s（SHFileOperation 返回 %d）" % (src, rc),
                         "该盘可能关闭了回收站；改用默认的隔离区模式（去掉 --to bin）。")
        done.append(it)
    return done


def _append_index(manifest):
    rec = {
        "id": manifest["id"],
        "created": manifest["created"],
        "mode": manifest["mode"],
        "root": manifest["root"],
        "entry_dir": os.path.join(manifest["root"], manifest["id"]),
        "items": [{"orig": i["orig"], "dest": i.get("dest"), "kind": i["kind"],
                   "files": i["files"], "bytes": i["bytes"]} for i in manifest["items"]],
        "cwd": manifest.get("cwd"),
    }
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(INDEX, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except OSError as e:
        # sandbox 是 workspace-write 时 %LOCALAPPDATA% 不可写；不算失败——
        # manifest.json 已经落在回收目录里，_read_index 会扫盘补上。
        sys.stderr.write("[note] 全局索引写不进去（%s）；manifest 在 %s，--list 会自动扫描回收目录。\n"
                         % (e, os.path.join(manifest["root"], manifest["id"])))


def _record_from_manifest(d):
    try:
        root = d["root"]
        return {
            "id": d["id"],
            "created": d["created"],
            "mode": d.get("mode", "trash"),
            "root": root,
            "entry_dir": os.path.join(root, d["id"]),
            "items": [{"orig": i["orig"], "dest": i.get("dest"), "kind": i.get("kind"),
                       "files": i.get("files", 0), "bytes": i.get("bytes", 0)} for i in d["items"]],
            "cwd": d.get("cwd"),
        }
    except Exception:
        return None


def _scan_manifests(extra_roots=()):
    """扫隔离区目录里的 manifest.json —— 索引丢了、或索引写不进去时也能 --list / --restore。"""
    recs = []
    for root in sorted(_all_trash_roots(extra_roots)):
        try:
            if not os.path.isdir(root):
                continue
            for name in os.listdir(root):
                mf = os.path.join(root, name, "manifest.json")
                if not os.path.exists(mf):
                    continue
                try:
                    with open(mf, encoding="utf-8") as f:
                        d = json.load(f)
                except Exception:
                    continue
                r = _record_from_manifest(d)
                if r:
                    recs.append(r)
        except OSError:
            continue
    return recs


def _read_index():
    recs, seen = [], set()
    if os.path.exists(INDEX):
        try:
            with open(INDEX, encoding="utf-8", errors="replace") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        d = json.loads(line)
                    except Exception:
                        continue
                    if d.get("id") not in seen:
                        seen.add(d.get("id"))
                        recs.append(d)
        except OSError:
            pass
    extra = [r.get("root") for r in recs if r.get("root")]
    for d in _scan_manifests(extra):
        if d["id"] not in seen:
            seen.add(d["id"])
            recs.append(d)
    return recs


def _rimraf(path, extra_roots=()):
    """永久删除：只在隔离区内部使用，不跟随 reparse point。"""
    p = os.path.abspath(path)
    if not _in_trash(p, extra_roots):
        raise Refuse("purge_scope", "拒绝永久删除隔离区之外的路径：%s" % p)
    _rimraf_raw(p)


def _rimraf_raw(p):
    if os.path.islink(p) or _is_reparse(p):
        os.unlink(p)
        return
    if os.path.isdir(p):
        for name in os.listdir(p):
            _rimraf_raw(os.path.join(p, name))
        os.rmdir(p)
    else:
        os.unlink(p)


def _human(n):
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return ("%d %s" % (n, unit)) if unit == "B" else ("%.1f %s" % (n, unit))
        n = float(n) / 1024.0
    return "%d B" % n


def _emit(obj, as_json):
    if as_json:
        print(json.dumps(obj, ensure_ascii=False))
        return
    if "ok" not in obj:
        return
    if not obj["ok"]:
        e = obj["error"]
        print("[拒绝] %s" % e["message"])
        if e.get("hint"):
            print("       %s" % e["hint"])
        return
    act = obj.get("action")
    if act == "trash":
        print("[回收] %s  %d 项 / %d 个文件 / %s" % (obj["id"], len(obj["items"]),
                                                  sum(i["files"] for i in obj["items"]),
                                                  _human(sum(i["bytes"] for i in obj["items"]))))
        for i in obj["items"]:
            print("   - %s  ->  %s" % (i["orig"], i["dest"]))
        print("[还原] py.cmd dsh-tools\\safe-delete.py --restore %s" % obj["id"])
    elif act == "dry_run":
        print("[预演] 会回收 %d 项 / %d 个文件 / %s" % (len(obj["items"]),
                                                 sum(i["files"] for i in obj["items"]),
                                                 _human(sum(i["bytes"] for i in obj["items"]))))
        for i in obj["items"]:
            print("   - %s  (%s, %d 个文件)" % (i["orig"], i["kind"], i["files"]))
    elif act == "bin":
        print("[回收站] %d 项已进系统回收站" % len(obj["items"]))
        for i in obj["items"]:
            print("   - %s" % i["orig"])
    elif act == "restore":
        print("[还原] %d 项" % len(obj["items"]))
        for i in obj["items"]:
            print("   - %s" % i["orig"])
    elif act == "purge":
        print("[永久删除] %s  %d 项" % (obj["id"], len(obj["items"])))
    elif act == "list":
        for r in obj["items"]:
            print("%s  %s  %s  %d 项  %s" % (r["id"], r["created"], r["mode"],
                                             len(r["items"]), r.get("sample", "")))


def _fail(code, message, hint, as_json):
    _emit({"ok": False, "error": {"code": code, "message": message, "hint": hint}}, as_json)
    raise SystemExit(2)


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("paths", nargs="*")
    ap.add_argument("--to", choices=["trash", "bin"], default="trash")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--yes", "-y", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--allow-outside", action="store_true")
    ap.add_argument("--allow", action="append", metavar="DIR",
                    help="额外允许删除的根目录（可重复）；也可用环境变量 SAFE_DELETE_ALLOW（分号分隔）")
    ap.add_argument("--max-files", type=int, default=WARN_FILES)
    ap.add_argument("--max-bytes", type=int, default=WARN_BYTES)
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--restore", metavar="ID")
    ap.add_argument("--purge", metavar="ID")
    ap.add_argument("--purge-older-than", type=float, metavar="DAYS")
    ap.add_argument("--trash-dir", metavar="DIR",
                    help="自定义隔离区目录（必须与目标同卷）；也可用环境变量 SAFE_DELETE_TRASH")
    ap.add_argument("--retention-days", type=float, metavar="DAYS",
                    help="回收后保留多少天自动永久删除，默认 7；0 = 不自动清"
                    "（也可用环境变量 SAFE_DELETE_RETENTION_DAYS）")
    ap.add_argument("--no-auto-purge", action="store_true",
                    help="本次不做过期清理（保留期设置不变）")
    ap.add_argument("--show-cfg", action="store_true")
    args = ap.parse_args()
    js = args.json

    if args.show_cfg:
        under, ancestor = _protected()
        print("允许删除的根：")
        for r in _allow_roots():
            print("  + %s" % _long(r))
        print("永远拒绝（落在下面的目标）：")
        for r in under:
            print("  - %s" % _long(r))
        print("永远拒绝（目标是它的祖先）：")
        for r in ancestor:
            print("  - %s" % _long(r))
        print("隔离区：%s" % (os.path.abspath(args.trash_dir) if args.trash_dir
                              else (TRASH_OVERRIDE and os.path.abspath(TRASH_OVERRIDE))
                              or "<盘符>:\\.dsh-trash"))
        print("        盘根不可写时退到 %s（同卷）" % WORKSPACE_TRASH)
        print("        目录默认可见（不设隐藏属性）")
        ret = args.retention_days if args.retention_days is not None else RETENTION_DAYS
        print("保留期：%s 天（回收后超过这个天数自动永久删除；0 = 不自动清）"
              % ("不自动清" if ret <= 0 else "%.0f" % ret))
        print("索引：%s" % INDEX)
        return 0

    if args.list:
        recs = _read_index()
        recs = [r for r in recs if os.path.isdir(r.get("entry_dir", ""))]
        recs.sort(key=lambda r: r["created"], reverse=True)
        out = {"ok": True, "action": "list",
               "items": [dict(r, sample="; ".join(os.path.basename(i["orig"]) for i in r["items"][:3]))
                         for r in recs]}
        _emit(out, js)
        if not js and not recs:
            print("隔离区是空的。")
        return 0

    if args.restore:
        recs = [r for r in _read_index() if r["id"] == args.restore]
        if not recs:
            _fail("no_such_id", "索引里没有这个 id：%s" % args.restore,
                  "先 --list 看有哪些。", js)
        rec = recs[-1]
        items = []
        for it in rec["items"]:
            dest = it.get("dest")
            orig = it["orig"]
            if not dest or not os.path.exists(dest):
                continue
            os.makedirs(os.path.dirname(orig) or ".", exist_ok=True)
            try:
                os.rename(dest, orig)
            except OSError as e:
                _fail("restore_failed", "还原失败：%s（%s）" % (orig, e),
                      "目标可能已被重新创建，先处理冲突再试。", js)
            items.append({"orig": orig})
        entry_dir = rec.get("entry_dir", "")
        if entry_dir and os.path.isdir(entry_dir):
            left = [n for n in os.listdir(entry_dir) if n != "manifest.json"]
            if not left:
                try:
                    os.remove(os.path.join(entry_dir, "manifest.json"))
                    os.rmdir(entry_dir)
                except OSError:
                    pass
        _emit({"ok": True, "action": "restore", "id": rec["id"], "items": items}, js)
        return 0

    if args.purge or args.purge_older_than is not None:
        if args.purge:
            recs = [r for r in _read_index() if r["id"] == args.purge]
        else:
            cutoff = time.time() - args.purge_older_than * 86400
            recs = []
            for r in _read_index():
                try:
                    ts = datetime.datetime.fromisoformat(r["created"]).timestamp()
                except Exception:
                    continue
                if ts < cutoff:
                    recs.append(r)
        recs = [r for r in recs if os.path.isdir(r.get("entry_dir", ""))]
        if not recs:
            _emit({"ok": True, "action": "purge", "id": "-", "items": []}, js)
            return 0
        if not args.yes:
            _fail("need_yes", "永久删除不可逆，需要 --yes：%s"
                  % ", ".join(r["id"] for r in recs), "先 --list 确认，再带 --yes 重跑。", js)
        total = {"id": ",".join(r["id"] for r in recs), "items": []}
        for r in recs:
            _rimraf(r["entry_dir"], [r.get("root")])
            total["items"].append({"orig": r["entry_dir"]})
        _emit({"ok": True, "action": "purge", "id": total["id"], "items": total["items"]}, js)
        return 0

    if not args.paths:
        _fail("no_path", "没有给路径。", "用法：py.cmd dsh-tools\\safe-delete.py <路径> [--dry-run]", js)

    plan, err = [], None
    for raw in args.paths:
        try:
            kind, files, size = _check(raw, args)
            plan.append(_iso(os.path.abspath(raw), kind, files, size))
        except Refuse as e:
            err = e
            break
    if err:
        _fail(err.code, err.message, err.hint, js)

    n_files = sum(i["files"] for i in plan)
    n_bytes = sum(i["bytes"] for i in plan)
    need_yes = n_files > args.max_files or n_bytes > args.max_bytes
    if args.to == "bin" and n_bytes > BIN_MAX_BYTES:
        _fail("bin_too_big", "目标 %s 超过系统回收站的安全阈值，可能被静默永久删除。"
              % _human(n_bytes), "改走默认隔离区（去掉 --to bin），它一定能还原。", js)

    if args.dry_run:
        _emit({"ok": True, "action": "dry_run", "items": plan}, js)
        return 0

    if need_yes and not args.yes:
        _fail("need_yes", "目标较大（%d 个文件 / %s），需要 --yes 确认。"
              % (n_files, _human(n_bytes)), "先加 --dry-run 看一眼，再带 --yes。", js)

    # 过期清理：每次真正回收之前顺手做一次，避免隔离区无限长。
    # --restore / --purge / --list 不触发（否则想还原一条 7 天前的会被先删掉）。
    ret = args.retention_days if args.retention_days is not None else RETENTION_DAYS
    if not args.no_auto_purge:
        removed = _auto_purge(ret, verbose=not js)
        if removed and js:
            sys.stderr.write("[清理] 已按 %.0f 天保留期永久删除 %d 项\n" % (ret, len(removed)))

    try:
        if args.to == "bin":
            done = _do_bin(plan)
            _emit({"ok": True, "action": "bin", "items": done}, js)
        else:
            entry_id, root, moved = _do_trash(plan, args)
            _emit({"ok": True, "action": "trash", "id": entry_id, "root": root,
                   "items": moved}, js)
    except Refuse as e:
        _fail(e.code, e.message, e.hint, js)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
