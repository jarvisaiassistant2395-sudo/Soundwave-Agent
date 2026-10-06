# Local voice service (Kokoro + MOSS; optional Chatterbox)

A small FastAPI service with on-device narration and voice cloning. The models
run locally; reference audio is not sent to a hosted synthesis provider.

| Engine | What it does | Licence (code **and** weights) |
| --- | --- | --- |
| [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) | Narration for videos in 28 voices, on CPU | **Apache-2.0** |
| [MOSS-TTS-Nano-100M-ONNX](https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX) | CPU voice cloning from a 3–10 s reference | **Apache-2.0** |
| [Chatterbox](https://github.com/resemble-ai/chatterbox) | Optional cloning engine for manual/server installs | **MIT** |

### Candidate comparison (provisional; no Soundwave PC benchmark yet)

| Candidate | License and distribution | Realistic model/runtime cost | Low-/medium-end fit |
| --- | --- | --- | --- |
| **MOSS-TTS-Nano ONNX** | Apache-2.0 source and weights; public, revision-pinned [Hugging Face assets](https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX). | 16 pinned ONNX files total **763,191,513 bytes (727.8 MiB)**. Its [pinned source](https://github.com/OpenMOSS/MOSS-TTS-Nano/tree/8b7bcc9341b3b4ef3a3a58ba1338a7d85ff133eb) imports CPU PyTorch/Torchaudio for reference-audio loading alongside ONNX Runtime; Kokoro already needs the same CPU PyTorch environment. | [Official docs](https://github.com/OpenMOSS/MOSS-TTS-Nano) describe CPU inference; an [independent test](https://sleepingrobots.com/dreams/moss-tts-strix-halo/) reports RTF 0.23 on a Ryzen AI Max+ 395 at 8 threads, not on a low-end PC. Its 20 listed languages do **not** include Serbian. Current desktop candidate, pending real device tests. |
| **Chatterbox Nano** | [MIT](https://github.com/resemble-ai/chatterbox) code and [weights](https://huggingface.co/ResembleAI/chatterbox-nano), but the [official loader dependencies](https://github.com/resemble-ai/chatterbox/blob/master/pyproject.toml) conflict with the managed pins (Torch 2.6.0 / Transformers 5.2.0 vs MOSS's Torch 2.7.0 / Transformers 4.57.1). | Hugging Face reports about **2.997 GB** stored for the Nano repo. The upstream snapshot downloads both `s3gen.safetensors` (**1.056 GB**) and `s3gen_meanflow.safetensors` (**1.065 GB**), while inspected inference code uses meanflow; filtering the unused checkpoint could save ~1.06 GB. An isolated environment would add duplicate Python/model storage. | [Official claim](https://huggingface.co/ResembleAI/chatterbox-nano) is 3× real-time on an 8-core CPU; English only. Vendor [reference-audio guidance](https://www.resemble.ai/learn/models/chatterbox-nano) recommends at least 10 seconds, so quality at the required 3-second minimum needs testing. No representative 4-core/low-memory benchmark was found. |
| **NeuTTS Nano Q4 GGUF** | [NeuTTS Open License 1.0](https://github.com/neuphonic/neutts/blob/main/LICENSE): commercial use by an entity at or above **$5M annual revenue** is not granted without another license. Its [Hugging Face model files](https://huggingface.co/neuphonic/neutts-nano-q4-gguf) require accepting gated access conditions. | Q4 backbone is **194,600,640 bytes**, but the [official default NeuCodec checkpoint](https://huggingface.co/neuphonic/neucodec) is **2,519,855,456 bytes**. The [stock package](https://github.com/neuphonic/neutts/blob/main/pyproject.toml) requests Torch/Torchaudio ≥2.8 and Transformers 5.1, conflicting with the managed MOSS pins (2.7.0 / 4.57.1); GGUF also needs `llama-cpp-python` and system eSpeak-NG. | Officially positioned for real-time laptop CPUs, with English, German, French, and Spanish variants; no Serbian. Gating, license threshold, codec download, and dependency changes make it a poor automatic first-run fit. |

MOSS is therefore the **provisional** managed-desktop choice for the best fit
between an Apache-2.0 model, public non-gated downloads, modest pinned assets,
and a CPU ONNX path—not a completed quality or speed decision. The official
MOSS documentation and the independent Strix Halo benchmark are reference
points only; one [anecdotal 4-core N100 user report](https://www.reddit.com/r/LocalLLaMA/comments/1sjdfp6/mossttsnano_a_01b_opensource_multilingual_tts/)
also cautions that “CPU-capable” does not guarantee real-time speed on every
low-end machine. Soundwave's managed setup caps CPU threads and serializes
inference, but realistic low-/medium-end PC testing is still required.

Commercial rights matter because Soundwave sells access: the managed MOSS
source/weights are Apache-2.0 and optional Chatterbox code/weights are MIT.
NeuTTS has the separate revenue threshold and gated-access caveats in the table.
The model this service replaced (OmniVoice) has Apache-2.0 code but **CC-BY-NC
weights** — its maintainers say the pre-trained model "can't be used
commercially". It is not part of the managed product. Do not reintroduce other
candidates (including XTTS, F5-TTS, Higgs Audio, or Piper) without auditing the
exact code, weight, training-data, dependency, and distribution terms first.

The Node API proxies to this service (`POST /api/v1/tts/clone`,
`/clone/profiles`, `/api/v1/tts/synthesize`, `/api/v1/voices`); the browser
never calls it directly.

**Packaged Windows desktop:** Soundwave provisions Kokoro narration and MOSS
CPU cloning automatically on first use. Setup downloads a checksum-pinned
Python runtime, CPU-only dependencies, pinned MOSS source, and the ONNX assets
into the app's per-user data folder, then starts the service invisibly. The
model files alone are about 728 MiB. The manager enforces a 3 GB free-space
floor before installing the package/model stack; the exact Windows download and
final storage totals have not yet been measured (Python and spaCy wheels and the
Kokoro assets vary by platform/revision). Progress, cancellation, retry, and
same-session recovery are handled by Soundwave; after setup, the models are cached
locally for offline use. Chatterbox remains available only in manual/server
installs. MOSS lists 20 languages but not Serbian, and low-/medium-end speed
has not yet been benchmarked; do not treat the current selection as a validated
performance decision.

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

> This manual guide is for development or standalone/server installs. It can
> enable Chatterbox; MOSS and Kokoro are separately configurable. The packaged
> Windows desktop manages Kokoro narration and MOSS cloning itself (see above).
> This guide targets Windows with an **AMD GPU** (e.g. RX 6650 XT). PyTorch
> does not ship AMD support on Windows, so inference runs on your **CPU**.
> Reported Chatterbox speeds are hardware-specific and do not establish MOSS
> performance on low-/medium-end PCs. NVIDIA GPU or Linux? See
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
python test_preflight.py     # the setup gate's own checks (no packages needed)
python test_engine.py        # the phoneme/style-row path — the "hum instead of
                             # a voice" failure, pinned without the model
python preflight.py          # is everything the service imports actually here?
python selftest.py           # the real HTTP contract + the no-GPL guarantee

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
loads a ~3 MB BART model from `PeterReid/graphemes_to_phonemes_en_us` or
`PeterReid/graphemes_to_phonemes_en_gb` whose Hugging Face cards state no
licence. They are misaki's own defaults and are downloaded to your machine, not
bundled by us — but the gap is named rather than glossed over.) Installing with
`--no-deps` keeps the GPL packages out of the environment
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
(`POST /api/v1/tts/clone/profiles` with a clean WAV/MP3/FLAC/OGG/M4A/WEBM
reference. Chatterbox accepts 3–60 s; MOSS accepts 3–10 s. Before storing a
profile, the API asks the sidecar to decode and validate the actual duration;
creation is blocked unless the user confirms voice ownership or explicit
speaker permission. `LOCAL_VOICE_URL` defaults to `VOICECLONE_URL`, so the same
service can supply Kokoro narration. Set `LOCAL_VOICE_URL` separately if
narration and cloning should use different services. Unset the URLs to turn
those features off.

For the packaged Windows desktop app, leave these unset: Soundwave chooses a
loopback port and starts its managed Kokoro + MOSS service on first use of a
local-voice feature. It stores the private Python environment, setup log,
Hugging Face cache and model under the app's user-data folder, and stops the
service when Soundwave exits. The first setup needs internet access; progress,
cancellation and same-session retry are available. After setup, synthesis runs
on this PC offline. To disable the automatic setup for a diagnostic run, set
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

## 3b. When setup "succeeded" but narration never starts

Three separate failures have all looked like this, so `preflight.py` now checks
for every one of them and `install.sh` refuses to report success without it:

- **`attrs` is missing** (`ModuleNotFoundError: No module named 'attr'`) —
  `kokoro/custom_stft.py` imports it, `istftnet.py` imports that file and
  `model.py` imports istftnet, so it is on the load path of *every* narration.
  Nothing declares it, so pip never installed it and `pip check` stayed silent.
  `requirements*.txt` list it by hand; the desktop setup does too.
- **A package the service imports is missing at all** — Kokoro is installed with
  `--no-deps` on purpose (its `misaki[en]` extra is GPL), so pip never resolves
  its requirements. `preflight.py` now walks the engines' own import closure
  (`kokoro.model` → `istftnet` → `custom_stft` …) and prints
  `missing: <name>` instead of letting the service die on first use.
- **`en_core_web_sm` is missing** — misaki's `G2P.__init__` calls
  `spacy.cli.download()` *itself* when the model is absent: a network fetch from
  inside the running service, which on a machine with antivirus HTTPS scanning
  (or no internet) ends as an SSL traceback at the first narration.
  `preflight.py` prints
  `missing-model: en_core_web_sm (not on PyPI — \`python -m spacy download en_core_web_sm\`)`
  and `KokoroEngine` refuses that path with the same instruction. It is not a
  pip package: only `spacy download` installs it, and the installer runs that
  with `truststore` injected so the Windows certificate store is trusted.

Verify an install at any time with `python preflight.py` (fast, no downloads)
followed by `python selftest.py`; a healthy one prints
`preflight ok: … imported modules and 1 spaCy model(s) verified` and
`all checks passed`.

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
| `CHATTERBOX_OFF` | — | `1` = do not load or expose the optional Chatterbox engine |
| `CHATTERBOX_NANO` | — | `1` = the smaller Turbo/Nano model, built for CPU |
| `CHATTERBOX_EXAGGERATION` | `0.5` | emotion dial, 0 = flat, 1 = excited |
| `CHATTERBOX_CFG_WEIGHT` | `0.5` | how strongly the reference clip is followed |
| `KOKORO_OFF` | — | `1` = narration off (cloning still works) |
| `KOKORO_PRELOAD` | — | `1` = load the speech model, American/British pronunciation assets and every advertised voice pack before uvicorn listens; used by packaged desktop |
| `KOKORO_SPEED` | `1.0` | narration speed; a request may override it |
| `KOKORO_LANG` | `a` | default accent pipeline: `a` American, `b` British |
| `VOICECLONE_TOKEN` | — (no auth) | REQUIRED on any non-localhost deployment; must match the Node API |
| `VOICECLONE_HOST` / `VOICECLONE_PORT` | `127.0.0.1` / `8100` | bind address (main.py path; the Dockerfile uses `$PORT`) |
| `VOICECLONE_PROFILES_DIR` | `./profiles` | standalone `/profiles` CRUD storage (not used by the Node API) |
| `MOSS_OFF` | `1` | `0` = enable pinned MOSS-TTS-Nano ONNX cloning |
| `MOSS_PRELOAD` | `1` | `1` = initialize MOSS before the API becomes ready |
| `MOSS_CPU_THREADS` | auto, max 4 | Limit PyTorch and ONNX Runtime CPU threads |
| `CHATTERBOX_MOCK` | — | `1` = no model, sine-wave output (dev/tests, no downloads) |

Node API side (`.env`): `VOICECLONE_URL`, `LOCAL_VOICE_URL`, `VOICECLONE_TOKEN`,
`VOICECLONE_TIMEOUT_MS`, and `VOICECLONE_MIN_PLAN` (`FREE` default — set `PRO`
to reserve cloning for paying users if the GPU costs you money).

## 7. Notes & tips

- **Reference clip:** at least 3 seconds of clean, single-speaker speech.
  Chatterbox accepts up to 60 seconds; MOSS is limited to 10 seconds. Use a
  language supported by the selected model (Serbian is not in MOSS's listed
  language set). Longer clips can slow inference and hurt quality.
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
