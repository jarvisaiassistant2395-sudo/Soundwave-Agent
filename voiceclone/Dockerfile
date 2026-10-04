# Chatterbox voice-clone sidecar — CPU container image. (MIT code + MIT weights.)
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

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Bake the default model weights into the image so cold starts (e.g. a Space
# waking from sleep) load from disk instead of re-downloading them.
RUN python -c "from huggingface_hub import snapshot_download; snapshot_download('ResembleAI/chatterbox')"

COPY server.py .

EXPOSE 7860
CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port ${PORT:-7860}"]
