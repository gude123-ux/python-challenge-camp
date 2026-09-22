/**
 * runner.ts —— 本地 Python 运行与报错捕获
 *
 * 这一层负责回答「代码能不能跑、报什么错」——由本地解释器给出客观答案，
 * 而不是让模型去猜。运行结果会随代码一起交给 AI 批改。
 *
 * 隐私边界：只运行/读取学生当前打开的那一个文件，不扫描工作区。
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import type { RunResult } from './types';
import { tmpDir } from '../util/paths';

const MAX_OUTPUT = 8000;

export interface RunOptions {
  pythonPath: string;
  timeoutSec: number;
  cwd?: string;
}

/** 从 traceback 里认出最常见的错误类型，便于本地快速判分 */
function classify(stderr: string): string | undefined {
  const kinds = [
    'IndentationError',
    'SyntaxError',
    'ModuleNotFoundError',
    'ImportError',
    'NameError',
    'TypeError',
    'ValueError',
    'KeyError',
    'IndexError',
    'AttributeError',
    'ZeroDivisionError',
    'FileNotFoundError',
    'RecursionError',
    'UnboundLocalError',
    'StopIteration',
  ];
  for (const k of kinds) {
    if (new RegExp(`\\b${k}\\b`).test(stderr)) {
      return k;
    }
  }
  return undefined;
}

function clip(s: string): string {
  if (s.length <= MAX_OUTPUT) {
    return s;
  }
  return `${s.slice(0, MAX_OUTPUT)}\n...（输出过长，已截断）`;
}

/** 解析 pythonPath 配置，支持带参数的写法（如 "py -3"） */
function splitPython(pythonPath: string): { cmd: string; args: string[] } {
  const trimmed = (pythonPath || 'python').trim();
  const parts = trimmed.split(/\s+/);
  return { cmd: parts[0], args: parts.slice(1) };
}

function execPython(
  fileToRun: string,
  opts: RunOptions
): Promise<RunResult> {
  const { cmd, args } = splitPython(opts.pythonPath);
  const started = Date.now();

  return new Promise<RunResult>((resolve) => {
    let child;
    try {
      child = spawn(cmd, [...args, '-X', 'utf8', fileToRun], {
        cwd: opts.cwd,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          // 让学生脚本的 import 找得到同目录的模块
          PYTHONPATH: [opts.cwd ?? '', process.env.PYTHONPATH ?? ''].filter(Boolean).join(path.delimiter),
        },
        windowsHide: true,
      });
    } catch (err: any) {
      resolve({
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: String(err?.message ?? err),
        timedOut: false,
        durationMs: Date.now() - started,
        pythonPath: opts.pythonPath,
        noInterpreter: true,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, Math.max(3, opts.timeoutSec) * 1000);

    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT * 2) {
        stdout += d.toString('utf8');
      }
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT * 2) {
        stderr += d.toString('utf8');
      }
    });

    const finish = (code: number | null, noInterpreter = false) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const err = clip(stderr);
      resolve({
        ok: code === 0 && !timedOut,
        exitCode: code,
        stdout: clip(stdout),
        stderr: timedOut ? `${err}\n[超时] 运行超过 ${opts.timeoutSec} 秒，已强制结束。`.trim() : err,
        timedOut,
        durationMs: Date.now() - started,
        pythonPath: opts.pythonPath,
        errorKind: timedOut ? 'Timeout' : classify(err),
        noInterpreter,
      });
    };

    child.on('error', (err: NodeJS.ErrnoException) => {
      const missing = err.code === 'ENOENT';
      stderr += missing
        ? `找不到 Python 解释器：${cmd}\n请在设置 pythonCamp.pythonPath 里填写完整路径（例如 C:\\Python312\\python.exe）。`
        : String(err.message);
      finish(null, missing);
    });

    child.on('close', (code) => finish(code));
  });
}

/** 运行工作区里的某个 .py 文件（学生真实文件，相对路径行为与手敲 python xx.py 一致） */
export async function runFile(filePath: string, opts: RunOptions): Promise<RunResult> {
  const cwd = opts.cwd ?? path.dirname(filePath);
  return execPython(filePath, { ...opts, cwd });
}

/** 运行一段代码片段（写入临时目录后执行，用于无法定位文件时的兜底） */
export async function runSnippet(
  code: string,
  context: vscode.ExtensionContext,
  opts: RunOptions
): Promise<RunResult> {
  const dir = tmpDir(context);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `snippet_${Date.now()}.py`);
  await fs.writeFile(file, code, 'utf8');
  try {
    return await execPython(file, { ...opts, cwd: opts.cwd ?? dir });
  } finally {
    // 临时文件不留在工作区里
    fs.unlink(file).catch(() => undefined);
  }
}

/** 只做语法检查，不执行代码（无副作用） */
export async function checkSyntax(
  code: string,
  context: vscode.ExtensionContext,
  opts: RunOptions
): Promise<{ ok: boolean; message: string }> {
  const dir = tmpDir(context);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `syntax_${Date.now()}.py`);
  await fs.writeFile(file, code, 'utf8');
  const { cmd, args } = splitPython(opts.pythonPath);
  return new Promise((resolve) => {
    const child = spawn(
      cmd,
      [...args, '-c', 'import ast,sys;ast.parse(open(sys.argv[1],encoding="utf-8").read())', file],
      { env: { ...process.env, PYTHONUTF8: '1' }, windowsHide: true }
    );
    let err = '';
    child.stderr?.on('data', (d: Buffer) => {
      err += d.toString('utf8');
    });
    child.on('error', () => {
      fs.unlink(file).catch(() => undefined);
      resolve({ ok: false, message: '无法调用 Python 解释器' });
    });
    child.on('close', (code) => {
      fs.unlink(file).catch(() => undefined);
      resolve({ ok: code === 0, message: code === 0 ? '语法正确' : clip(err) });
    });
  });
}
