# Voice-clone sidecar (Chatterbox)

A small FastAPI service that runs [Chatterbox](https://github.com/resemble-ai/chatterbox)
— Resemble AI's zero-shot voice-cloning model, **MIT-licensed including the
pre-trained weights**, so voices cloned here can lawfully be sold — next to the
Soundwave AI backend.

The model this replaced (OmniVoice) has Apache-2.0 code but **CC-BY-NC weights**:
the maintainers state on the model card that the pre-trained model "can't be used
commercially". Anything paid that used it was a licence violation waiting to be
noticed, so it is gone. Do not swap in XTTS v2 (Coqui CPML), F5-TTS
(CC-BY-NC-4.0), Higgs Audio or Piper's current GPL-3.0 fork for the same reason.
The Node API proxies to it (`POST /api/v1/tts/clone`, `/clone/profiles`); you
never call this service directly from the browser.

It holds the model in memory and is **stateless**: each generation request
carries the reference clip with it (`POST /clone/ephemeral`), so cloned voices
are owned per-user by the Node API and can survive this service restarting on
free/ephemeral hosting. (A standalone `/profiles` + `/clone` CRUD API still
exists for direct, non-Soundwave use.)

When `VOICECLONE_URL` points at anything other than localhost, set
`VOICECLONE_TOKEN` **on both sides** — the sidecar then requires
`Authorization: Bearer <token>` on every endpoint except `/health`.

---

## 1. Install & run (Windows)

> This guide targets Windows with an **AMD GPU** (e.g. RX 6650 XT). PyTorch
> does not ship AMD support on Windows, so the model runs on your **CPU** —
> perfectly workable (RTF ≈ 0.3–1×, i.e. a 10 s voiceover takes ~3–10 s plus a
> one-time model load of a minute or two). NVIDIA GPU or Linux? See
> [Other hardware](#3-other-hardware).

```powershell
cd voiceclone
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip

# PyTorch — CPU wheels (correct choice on Windows with an AMD GPU)
pip install torch torchaudio

# Chatterbox + the sidecar (weights are MIT too — no licence trap here)
pip install -r requirements.txt

# Run it (first start downloads the model weights from Hugging Face — several GB, one time only)
uvicorn server:app --host 127.0.0.1 --port 8100
```

Leave this terminal open. Health check: http://localhost:8100/health

## 2. Point Soundwave AI at it

In `server/.env` add:

```
VOICECLONE_URL=http://localhost:8100
# Optional: raise if CPU generation of long texts feels slow
VOICECLONE_TIMEOUT_MS=600000
```

Restart the Node API (`npm run dev`). Cloning is available through the API
(`POST /api/v1/tts/clone/profiles` with a 3–10 s clean reference clip —
WAV/MP3/FLAC/OGG — then `POST /api/v1/tts/clone`). The app itself no longer
has a voiceover page: the agent is the only thing that makes videos, and it
speaks and narrates with the Soundwave (Microsoft neural) voices. Unset
`VOICECLONE_URL` to turn the feature off.

## 3. Other hardware

- **NVIDIA GPU (much faster):** install CUDA torch first, then the rest, and
  set the device:

  ```powershell
  pip install torch==2.8.0+cu128 torchaudio==2.8.0+cu128 --extra-index-url https://download.pytorch.org/whl/cu128
  pip install -r requirements.txt
  $env:CHATTERBOX_DEVICE="cuda:0"
  uvicorn server:app --host 127.0.0.1 --port 8100
  ```

- **AMD GPU on Linux/WSL2 (ROCm):** RX 6600/6700-class cards work with ROCm
  torch + `HSA_OVERRIDE_GFX_VERSION=10.3.0`. Inside WSL2-Ubuntu:

  ```bash
  pip install torch torchaudio --index-url https://download.pytorch.org/whl/rocm6.2
  pip install -r requirements.txt
  export CHATTERBOX_DEVICE=cuda:0 HSA_OVERRIDE_GFX_VERSION=10.3.0
  uvicorn server:app --host 127.0.0.1 --port 8100
  ```

- **Apple Silicon:** default torch wheels + `CHATTERBOX_DEVICE=mps`.

## 4. Free hosting (no home PC required)

You built this on your own PC — but you don't need your PC on 24/7 to offer
cloning on the live site. Free options, in order of practicality:

### A) Hugging Face Spaces — free CPU, sleeps when idle

A Docker Space runs this folder as-is on a free 2-vCPU / 16 GB machine.
Expect ~1–3 min cold start when it has been idle (the model is baked into
the image, so no re-download) and several seconds per generation — fine for
a personal site.

1. [Create a new Space](https://huggingface.co/new-space) → **SDK: Docker**, any name, visibility *public* (private Spaces need HF auth that our proxy doesn't use; the token below is your real protection).
2. Copy the `voiceclone/` folder somewhere, where it becomes the Space repo:
   - rename `Space.README.md` → `README.md` (HF requires its front-matter),
   - `git init && git add -A && git commit -m init`,
   - `git remote add hf https://huggingface.co/spaces/<you>/<space>` and push.
3. In the Space → **Settings → Variables and secrets** → add secret `VOICECLONE_TOKEN` (long random string).
4. In your API's `.env`: `VOICECLONE_URL=https://<you>-<space>.hf.space` and the same `VOICECLONE_TOKEN`.

### B) Oracle Cloud "Always Free" ARM VM — truly always on, $0

A free Ampere A1 VM (up to 4 cores / 24 GB RAM) runs the container image
permanently. Signup needs a card for identity (never charged); ARM capacity
can be out of stock at busy times — retry or pick another region.

Setup once the VM is up (Ubuntu):
```bash
curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER  # log back in
docker build -t voiceclone ./voiceclone
docker run -d --restart unless-stopped -p 8100:7860 \
  -e VOICECLONE_TOKEN=<shared-secret> voiceclone
```
Then `VOICECLONE_URL=http://<vm-ip>:8100` (+ the token). Cleanest: put the VM
and your API host on a free [Tailscale](https://tailscale.com) network so the
port isn't internet-facing at all.

### C) Your home PC, when it's on — Cloudflare Tunnel (free)

The app already **hides the cloned voices automatically** whenever the
sidecar is unreachable, so this "sometimes available" pattern works fine:

```powershell
winget install cloudflare.cloudflared
cloudflared tunnel --url http://localhost:8100
```
Set `VOICECLONE_URL` to the `trycloudflare.com` URL it prints (+ token) on
your deployed API. Cloning works while your PC runs; the API answers with a
clear "offline" error otherwise. Zero cost either way.

## 5. Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `CHATTERBOX_DEVICE` | `cpu` | `cpu`, `cuda:0`, `mps`, `xpu` |
| `CHATTERBOX_NANO` | — | `1` = the smaller Turbo/Nano model, built for CPU |
| `CHATTERBOX_EXAGGERATION` | `0.5` | emotion dial, 0 = flat, 1 = excited |
| `CHATTERBOX_CFG_WEIGHT` | `0.5` | how strongly the reference clip is followed |
| `VOICECLONE_TOKEN` | — (no auth) | REQUIRED on any non-localhost deployment; must match the Node API |
| `VOICECLONE_HOST` / `VOICECLONE_PORT` | `127.0.0.1` / `8100` | bind address (main.py path; the Dockerfile uses `$PORT`) |
| `VOICECLONE_PROFILES_DIR` | `./profiles` | standalone `/profiles` CRUD storage (not used by the Node API) |
| `CHATTERBOX_MOCK` | — | `1` = no model, sine-wave output (dev/tests, no downloads) |

Node API side (`.env`): `VOICECLONE_URL`, `VOICECLONE_TOKEN`,
`VOICECLONE_TIMEOUT_MS`, and `VOICECLONE_MIN_PLAN` (`FREE` default — set `PRO`
to reserve cloning for paying users if the GPU costs you money).

## 6. Notes & tips

- **Reference clip:** 3–10 s of clean, single-speaker speech, same language as
  your target text. Longer clips slow inference and can hurt quality.
- **Per request cost:** because the service is stateless, each generation
  conditions on the reference clip — a few seconds of audio, small next to the
  synthesis itself.
- **Word timings:** Chatterbox returns audio only. The Node API derives evenly
  weighted word timings from the text + duration so the subtitle editor still
  auto-populates cues; nudge cue boundaries by hand for perfect sync.
- **Speed:** Chatterbox has no speed control (OmniVoice did). A request with a
  speed other than 1.0 is refused with a sentence saying where speed does work
  (the narration voice), rather than silently ignored.
- **Concurrency:** one generation at a time per sidecar (the model is held on
  one device under a lock). Run more replicas for parallel traffic.
- The service binds to `127.0.0.1` by default — only local processes can use
  your GPU/CPU time. Expose it beyond localhost **only with `VOICECLONE_TOKEN`
  set** (the Dockerfile binds `0.0.0.0`).

### Testing without a GPU/model

```
OMNIVOICE_MOCK=1 uvicorn server:app --port 8100
```

The mock returns valid WAV output, so the whole Node ⇄ Python pipeline can be
exercised without downloading weights.
