"""Parallel-download the CUDA torch wheel from Aliyun into the local pip cache.

The official PyTorch index is throttled here; the Aliyun mirror serves Range
requests, so we fetch it in chunks and assemble a normal wheel for pip.
"""

from __future__ import annotations

import os
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

URL = "https://mirrors.aliyun.com/pytorch-wheels/cu128/torch-2.11.0%2Bcu128-cp313-cp313-win_amd64.whl"
DEST = Path(os.environ.get("TORCH_WHEEL", str(Path.home() / ".cache" / "wheels" / "torch-2.11.0+cu128-cp313-cp313-win_amd64.whl")))
CHUNK = 8 * 1024 * 1024
WORKERS = 16
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"


def size() -> int:
    req = urllib.request.Request(URL, method="HEAD", headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as res:
        return int(res.headers["Content-Length"])


def fetch_part(i: int, start: int, end: int, target: Path) -> None:
    if target.exists() and target.stat().st_size == end - start + 1:
        return
    for attempt in range(5):
        try:
            req = urllib.request.Request(URL, headers={"User-Agent": UA, "Range": f"bytes={start}-{end}"})
            with urllib.request.urlopen(req, timeout=180) as res, open(target, "wb") as fh:
                data = res.read()
            if len(data) != end - start + 1:
                raise IOError(f"short chunk {i}: {len(data)}")
            target.write_bytes(data)
            return
        except Exception as exc:  # noqa: BLE001
            print(f"chunk {i} attempt {attempt + 1}: {type(exc).__name__}", flush=True)
            if target.exists():
                target.unlink()
    raise RuntimeError(f"chunk {i} failed")


def main() -> None:
    total = size()
    print(f"wheel size {total / 1e9:.2f} GB -> {DEST}", flush=True)
    parts_dir = DEST.parent / "torch_parts"
    parts_dir.mkdir(parents=True, exist_ok=True)
    ranges = [(i, i * CHUNK, min(total - 1, (i + 1) * CHUNK - 1)) for i in range((total + CHUNK - 1) // CHUNK)]
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = [pool.submit(fetch_part, i, s, e, parts_dir / f"part{i:04d}") for i, s, e in ranges]
        done = 0
        for f in as_completed(futures):
            f.result()
            done += 1
            print(f"\r{done}/{len(ranges)} chunks", end="", flush=True)
    print("\nassembling ...", flush=True)
    DEST.parent.mkdir(parents=True, exist_ok=True)
    with open(DEST, "wb") as out:
        for i, _, _ in ranges:
            out.write((parts_dir / f"part{i:04d}").read_bytes())
    print(f"done: {DEST} ({DEST.stat().st_size / 1e9:.2f} GB)", flush=True)


if __name__ == "__main__":
    main()
