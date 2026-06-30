from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import sys
import time

import numpy as np

from wakeword_detector import WakeWordDetector


DEBUG_LOGS = os.getenv("DEBUG_LOGS") == "1"


def log(message: str) -> None:
    print(f"[wakeword-worker {time.strftime('%Y-%m-%dT%H:%M:%S')}] {message}", file=sys.stderr, flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Line-oriented openWakeWord worker")
    parser.add_argument("--wakeword", default="alexa")
    parser.add_argument("--threshold", type=float, default=0.5)
    parser.add_argument("--debounce", type=float, default=1.5)
    parser.add_argument("--download-models", action="store_true")
    return parser.parse_args()


def write_json(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main() -> None:
    args = parse_args()
    log(
        f"starting wakeword={args.wakeword} threshold={args.threshold} "
        f"debounce={args.debounce} download_models={args.download_models}"
    )
    detector = WakeWordDetector(
        args.wakeword,
        args.threshold,
        args.debounce,
        download_models=args.download_models,
    )
    detector.load()
    log("model loaded")
    write_json({"type": "ready", "wakeword": args.wakeword, "threshold": args.threshold})

    for line in sys.stdin:
        try:
            request = json.loads(line)
            audio_bytes = base64.b64decode(request["audio"])
            audio = np.frombuffer(audio_bytes, dtype="<i2").astype(np.int16, copy=False)
            result = asyncio.run(detector.predict(audio))
            if DEBUG_LOGS or result["detected"] or result["score"] >= 0.05:
                log(
                    f"prediction id={request['id']} user={request['userId']} "
                    f"score={result['score']:.4f} detected={result['detected']}"
                )
            write_json(
                {
                    "type": "prediction",
                    "id": request["id"],
                    "userId": request["userId"],
                    "score": result["score"],
                    "detected": result["detected"],
                }
            )
        except Exception as exc:
            log(f"error: {exc}")
            write_json({"type": "error", "message": str(exc)})


if __name__ == "__main__":
    main()
