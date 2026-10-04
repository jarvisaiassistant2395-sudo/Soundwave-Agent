# Soundwave's local voice service — CPU container image.
#   • cloned voices: Chatterbox (MIT, code and weights)
#   • narration on this machine: Kokoro-82M (Apache-2.0, code and weights)
# Works on Hugging Face Spaces (free CPU tier), Oracle Cloud Always Free
# (Ampere ARM64 included — multi-arch wheels), and any container host.
#
#   docker build -t voiceclone ./voiceclone
#   docker run -p 8100:7860 -e VOICECLONE_TOKEN=<shared-secret> voiceclone
#
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    CHATTERBOX_DEVICE=cpu \
    PORT=7860

WORKDIR /app

# CPU PyTorch first so `chatterbox-tts` reuses it instead of pulling CUDA wheels
# (keeps the image ~8 GB lighter and works everywhere).
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir torch torchaudio --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt install.sh ./
# Step 2 is --no-deps on purpose: `kokoro` would otherwise pull `misaki[en]`,
# whose extras are GPL-3.0 (phonemizer-fork, espeakng-loader). We use misaki.en
# directly — see requirements.txt and kokoro_engine.py.
RUN pip install --no-cache-dir -r requirements.txt \
 && pip install --no-cache-dir --no-deps kokoro \
 && python -m spacy download en_core_web_sm

# Bake the model weights into the image so cold starts (e.g. a Space waking from
# sleep) load from disk instead of re-downloading them. Both are permissively
# licensed: Chatterbox MIT, Kokoro-82M Apache-2.0 (code and weights).
RUN python -c "from huggingface_hub import snapshot_download; snapshot_download('ResembleAI/chatterbox'); snapshot_download('hexgrad/Kokoro-82M')"

COPY server.py kokoro_engine.py selftest.py .

# The service's own licence position: no GPL code is installed or imported. Runs
# the real checks (mock engines, no downloads) and fails the build if that ever
# stops being true.
RUN python selftest.py

EXPOSE 7860
CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port ${PORT:-7860}"]
