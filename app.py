from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from wakeword_detector import WakeWordDetector


ROOT = Path(__file__).parent
STATIC_DIR = ROOT / "static"
SAMPLE_RATE = 16_000
FRAME_SAMPLES = 1_280


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Browser mic -> Python openWakeWord demo")
    parser.add_argument(
        "--wakeword",
        default="hey_jarvis",
        help="openWakeWord pretrained model name, e.g. hey_jarvis, alexa, hey_mycroft",
    )
    parser.add_argument("--threshold", type=float, default=0.5)
    parser.add_argument("--debounce", type=float, default=1.5)
    parser.add_argument(
        "--download-models",
        action="store_true",
        help="Download openWakeWord models before starting the server.",
    )
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    return parser.parse_known_args()[0]


ARGS = parse_args()


detector = WakeWordDetector(
    ARGS.wakeword,
    ARGS.threshold,
    ARGS.debounce,
    download_models=ARGS.download_models,
)
app = FastAPI()
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.on_event("startup")
def startup() -> None:
    detector.load()


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/config")
def config() -> dict[str, Any]:
    return {
        "sampleRate": SAMPLE_RATE,
        "frameSamples": FRAME_SAMPLES,
        "wakeword": detector.wakeword,
        "threshold": detector.threshold,
    }


@app.websocket("/ws/audio")
async def audio_socket(websocket: WebSocket) -> None:
    await websocket.accept()
    await websocket.send_json(
        {
            "type": "ready",
            "sampleRate": SAMPLE_RATE,
            "frameSamples": FRAME_SAMPLES,
            "wakeword": detector.wakeword,
            "threshold": detector.threshold,
        }
    )

    pending = bytearray()
    frame_bytes = FRAME_SAMPLES * 2

    try:
        while True:
            message = await websocket.receive()
            chunk = message.get("bytes")
            if chunk is None:
                continue

            pending.extend(chunk)
            while len(pending) >= frame_bytes:
                frame = bytes(pending[:frame_bytes])
                del pending[:frame_bytes]

                audio = np.frombuffer(frame, dtype="<i2").astype(np.int16, copy=False)
                result = await detector.predict(audio)
                await websocket.send_json(result)
    except WebSocketDisconnect:
        return


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host=ARGS.host, port=ARGS.port, reload=False)
