"""Dettato Desk - a small local web server around the dettato transcriber.

Run:  python server.py [--port 8765] [--device auto|cuda|cpu|mps]

The API accepts raw audio bytes (with an X-Filename header) so no multipart
parsing or extra web framework is needed.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import struct
import sys
import threading
import time
import traceback
import urllib.parse
import uuid
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
DATA = ROOT / "data" / "jobs"
DATA.mkdir(parents=True, exist_ok=True)

# dettato normally downloads weights from the Hugging Face Hub. If the local
# mirror cache is populated, use it instead (see download_weights.py).
WEIGHTS_CACHE = ROOT / "weights"
if "DETTATO_WEIGHTS" not in os.environ and (WEIGHTS_CACHE / "dettato" / "model.safetensors").exists():
    os.environ["DETTATO_WEIGHTS"] = str(WEIGHTS_CACHE)


def setup_ffmpeg() -> None:
    """imageio-ffmpeg bundles an ffmpeg.exe; expose it as plain `ffmpeg`."""
    try:
        import imageio_ffmpeg

        src = Path(imageio_ffmpeg.get_ffmpeg_exe())
        bin_dir = ROOT / "data" / "bin"
        bin_dir.mkdir(parents=True, exist_ok=True)
        target = bin_dir / "ffmpeg.exe"
        if not target.exists():
            shutil.copy2(src, target)
        os.environ["PATH"] = str(bin_dir) + os.pathsep + os.environ.get("PATH", "")
    except Exception as exc:  # noqa: BLE001
        log(f"ffmpeg not available ({exc}); WAV/MP3 via soundfile still work")

JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()
MODEL = None
MODEL_LOCK = threading.Lock()
MODEL_ERROR = None
DEVICE_CHOICE = "auto"
STARTED = time.time()

AUDIO_EXT = {".wav", ".mp3", ".flac", ".ogg", ".opus", ".m4a", ".aac", ".aiff", ".aif"}
SAFE_ID = re.compile(r"^[a-f0-9]{12}$")


def log(msg: str) -> None:
    print(f"[dettato-desk] {msg}", flush=True)


def job_dir(jid: str) -> Path:
    return DATA / jid


def load_model(device: str | None):
    global MODEL, MODEL_ERROR
    with MODEL_LOCK:
        if MODEL is not None:
            return MODEL
        if MODEL_ERROR is not None and "download" not in MODEL_ERROR.lower():
            raise RuntimeError(MODEL_ERROR)
        try:
            log("loading dettato models ...")
            from dettato import Dettato

            MODEL = Dettato.from_pretrained(device)
            log(f"models ready on {MODEL.device}")
            MODEL_ERROR = None
            return MODEL
        except Exception as exc:  # noqa: BLE001
            MODEL_ERROR = f"{type(exc).__name__}: {exc}"
            log(f"model load failed: {MODEL_ERROR}")
            raise


def note_progress(elapsed: float, seconds: float, device: str) -> int:
    """Coarse ETA-based progress; dettato does not expose stage callbacks."""
    rate = 0.06 if device.startswith("cuda") else (0.12 if device.startswith("mps") else 2.0)
    expected = max(8.0, (seconds or 60) * rate)
    return int(min(92, 16 + 76 * (elapsed / expected)))


def worker(jid: str, device_arg: str) -> None:
    job = JOBS[jid]
    t0 = time.time()
    try:
        job["status"] = "loading"
        job["stage"] = "加载模型（首次使用会下载权重）"
        job["progress"] = 4
        model = load_model(None if device_arg == "auto" else device_arg)

        job["status"] = "running"
        job["stage"] = "正在转录音频"
        job["progress"] = 16
        seconds = job.get("seconds") or 60.0
        tick_stop = threading.Event()

        def ticker():
            while not tick_stop.wait(0.5):
                with JOBS_LOCK:
                    if JOBS[jid]["status"] == "running":
                        JOBS[jid]["progress"] = note_progress(time.time() - t0, seconds, str(model.device))
                        JOBS[jid]["elapsed"] = round(time.time() - t0, 1)

        threading.Thread(target=ticker, daemon=True).start()
        try:
            result = model.transcribe(job["audio_path"])
        finally:
            tick_stop.set()

        out = job_dir(jid)
        midi_path = out / "result.mid"
        json_path = out / "result.json"
        result.save_midi(str(midi_path))

        summary = result.summary()
        detail = {
            "tracks": [
                {
                    "name": t.name,
                    "program": None if t.is_drum else int(t.program),
                    "is_drum": bool(t.is_drum),
                    "notes": [
                        [round(float(n[0]), 3), round(float(n[1]), 3), int(n[2]), int(n[3])]
                        for n in (t.notes[:: max(1, len(t.notes) // 6000)] if len(t.notes) > 6000 else t.notes)
                    ],
                }
                for t in result.tracks
            ]
        }
        with open(json_path, "w", encoding="utf-8") as fh:
            json.dump({"summary": summary, "detail": detail}, fh, ensure_ascii=False, indent=1)

        with JOBS_LOCK:
            job.update(
                status="done",
                progress=100,
                stage="完成",
                summary=summary,
                detail=detail,
                midi=str(midi_path),
                json=str(json_path),
                elapsed=round(time.time() - t0, 1),
                device=str(model.device),
            )
        log(f"job {jid} done in {job['elapsed']}s: {len(result.tracks)} tracks")
    except Exception as exc:  # noqa: BLE001
        tb = traceback.format_exc(limit=4)
        log(f"job {jid} failed:\n{tb}")
        with JOBS_LOCK:
            job.update(status="error", stage="失败", error=f"{type(exc).__name__}: {exc}", elapsed=round(time.time() - t0, 1))


def make_demo_wav(path: Path) -> None:
    """An 8-second synthetic melody so the UI can be tried without a file."""
    rate = 44100
    notes = [(0.0, 0.45, 60), (0.5, 0.45, 64), (1.0, 0.45, 67), (1.5, 0.45, 72),
             (2.0, 0.9, 71), (3.0, 0.9, 67), (4.0, 0.45, 62), (4.5, 0.45, 65),
             (5.0, 0.45, 69), (5.5, 0.45, 74), (6.0, 1.6, 72)]
    samples = bytearray()
    for i in range(int(rate * 8)):
        t = i / rate
        value = 0.0
        for on, dur, pitch in notes:
            if on <= t < on + dur:
                f = 440.0 * 2 ** ((pitch - 69) / 12)
                env = min(1.0, (t - on) / 0.02) * min(1.0, (on + dur - t) / 0.08)
                value += 0.22 * env * (math.sin(2 * math.pi * f * t) + 0.25 * math.sin(4 * math.pi * f * t))
        samples.extend(struct.pack("<h", int(max(-1, min(1, value)) * 22000)))
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(bytes(samples))


def audio_duration(path: Path) -> float:
    try:
        import soundfile as sf

        return float(sf.info(str(path)).duration)
    except Exception:  # noqa: BLE001
        try:
            with wave.open(str(path), "rb") as wf:
                return wf.getnframes() / wf.getframerate()
        except Exception:  # noqa: BLE001
            return 0.0


class Handler(BaseHTTPRequestHandler):
    server_version = "DettatoDesk/1.0"

    def log_message(self, fmt, *args):  # quieter logs
        pass

    def reply(self, code: int, body, ctype: str = "application/json; charset=utf-8", extra: dict | None = None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def file_reply(self, path: Path, ctype: str, name: str | None = None):
        if not path.exists():
            return self.reply(404, {"error": "not found"})
        data = path.read_bytes()
        extra = {"Content-Disposition": f'attachment; filename="{name}"'} if name else None
        return self.reply(200, data, ctype, extra)

    def query(self) -> dict:
        return dict(urllib.parse.parse_qsl(urllib.parse.urlparse(self.path).query))

    def route(self) -> str:
        return urllib.parse.urlparse(self.path).path

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        p = self.route()
        try:
            if p in ("/", "/index.html"):
                return self.file_reply(WEB / "index.html", "text/html; charset=utf-8")
            if p in ("/sheet", "/sheet.html"):
                return self.file_reply(WEB / "sheet.html", "text/html; charset=utf-8")
            if p in ("/app.js", "/style.css", "/score.js", "/sheet.js", "/vendor/vexflow.js"):
                ctype = "text/css; charset=utf-8" if p.endswith(".css") else "text/javascript; charset=utf-8"
                return self.file_reply(WEB / p.lstrip("/"), ctype)
            if p == "/sheet.css":
                return self.file_reply(WEB / "sheet.css", "text/css; charset=utf-8")
            if p == "/api/health":
                gpu = False
                gpu_name = None
                try:
                    import torch

                    gpu = torch.cuda.is_available()
                    gpu_name = torch.cuda.get_device_name(0) if gpu else None
                except Exception:  # noqa: BLE001
                    pass
                return self.reply(200, {
                    "ok": True,
                    "version": "2.0.0",
                    "model_loaded": MODEL is not None,
                    "model_error": MODEL_ERROR,
                    "device": DEVICE_CHOICE,
                    "gpu": gpu,
                    "gpu_name": gpu_name,
                    "uptime": round(time.time() - STARTED, 1),
                })
            if p == "/api/jobs":
                with JOBS_LOCK:
                    items = [{k: v for k, v in j.items() if k not in ("audio_path", "midi", "json", "detail")} for j in JOBS.values()]
                return self.reply(200, {"jobs": sorted(items, key=lambda x: x["created"], reverse=True)})
            if p == "/api/job":
                jid = self.query().get("id", "")
                job = JOBS.get(jid) if SAFE_ID.match(jid) else None
                if not job:
                    return self.reply(404, {"error": "job not found"})
                return self.reply(200, dict(job))
            if p == "/api/download":
                q = self.query()
                job = JOBS.get(q.get("id", ""))
                kind = q.get("kind", "midi")
                if not job or kind not in ("midi", "json"):
                    return self.reply(404, {"error": "not found"})
                base = Path(job["filename"]).stem
                if kind == "midi":
                    return self.file_reply(Path(job["midi"]), "audio/midi", f"{base}.mid")
                return self.file_reply(Path(job["json"]), "application/json", f"{base}.json")
            if p == "/api/audio":
                job = JOBS.get(self.query().get("id", ""))
                if not job:
                    return self.reply(404, {"error": "not found"})
                suffix = Path(job["filename"]).suffix.lower()
                ctype = {".wav": "audio/wav", ".mp3": "audio/mpeg", ".flac": "audio/flac",
                         ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".aac": "audio/aac"}.get(suffix, "application/octet-stream")
                return self.file_reply(Path(job["audio_path"]), ctype)
            if p == "/api/demo.wav":
                tmp = DATA / "_demo.wav"
                if not tmp.exists():
                    make_demo_wav(tmp)
                return self.file_reply(tmp, "audio/wav")
            return self.reply(404, {"error": "not found"})
        except Exception as exc:  # noqa: BLE001
            return self.reply(500, {"error": str(exc)})

    def do_POST(self):
        p = self.route()
        try:
            if p == "/api/upload":
                length = int(self.headers.get("Content-Length", "0"))
                if not length or length > 200 * 1024 * 1024:
                    return self.reply(400, {"error": "empty or too large (>200 MB)"})
                raw_name = self.headers.get("X-Filename", "audio.wav")
                raw_name = urllib.parse.unquote(raw_name).replace("\\", "/").split("/")[-1]
                name = re.sub(r"[^A-Za-z0-9._ -]", "_", raw_name).strip() or "audio.wav"
                if Path(name).suffix.lower() not in AUDIO_EXT:
                    return self.reply(400, {"error": f"unsupported audio type: {Path(name).suffix}"})
                jid = uuid.uuid4().hex[:12]
                out = job_dir(jid)
                out.mkdir(parents=True)
                audio_path = out / name
                left = length
                with open(audio_path, "wb") as fh:
                    while left > 0:
                        chunk = self.rfile.read(min(1024 * 1024, left))
                        if not chunk:
                            break
                        fh.write(chunk)
                        left -= len(chunk)
                if left:
                    return self.reply(400, {"error": "incomplete upload"})
                job = {
                    "id": jid,
                    "filename": name,
                    "audio_path": str(audio_path),
                    "seconds": audio_duration(audio_path),
                    "bytes": length,
                    "status": "uploaded",
                    "stage": "等待开始",
                    "progress": 0,
                    "created": round(time.time(), 2),
                    "elapsed": 0,
                    "error": None,
                    "summary": None,
                    "detail": None,
                    "midi": None,
                    "json": None,
                    "device": None,
                }
                with JOBS_LOCK:
                    JOBS[jid] = job
                log(f"uploaded {name} ({length / 1e6:.1f} MB, {job['seconds']:.1f}s)")
                return self.reply(200, {k: v for k, v in job.items() if k not in ("audio_path", "midi", "json", "detail")})

            if p == "/api/transcribe":
                data = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
                jid = str(data.get("id", ""))
                job = JOBS.get(jid)
                if not job:
                    return self.reply(404, {"error": "job not found"})
                if job["status"] in ("loading", "running"):
                    return self.reply(409, {"error": "already running"})
                job.update(status="queued", stage="排队中", progress=1, error=None)
                threading.Thread(target=worker, args=(jid, str(data.get("device") or DEVICE_CHOICE)), daemon=True).start()
                return self.reply(200, {"ok": True, "id": jid})

            if p == "/api/delete":
                data = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
                jid = str(data.get("id", ""))
                job = JOBS.pop(jid, None)
                if job and job["status"] not in ("loading", "running"):
                    import shutil

                    shutil.rmtree(job_dir(jid), ignore_errors=True)
                return self.reply(200, {"ok": True})

            return self.reply(404, {"error": "not found"})
        except Exception as exc:  # noqa: BLE001
            return self.reply(500, {"error": str(exc)})


def main() -> None:
    global DEVICE_CHOICE
    ap = argparse.ArgumentParser(description="Dettato Desk web server")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--device", default="auto", help="auto, cuda, cpu, mps, cuda:1 ...")
    args = ap.parse_args()
    DEVICE_CHOICE = args.device
    setup_ffmpeg()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    log(f"ready at http://{args.host}:{args.port}  (device={args.device})")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
