# -*- coding: utf-8 -*-
"""
CodeStudio バックエンド

- static/ 以下のフロントエンド (エディタ本体) を配信する
- GET  /api/languages : サーバーで実行できる言語の一覧と利用可否を返す
- WS   /ws/run        : ユーザーのコードを一時ディレクトリに書き出して実行し、
                        標準入出力を WebSocket で双方向ストリーミングする
"""
import json
import mimetypes
import os
import shutil
import signal
import subprocess
import tempfile
import threading

from flask import Flask, abort, jsonify, send_from_directory
from flask_sock import Sock

# Replit (Nix) には /etc/mime.types が無いことがあり、CSS が
# application/octet-stream で配信されてブラウザに拒否されるため明示する
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/html", ".html")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("application/json", ".json")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# 環境変数で上書きできる実行制限
MAX_RUN_SECONDS = int(os.environ.get("MAX_RUN_SECONDS", "120"))
MAX_COMPILE_SECONDS = int(os.environ.get("MAX_COMPILE_SECONDS", "60"))
MAX_OUTPUT_BYTES = int(os.environ.get("MAX_OUTPUT_BYTES", str(2 * 1024 * 1024)))
MAX_FILES = 300
MAX_TOTAL_BYTES = 8 * 1024 * 1024

# フロントエンドの場所を自動判別する。
# 通常は static/ 配下だが、Replit などにフラット (全ファイル直下) に
# アップロードした場合は main.py と同じ階層から配信する。
FRONT_DIR = os.path.join(BASE_DIR, "static")
if not os.path.isfile(os.path.join(FRONT_DIR, "index.html")):
    FRONT_DIR = BASE_DIR

app = Flask(__name__, static_folder=None)
sock = Sock(app)


def find_exe(candidates):
    """候補コマンド名のうち、PATH 上に存在する最初の実行ファイルを返す。"""
    for name in candidates:
        path = shutil.which(name)
        if path:
            return path
    return None


def _exe(name):
    return name + (".exe" if os.name == "nt" else "")


# 対応言語の定義。
#   need     : 必要なコマンドのグループ (各グループはどれか1つ見つかればよい)
#   commands : (見つかった実行ファイル, エントリの絶対パス, 作業ディレクトリ) から
#              実行するコマンド列を作る。最後の要素が本体の実行、それ以前はコンパイル。
LANGUAGES = {
    "python": {
        "label": "Python 3",
        "exts": [".py", ".pyw"],
        "need": [["python3", "python"]],
        "commands": lambda exe, src, work: [[exe[0], "-u", src]],
    },
    "javascript": {
        "label": "JavaScript (Node.js)",
        "exts": [".js", ".mjs", ".cjs"],
        "need": [["node"]],
        "commands": lambda exe, src, work: [[exe[0], src]],
    },
    "typescript": {
        "label": "TypeScript (Deno)",
        "exts": [".ts"],
        "need": [["deno"]],
        "commands": lambda exe, src, work: [[exe[0], "run", "--quiet", "--allow-all", src]],
    },
    "c": {
        "label": "C (gcc)",
        "exts": [".c"],
        "need": [["gcc", "clang"]],
        "commands": lambda exe, src, work: [
            [exe[0], src, "-O2", "-o", os.path.join(work, _exe("prog"))],
            [os.path.join(work, _exe("prog"))],
        ],
    },
    "cpp": {
        "label": "C++ (g++)",
        "exts": [".cpp", ".cc", ".cxx"],
        "need": [["g++", "clang++"]],
        "commands": lambda exe, src, work: [
            [exe[0], src, "-O2", "-std=c++17", "-o", os.path.join(work, _exe("prog"))],
            [os.path.join(work, _exe("prog"))],
        ],
    },
    "java": {
        "label": "Java",
        "exts": [".java"],
        "need": [["javac"], ["java"]],
        "commands": lambda exe, src, work: [
            [exe[0], "-d", work, src],
            [exe[1], "-cp", work, os.path.splitext(os.path.basename(src))[0]],
        ],
    },
    "ruby": {
        "label": "Ruby",
        "exts": [".rb"],
        "need": [["ruby"]],
        "commands": lambda exe, src, work: [[exe[0], src]],
    },
    "php": {
        "label": "PHP",
        "exts": [".php"],
        "need": [["php"]],
        "commands": lambda exe, src, work: [[exe[0], src]],
    },
    "go": {
        "label": "Go",
        "exts": [".go"],
        "need": [["go"]],
        "commands": lambda exe, src, work: [[exe[0], "run", src]],
    },
    "rust": {
        "label": "Rust",
        "exts": [".rs"],
        "need": [["rustc"]],
        "commands": lambda exe, src, work: [
            [exe[0], "-O", src, "-o", os.path.join(work, _exe("prog"))],
            [os.path.join(work, _exe("prog"))],
        ],
    },
    "shell": {
        "label": "Shell (bash)",
        "exts": [".sh"],
        "need": [["bash"]],
        "commands": lambda exe, src, work: [[exe[0], src]],
    },
}


def safe_path(base, rel):
    """base 配下に収まることを保証した絶対パスを返す (ディレクトリトラバーサル対策)。"""
    rel = str(rel).replace("\\", "/").strip().lstrip("/")
    if not rel or rel.endswith("/") or ".." in rel.split("/"):
        raise ValueError(f"不正なファイルパスです: {rel!r}")
    path = os.path.normpath(os.path.join(base, rel))
    if os.path.commonpath([base, path]) != base:
        raise ValueError(f"不正なファイルパスです: {rel!r}")
    return path


def write_project(workdir, files):
    if len(files) > MAX_FILES:
        raise ValueError(f"ファイル数が多すぎます (上限 {MAX_FILES})")
    total = 0
    for entry in files:
        content = entry.get("content", "")
        total += len(content.encode("utf-8"))
        if total > MAX_TOTAL_BYTES:
            raise ValueError("プロジェクトの合計サイズが大きすぎます")
        path = safe_path(workdir, entry.get("path", ""))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8", newline="") as fh:
            fh.write(content)


class Runner:
    """WebSocket 接続 1 本につき 1 つ。プロセスの起動・入出力・停止を管理する。"""

    def __init__(self, send):
        self.send = send
        self.proc = None
        self.thread = None
        self.state_lock = threading.Lock()
        self.out_bytes = 0
        self.stop_reason = None

    def is_running(self):
        return self.proc is not None and self.proc.poll() is None

    def start(self, payload):
        if self.is_running():
            self.send({"type": "system", "message": "前のプロセスを停止して再実行します"})
            self.kill(None)
            if self.thread:
                self.thread.join(timeout=5)
        self.thread = threading.Thread(target=self._run, args=(payload,), daemon=True)
        self.thread.start()

    def _run(self, payload):
        self.out_bytes = 0
        self.stop_reason = None
        workdir = tempfile.mkdtemp(prefix="codestudio_")
        try:
            lang_id = payload.get("language")
            spec = LANGUAGES.get(lang_id)
            if spec is None:
                self.send({"type": "error", "message": f"未対応の言語です: {lang_id}"})
                return

            exes = [find_exe(group) for group in spec["need"]]
            if not all(exes):
                missing = " / ".join(
                    ", ".join(group)
                    for group, exe in zip(spec["need"], exes)
                    if exe is None
                )
                self.send({
                    "type": "error",
                    "message": (
                        f"{spec['label']} のランタイム ({missing}) がサーバーに見つかりません。"
                    ),
                })
                return

            files = payload.get("files", [])
            entry = payload.get("entry", "")
            if not any(f.get("path") == entry for f in files):
                self.send({"type": "error", "message": f"エントリーファイルが見つかりません: {entry}"})
                return

            write_project(workdir, files)
            src = safe_path(workdir, entry)
            commands = spec["commands"](exes, src, workdir)

            # コンパイルが必要な言語 (最後のコマンド以外を先に実行)
            for cmd in commands[:-1]:
                self.send({"type": "system", "message": "コンパイル中..."})
                try:
                    comp = subprocess.run(
                        cmd, cwd=workdir, capture_output=True, timeout=MAX_COMPILE_SECONDS
                    )
                except subprocess.TimeoutExpired:
                    self.send({"type": "error", "message": "コンパイルがタイムアウトしました"})
                    return
                if comp.stdout:
                    self.send({"type": "stdout", "data": comp.stdout.decode("utf-8", "replace")})
                if comp.stderr:
                    self.send({"type": "stderr", "data": comp.stderr.decode("utf-8", "replace")})
                if comp.returncode != 0:
                    self.send({"type": "exit", "code": comp.returncode})
                    return

            run_cmd = commands[-1]
            exe_name = os.path.basename(run_cmd[0])
            if exe_name.lower().endswith(".exe"):
                exe_name = exe_name[:-4]
            display = [exe_name]
            for arg in run_cmd[1:]:
                rel = arg
                for prefix in (workdir + os.sep, workdir + "/"):
                    if rel.startswith(prefix):
                        rel = rel[len(prefix):]
                display.append(rel)

            env = dict(os.environ, PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8")
            popen_kwargs = {}
            if os.name == "posix":
                popen_kwargs["start_new_session"] = True

            proc = subprocess.Popen(
                run_cmd,
                cwd=workdir,
                env=env,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                **popen_kwargs,
            )
            with self.state_lock:
                self.proc = proc
            self.send({"type": "start", "command": " ".join(display)})

            watchdog = threading.Timer(
                MAX_RUN_SECONDS,
                self.kill,
                args=(f"実行時間が {MAX_RUN_SECONDS} 秒を超えたため停止しました",),
            )
            watchdog.daemon = True
            watchdog.start()

            t_out = threading.Thread(target=self._pump, args=(proc.stdout, "stdout"), daemon=True)
            t_err = threading.Thread(target=self._pump, args=(proc.stderr, "stderr"), daemon=True)
            t_out.start()
            t_err.start()

            code = proc.wait()
            t_out.join(timeout=3)
            t_err.join(timeout=3)
            watchdog.cancel()

            if self.stop_reason:
                self.send({"type": "system", "message": self.stop_reason})
            self.send({"type": "exit", "code": code})
        except ValueError as exc:
            self.send({"type": "error", "message": str(exc)})
        except Exception as exc:
            self.send({"type": "error", "message": f"内部エラー: {exc}"})
        finally:
            with self.state_lock:
                self.proc = None
            shutil.rmtree(workdir, ignore_errors=True)

    def _pump(self, stream, kind):
        try:
            while True:
                chunk = stream.read1(4096)
                if not chunk:
                    break
                self.out_bytes += len(chunk)
                self.send({"type": kind, "data": chunk.decode("utf-8", "replace")})
                if self.out_bytes > MAX_OUTPUT_BYTES:
                    self.kill("出力サイズが上限を超えたため停止しました")
                    break
        except Exception:
            pass

    def write_stdin(self, text):
        with self.state_lock:
            proc = self.proc
        if proc is None or proc.poll() is not None or proc.stdin is None:
            self.send({"type": "system", "message": "実行中のプロセスがありません"})
            return
        try:
            proc.stdin.write(text.encode("utf-8"))
            proc.stdin.flush()
        except Exception:
            pass

    def kill(self, reason=None):
        with self.state_lock:
            proc = self.proc
        if proc is None or proc.poll() is not None:
            return
        if reason:
            self.stop_reason = reason
        try:
            if os.name == "posix":
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            else:
                proc.kill()
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass


@app.get("/")
def index():
    return send_from_directory(FRONT_DIR, "index.html")


@app.get("/<path:filename>")
def frontend_files(filename):
    if filename.endswith((".py", ".pyc")) or filename.startswith("."):
        abort(404)
    if os.path.isfile(os.path.join(FRONT_DIR, filename)):
        return send_from_directory(FRONT_DIR, filename)
    flat = os.path.basename(filename)
    if flat != filename and os.path.isfile(os.path.join(FRONT_DIR, flat)):
        return send_from_directory(FRONT_DIR, flat)
    abort(404)


@app.get("/api/languages")
def api_languages():
    result = []
    for lang_id, spec in LANGUAGES.items():
        available = all(find_exe(group) for group in spec["need"])
        result.append({
            "id": lang_id,
            "label": spec["label"],
            "exts": spec["exts"],
            "available": available,
        })
    return jsonify(result)


@sock.route("/ws/run")
def ws_run(ws):
    send_lock = threading.Lock()

    def send(obj):
        with send_lock:
            try:
                ws.send(json.dumps(obj, ensure_ascii=False))
            except Exception:
                pass

    runner = Runner(send)
    try:
        while True:
            raw = ws.receive()
            if raw is None:
                break
            try:
                msg = json.loads(raw)
            except (TypeError, ValueError):
                continue
            msg_type = msg.get("type")
            if msg_type == "run":
                runner.start(msg)
            elif msg_type == "stdin":
                runner.write_stdin(msg.get("data", ""))
            elif msg_type == "kill":
                runner.kill("ユーザーにより停止されました")
    except Exception:
        pass
    finally:
        runner.kill(None)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    app.run(host="0.0.0.0", port=port, threaded=True)
