# Local voice service (Chatterbox + Kokoro)

A small FastAPI service with two jobs, both of them running on **your own
machine** — nothing metered, nothing sent to a paid provider:

| Engine | What it does | Licence (code **and** weights) |
| --- | --- | --- |
| [Chatterbox](https://github.com/resemble-ai/chatterbox) | Clones a voice from a 5-s reference clip | **MIT** |
| [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) | Narration for videos in 28 voices, on CPU | **Apache-2.0** |

Both licences allow commercial use, which matters: Soundwave sells access, and
the model this replaced (OmniVoice) has Apache-2.0 code but **CC-BY-NC weights**
— the maintainers state on the model card that the pre-trained model "can't be
used commercially". Anything paid that used it was a licence violation waiting
to be noticed, so it is gone. Do not swap in XTTS v2 (Coqui CPML), F5-TTS
(CC-BY-NC-4.0), Higgs Audio or Piper's current GPL-3.0 fork for the same reason.

The Node API proxies to this service (`POST /api/v1/tts/clone`,
`/clone/profiles`, `/api/v1/tts/synthesize`, `/api/v1/voices`); the browser
never calls it directly.

**Packaged Windows desktop:** Soundwave provisions this service automatically
in a Kokoro-only mode on first launch. It downloads a checksum-pinned Python
runtime and CPU-only dependencies into the app's per-user data folder, fetches
the narration model once, and runs the service as a hidden background process.
No Python install, terminal, or separate manual start is needed. Voice Library
and Settings show first-run progress and let you cancel setup; Soundwave's
Microsoft voices remain available, and Kokoro can retry the next time the app
starts. Chatterbox cloning is intentionally excluded from this automatic
install. The full Chatterbox + Kokoro service below remains available for
development and standalone/server installs.

It holds the models in memory and is **stateless**: each generation request
carries the reference clip with it (`POST /clone/ephemeral`), so cloned voices
are owned per-user by the Node API and can survive this service restarting on
free/ephemeral hosting. (A standalone `/profiles` + `/clone` CRUD API still
exists for direct, non-Soundwave use.)

When `VOICECLONE_URL` points at anything other than localhost, set
`VOICECLONE_TOKEN` **on both sides** — the service then requires
`Authorization: Bearer <token>` on every endpoint except `/health`.

---

## 1. Install & run (manual/development setup)

> This manual guide is for the full service, including Chatterbox cloning, or
> for a standalone Node server. The packaged Windows desktop installs and starts
> its Kokoro-only narrator itself in the background (see above). This guide
> targets Windows with an **AMD GPU** (e.g. RX 6650 XT). PyTorch
> does not ship AMD support on Windows, so the models run on your **CPU** —
> perfectly workable (Chatterbox RTF ≈ 0.3–1×; Kokoro is far lighter and
> narrates about as fast as it plays). NVIDIA GPU or Linux? See
> [Other hardware](#3-other-hardware).

```powershell
cd voiceclone
python -m venv .venv
.\.venv\Scripts\Activate.ps1

# CPU PyTorch first, so the model packages reuse it instead of pulling CUDA wheels
pip install torch torchaudio

# Everything else, then Kokoro's model code (see "Why --no-deps" below)
pip install -r requirements.txt
pip install --no-deps kokoro
python -m spacy download en_core_web_sm

# Check it without downloading a single model (fast, no weights)
python selftest.py           # 23 structural checks + the no-GPL guarantee
python test_engine.py        # the phoneme/style-row path — the "hum instead of
                             # a voice" failure, pinned without the model

# …and once, for real (downloads the model + one voice, then measures the audio
# and writes selftest-output.wav so you can hear it yourself)
python selftest.py --real

# Run it (first start downloads the weights from Hugging Face — one time only)
uvicorn server:app --host 127.0.0.1 --port 8100
```

Leave this terminal open. Health check: http://localhost:8100/health — it lists
both engines and their licences.

### Why `pip install --no-deps kokoro`

`kokoro` declares `misaki[en]` as a requirement, and that extra is
`phonemizer-fork` (**GPL-3.0**) plus `espeakng-loader` (which ships espeak-ng,
GPL-3.0). We don't need either: `kokoro_engine.py` drives the model with
`misaki.en` directly — Apache-2.0, dictionary plus misaki's own
`FallbackNetwork` for out-of-dictionary words — and never imports the espeak
path. (One caveat, recorded in `THIRD-PARTY-NOTICES.txt` too: that fallback
loads a ~3 MB BART model from `PeterReid/graphemes_to_phonemes_en_us` whose
Hugging Face card states no licence. It is misaki's own default and is
downloaded to your machine, not bundled by us — but the gap is named rather
than glossed over.) Installing with `--no-deps` keeps the GPL packages out of the environment
altogether, and `KokoroEngine` refuses to start if they ever appear
(`selftest.py` checks this too, statically and at runtime).

`num2words` (LGPL-2.1) comes along with misaki and is used to speak digits; it
is installed separately, unmodified, and its licence text ships with it. No
GPL-3.0 code is installed or linked anywhere in this service.

*Linux/macOS:* run `./install.sh` (same steps, plus `TORCH=cu124 ./install.sh`
if you want CUDA).

## 2. Point a development or hosted Soundwave API at it

In `server/.env` add:

```
VOICECLONE_URL=http://localhost:8100
# Optional: raise if CPU generation of long texts feels slow
VOICECLONE_TIMEOUT_MS=600000
```

Restart the Node API (`npm run dev`). Cloning is available through the API
(`POST /api/v1/tts/clone/profiles` with a 3–10 s clean reference clip —
WAV/MP3/FLAC/OGG — then `POST /api/v1/tts/clone`). `LOCAL_VOICE_URL` defaults
to `VOICECLONE_URL`, so the same service can supply Kokoro narration. Set
`LOCAL_VOICE_URL` separately if narration and cloning should use different
services. Unset the URLs to turn those features off.

For the packaged Windows desktop app, leave these unset: Soundwave chooses a
loopback port and starts its managed Kokoro-only service. It stores the private
Python environment, setup log, Hugging Face cache and model under the app's
user-data folder, and stops the service when Soundwave exits. The first setup
needs internet access; after that, synthesis runs on this PC. To disable the
automatic setup for a diagnostic run, set
`SOUNDWAVE_DISABLE_KOKORO_AUTO_SETUP=1` before launching Soundwave.

## 3. Narration on this PC (Kokoro)

Once this service is reachable, the app offers its voices wherever a voice is
picked — **Voice Library → "On this PC"**, Settings → Voice & Desktop, and the
Command Center — as `kokoro:af_heart` and friends. Picking one narrates locally,
free and unmetered, and the media is produced by this machine.

- 28 real voices: 11 American female, 9 American male, 4 British female,
  4 British male. The first letter of a voice id picks the pipeline
  (`a`/`b` = American/British), which is why the accent is part of the id.
- `af_heart` is the default. `GET /tts/kokoro/voices` lists them all.
- A `kokoro:` voice is used **only when it was chosen** — it is never
  substituted for a Microsoft voice, so a failing Edge request can't quietly
  turn into a different-sounding video.
- Style: write pronunciation with markdown link syntax —
  `[Kokoro](/kˈOkəɹO/)` — and stress with `ˈ`/`ˌ` or `(+1)`/`(-1)` if a word
  comes out wrong. It is documented in Kokoro's own demo.
- `KOKORO_OFF=1` (or a missing install) hides the voices and leaves cloning
  working; the app falls back to the Microsoft voices, never to silence.

Kokoro has no word timings, so the Node API estimates them from text and
duration (same as cloning) — the subtitle editor still auto-populates.

### "It only hums" — how that is prevented, and how to prove it here

A Kokoro integration that emits a drone almost never has a broken model. It is
one of: raw **text** handed to the model instead of misaki's **phonemes**
(letters aren't in its vocab, so it generates its prior — noise), the wrong
**style row** (`ref_s` must be `pack[len(phonemes) - 1]`; `pack[0]` or the whole
tensor gives a constant wrong style — the literal "brrrwmmrwbb"), or the wrong
sample rate / PCM scaling on the way out. `test_engine.py` pins the first two
with stand-ins for torch/misaki (runs anywhere, no downloads), `_encode_wav`
handles the third, and `selftest.py --real` measures the real output — duration,
speech-band energy versus a low drone, broadband-ness, clipping — and refuses to
call a hum a voice.

## 4. Other hardware

- **NVIDIA GPU (much faster):** install CUDA torch first, then the rest, and
  set the device:

  ```powershell
  pip install torch==2.8.0+cu128 torchaudio==2.8.0+cu128 --extra-index-url https://download.pytorch.org/whl/cu128
  pip install -r requirements.txt
  pip install --no-deps kokoro
  python -m spacy download en_core_web_sm
  $env:CHATTERBOX_DEVICE="cuda:0"
  uvicorn server:app --host 127.0.0.1 --port 8100
  ```

- **AMD GPU on Linux/WSL2 (ROCm):** RX 6600/6700-class cards work with ROCm
  torch + `HSA_OVERRIDE_GFX_VERSION=10.3.0`. Inside WSL2-Ubuntu:

  ```bash
  TORCH=rocm6.2 ./install.sh
  export CHATTERBOX_DEVICE=cuda:0 HSA_OVERRIDE_GFX_VERSION=10.3.0
  uvicorn server:app --host 127.0.0.1 --port 8100
  ```

- **Apple Silicon:** default torch wheels + `CHATTERBOX_DEVICE=mps`.

## 5. Free hosting (no home PC required)

You built this on your own PC — but you don't need your PC on 24/7 to offer
cloning on the live site. Free options, in order of practicality:

### A) Hugging Face Spaces — free CPU, sleeps when idle

A Docker Space runs this folder as-is on a free 2-vCPU / 16 GB machine.
Expect ~1–3 min cold start when it has been idle (the models are baked into
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
service is unreachable, so this "sometimes available" pattern works fine:

```powershell
winget install cloudflare.cloudflared
cloudflared tunnel --url http://localhost:8100
```
Set `VOICECLONE_URL` to the `trycloudflare.com` URL it prints (+ token) on
your deployed API. Cloning works while your PC runs; the API answers with a
clear "offline" error otherwise. Zero cost either way.

## 6. Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `CHATTERBOX_DEVICE` | `cpu` | `cpu`, `cuda:0`, `mps`, `xpu` — used by both engines |
| `CHATTERBOX_OFF` | — | `1` = Kokoro-only mode; do not load or expose Chatterbox cloning |
| `CHATTERBOX_NANO` | — | `1` = the smaller Turbo/Nano model, built for CPU |
| `CHATTERBOX_EXAGGERATION` | `0.5` | emotion dial, 0 = flat, 1 = excited |
| `CHATTERBOX_CFG_WEIGHT` | `0.5` | how strongly the reference clip is followed |
| `KOKORO_OFF` | — | `1` = narration off (cloning still works) |
| `KOKORO_PRELOAD` | — | `1` = load the model and default voice before uvicorn listens; used by packaged desktop |
| `KOKORO_SPEED` | `1.0` | narration speed; a request may override it |
| `KOKORO_LANG` | `a` | default accent pipeline: `a` American, `b` British |
| `VOICECLONE_TOKEN` | — (no auth) | REQUIRED on any non-localhost deployment; must match the Node API |
| `VOICECLONE_HOST` / `VOICECLONE_PORT` | `127.0.0.1` / `8100` | bind address (main.py path; the Dockerfile uses `$PORT`) |
| `VOICECLONE_PROFILES_DIR` | `./profiles` | standalone `/profiles` CRUD storage (not used by the Node API) |
| `CHATTERBOX_MOCK` | — | `1` = no model, sine-wave output (dev/tests, no downloads) |

Node API side (`.env`): `VOICECLONE_URL`, `LOCAL_VOICE_URL`, `VOICECLONE_TOKEN`,
`VOICECLONE_TIMEOUT_MS`, and `VOICECLONE_MIN_PLAN` (`FREE` default — set `PRO`
to reserve cloning for paying users if the GPU costs you money).

## 7. Notes & tips

- **Reference clip:** 3–10 s of clean, single-speaker speech, same language as
  your target text. Longer clips slow inference and can hurt quality.
- **Per request cost:** because the service is stateless, each generation
  conditions on the reference clip — a few seconds of audio, small next to the
  synthesis itself.
- **Word timings:** neither engine returns them. The Node API derives evenly
  weighted timings from the text + duration so the subtitle editor still
  auto-populates cues; nudge cue boundaries by hand for perfect sync.
- **Speed:** Chatterbox has no speed control (OmniVoice did). A clone request
  with a speed other than 1.0 is refused with a sentence saying where speed does
  work (the narration voice), rather than silently ignored. Kokoro does have it.
- **Concurrency:** one generation at a time per engine (the models are held on
  one device under a lock). Run more replicas for parallel traffic.
- The service binds to `127.0.0.1` by default — only local processes can use
  your GPU/CPU time. Expose it beyond localhost **only with `VOICECLONE_TOKEN`
  set** (the Dockerfile binds `0.0.0.0`).

### Testing without a GPU/model

```bash
CHATTERBOX_MOCK=1 KOKORO_OFF=1 uvicorn server:app --port 8100
python selftest.py     # the same checks the Docker build runs
```

The mock returns valid WAV output, so the whole Node ⇄ Python pipeline can be
exercised without downloading weights.
