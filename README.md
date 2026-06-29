# Browser microphone to openWakeWord

This serves a local page that captures your browser microphone, resamples it to
16 kHz mono PCM in JavaScript, streams it to Python over a WebSocket, and runs
openWakeWord detection in Python.

## Install

### WSL Ubuntu

Open Ubuntu and go to this project:

```bash
cd /mnt/c/Users/Victus/Desktop/siegheil1488
sudo apt update
sudo apt install -y python3 python3-venv python3-pip
bash setup_wsl.sh
```

For best performance, you can also copy the project into WSL's Linux filesystem:

```bash
cp -r /mnt/c/Users/Victus/Desktop/siegheil1488 ~/siegheil1488
cd ~/siegheil1488
```

Then create the virtualenv there with the same commands above.

The setup script prefers Python 3.12 or 3.13. If your WSL only has a newer
Python, it installs `uv` and uses that to create a Python 3.12 virtualenv,
because some ML packages may not publish wheels for brand-new Python versions
right away.

For WSL, the script uses `requirements-wsl.txt` and installs `openwakeword`
with `--no-deps`. That avoids `tflite-runtime`, which openWakeWord declares on
Linux even though this app uses the ONNX backend.

### Windows PowerShell

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

## Run

```powershell
python app.py --download-models --wakeword hey_jarvis
```

From WSL, the same command is:

```bash
source .venv/bin/activate
python app.py --download-models --wakeword hey_jarvis
```

Then open http://localhost:8000 in your Windows browser and click **Start mic**.

After the first run downloads models, `--download-models` is optional.

Useful wake words from openWakeWord include `hey_jarvis`, `alexa`,
`hey_mycroft`, `hey_rhasspy`, `timer`, and `weather`.

## Notes

- Browsers only allow microphone access on secure origins. `localhost` and
  `127.0.0.1` count as secure for local development.
- The Python side expects raw little-endian `int16` audio at 16 kHz, 1280
  samples per frame.
- The app binds to `0.0.0.0` by default so Windows can reach the WSL-hosted
  server through `localhost:8000`.
- The app uses the ONNX openWakeWord backend to keep setup simple across WSL,
  Linux, and Windows.
