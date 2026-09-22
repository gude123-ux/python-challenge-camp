# -*- coding: utf-8 -*-
"""
make-desktop-launcher.py —— 在桌面生成「Python闯关训练营.cmd」启动器

为什么要用脚本生成而不是手写这个文件：
  1. 批处理必须用 CRLF 换行（LF-only 会让 goto :label 和多行 if 块失效）；
  2. 批处理必须纯 ASCII —— 中文版 Windows 的 cmd 默认代码页是 936(GBK)，
     写进去的中文会乱码。所以中文提示全部由 scripts/launch.js 输出；
  3. 路径里的反斜杠必须原样保留，不能经过任何会做转义/转换的环节。

用法：
    python scripts/make-desktop-launcher.py              # 写到当前用户桌面
    python scripts/make-desktop-launcher.py --dir D:\\    # 写到指定目录
    python scripts/make-desktop-launcher.py --remove     # 删除桌面启动器

项目被移动后重新跑一次即可。
"""

import argparse
import os
import pathlib
import sys

BS = chr(92)  # 反斜杠，显式构造，避免任何转义环节把它吃掉

HERE = pathlib.Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent


def build_script(project_root: pathlib.Path) -> bytes:
    p = str(project_root).replace("/", BS)

    lines = [
        "@echo off",
        "rem ============================================================",
        "rem  Python Challenge Camp - desktop launcher",
        "rem",
        "rem  Double-click this file to build and start the extension.",
        "rem  It simply delegates to the project's own launch.cmd.",
        "rem",
        "rem  If you ever MOVE the project folder, re-run:",
        "rem      python scripts" + BS + "make-desktop-launcher.py",
        "rem  to regenerate this file.",
        "rem",
        "rem  This file is ASCII-only on purpose: cmd.exe on a Chinese",
        "rem  locale uses codepage 936, so any Chinese text here would be",
        "rem  garbled. All Chinese messages come from scripts" + BS + "launch.js.",
        "rem ============================================================",
        'set "PROJECT=' + p + '"',
        "",
        'if not exist "%PROJECT%' + BS + 'launch.cmd" goto missing',
        "",
        'call "%PROJECT%' + BS + 'launch.cmd" %*',
        "exit /b %ERRORLEVEL%",
        "",
        ":missing",
        "echo.",
        "echo   [ERROR] Project folder not found:",
        "echo   %PROJECT%",
        "echo.",
        "echo   The project was moved or deleted. Re-run",
        "echo   scripts" + BS + "make-desktop-launcher.py inside the project,",
        "echo   or edit the PROJECT path at the top of this file.",
        "echo.",
        "pause",
        "exit /b 1",
        "",
    ]
    return ("\r\n".join(lines) + "\r\n").encode("ascii")


def desktop_dir() -> pathlib.Path:
    for name in ("Desktop", "桌面"):
        d = pathlib.Path.home() / name
        if d.is_dir():
            return d
    return pathlib.Path.home() / "Desktop"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=None, help="输出目录（默认当前用户桌面）")
    ap.add_argument("--name", default="Python闯关训练营.cmd", help="文件名")
    ap.add_argument("--remove", action="store_true", help="删除启动器")
    args = ap.parse_args()

    target_dir = pathlib.Path(args.dir) if args.dir else desktop_dir()
    out = target_dir / args.name

    if args.remove:
        if out.exists():
            out.unlink()
            print(f"已删除：{out}")
        else:
            print(f"不存在，无需删除：{out}")
        return 0

    if not target_dir.is_dir():
        print(f"[错误] 目录不存在：{target_dir}", file=sys.stderr)
        return 1

    data = build_script(PROJECT_ROOT)
    out.write_bytes(data)

    raw = out.read_bytes()
    checks = {
        "CRLF": raw.count(b"\r\n"),
        "裸 LF": raw.count(b"\n") - raw.count(b"\r\n"),
        "有 BOM": raw[:3] == b"\xef\xbb\xbf",
        "纯 ASCII": all(b < 128 for b in raw),
    }
    print(f"已生成：{out}")
    print(f"  指向项目：{PROJECT_ROOT}")
    print(f"  大小 {len(raw)} 字节 | CRLF {checks['CRLF']} 行 | 裸 LF {checks['裸 LF']} 行")
    print(f"  BOM：{checks['有 BOM']} | 纯 ASCII：{checks['纯 ASCII']}")
    if checks["裸 LF"] or checks["有 BOM"] or not checks["纯 ASCII"]:
        print("[错误] 生成结果未通过自检", file=sys.stderr)
        return 1
    print("双击即可启动。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
