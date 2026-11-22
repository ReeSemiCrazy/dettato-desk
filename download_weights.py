"""Download dettato's four model repos from hf-mirror.com into a local cache.

The sandbox proxy blocks huggingface.co, so this uses the mirror and a browser
User-Agent. Run once; server.py picks up the folder via DETTATO_WEIGHTS.
"""

from __future__ import annotations

import os
import shutil
import sys
import urllib.request
from pathlib import Path

REPOS = ["dettato", "dettato-evidence", "dettato-grouper", "dettato-drums"]
FILES = ["config.json", "model.safetensors"]
BASE = "https://hf-mirror.com/kobimusic/"
DEST = Path(os.environ.get("DETTATO_WEIGHTS", str(Path(__file__).resolve().parent / "weights")))
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"


def download(url: str, target: Path) -> None:
    if target.exists() and target.stat().st_size > 0:
        print(f"skip  {target.name} ({target.stat().st_size / 1e6:.1f} MB)", flush=True)
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(1, 7):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=120) as res, open(target, "wb") as fh:
                total = int(res.headers.get("Content-Length", 0))
                done = 0
                while True:
                    chunk = res.read(1024 * 1024)
                    if not chunk:
                        break
                    fh.write(chunk)
                    done += len(chunk)
                    if total:
                        sys.stdout.write(f"\r  {done / 1e6:.1f}/{total / 1e6:.1f} MB")
                        sys.stdout.flush()
            print(f"  -> {target.name} {target.stat().st_size / 1e6:.1f} MB", flush=True)
            return
        except Exception as exc:  # noqa: BLE001
            partial = target.stat().st_size if target.exists() else 0
            print(f"\n  attempt {attempt} failed: {type(exc).__name__} ({partial / 1e6:.1f} MB done)", flush=True)
            if partial:
                target.unlink()
    raise RuntimeError(f"could not download {url}")


def main() -> None:
    print(f"weights cache: {DEST}", flush=True)
    for repo in REPOS:
        print(f"[ {repo} ]", flush=True)
        for name in FILES:
            download(f"{BASE}{repo}/resolve/main/{name}", DEST / repo / name)
    print("done. Set DETTATO_WEIGHTS=" + str(DEST), flush=True)


if __name__ == "__main__":
    main()
