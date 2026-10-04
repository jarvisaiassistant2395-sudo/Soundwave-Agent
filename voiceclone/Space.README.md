---
title: Soundwave VoiceClone Sidecar
emoji: 🎙️
colorFrom: blue
colorTo: violet
sdk: docker
pinned: false
---

# Soundwave AI — voice-clone sidecar

Private Chatterbox inference sidecar for the [Soundwave AI](https://github.com/Str4hinj47/Soundwave-AI)
app. All endpoints except `/health` require `Authorization: Bearer <VOICECLONE_TOKEN>`
(set the token as a **Space secret** and in your Node API's `server/.env`).

This Space is meant to be called by your own backend only — it is not a demo.
