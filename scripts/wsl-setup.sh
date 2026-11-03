#!/usr/bin/env bash
# Install demucs inside WSL (Linux binaries are not subject to Windows Smart App Control).
set -e

echo "=== torch (cpu wheel) ==="
python3 -m pip install --break-system-packages --no-cache-dir \
    torch torchaudio --index-url https://download.pytorch.org/whl/cpu 2>&1 | tail -4

echo "=== demucs ==="
python3 -m pip install --break-system-packages --no-cache-dir demucs 2>&1 | tail -4

echo "=== verify ==="
python3 -c "import torch, demucs; print('torch', torch.__version__)"
which demucs || echo "(demucs cli not on PATH, will use python -m demucs)"
