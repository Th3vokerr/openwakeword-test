#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if command -v python3.12 >/dev/null 2>&1; then
  PYTHON_BIN="python3.12"
elif command -v python3.13 >/dev/null 2>&1; then
  PYTHON_BIN="python3.13"
else
  if ! command -v uv >/dev/null 2>&1; then
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"
  fi

  uv python install 3.12
  uv venv --python 3.12 .venv
  source .venv/bin/activate
  python -m ensurepip --upgrade
  python -m pip install --upgrade pip
  python -m pip install -r requirements-wsl.txt
  python -m pip install --no-deps openwakeword==0.6.0
  echo "WSL environment ready. Run: source .venv/bin/activate && python app.py --download-models --wakeword hey_jarvis"
  exit 0
fi

"$PYTHON_BIN" -m venv .venv
source .venv/bin/activate
python -m ensurepip --upgrade
python -m pip install --upgrade pip
python -m pip install -r requirements-wsl.txt
python -m pip install --no-deps openwakeword==0.6.0
echo "WSL environment ready. Run: source .venv/bin/activate && python app.py --download-models --wakeword hey_jarvis"
