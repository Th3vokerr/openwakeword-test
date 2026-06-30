from __future__ import annotations

import asyncio
import time
from typing import Any

import numpy as np


class WakeWordDetector:
    def __init__(
        self,
        wakeword: str,
        threshold: float,
        debounce: float,
        *,
        download_models: bool = False,
    ) -> None:
        self.wakeword = wakeword
        self.threshold = threshold
        self.debounce = debounce
        self.download_models = download_models
        self._model: Any | None = None
        self._lock = asyncio.Lock()
        self._last_detection = 0.0

    def load(self) -> None:
        import openwakeword
        from openwakeword.model import Model
        from openwakeword.utils import download_models

        if self.download_models:
            download_models(model_names=[self.wakeword])

        if self.wakeword not in openwakeword.MODELS:
            choices = ", ".join(sorted(openwakeword.MODELS.keys()))
            raise ValueError(f"Unknown wake word '{self.wakeword}'. Choose one of: {choices}")

        # ONNX keeps setup simple across WSL, Linux, and Windows.
        self._model = Model(
            wakeword_models=[self.wakeword],
            inference_framework="onnx",
        )

    async def predict(self, audio: np.ndarray) -> dict[str, Any]:
        if self._model is None:
            raise RuntimeError("Wake word model has not loaded")

        async with self._lock:
            predictions = self._model.predict(audio)

        score = float(predictions.get(self.wakeword, 0.0))
        now = time.monotonic()
        detected = score >= self.threshold and now - self._last_detection >= self.debounce
        if detected:
            self._last_detection = now

        return {
            "type": "prediction",
            "wakeword": self.wakeword,
            "score": score,
            "detected": detected,
            "threshold": self.threshold,
            "all_scores": {key: float(value) for key, value in predictions.items()},
        }
