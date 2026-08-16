# @guionai/soniox-stt-provider

Soniox async speech-to-text (STT) provider for the OpenClaw media-understanding
audio pipeline. Optional vendor plugin — distributed via ClawHub, not bundled
with core (same pattern as the volcengine provider).

## What it provides

- Async transcription workflow: upload → create job → poll → transcript
- Default model `stt-async-v5`
- Per-model `language` hints (60+ languages; code-switching supported by Soniox)
- Optional speaker diarization (`enableSpeakerDiarization`, default off)
- ~$0.10/hour at Soniox published rates

## Install

```bash
openclaw plugins install clawhub:guionai/soniox-stt-provider
# or from a local checkout (dev):
openclaw plugins install --link ./extensions/soniox
```

Requires OpenClaw >= 2026.8.1.

## Configure

Set the API key in the gateway environment:

```bash
export SONIOX_API_KEY="your_key"   # or tools.media.audio.models apiKey
```

Enable as an audio model (example):

```json5
tools: {
  media: {
    audio: {
      models: [
        {
          provider: "soniox",
          model: "stt-async-v5",
          capabilities: ["audio"],
          language: "zh",
          enableSpeakerDiarization: false, // optional; default off
        },
      ],
    },
  },
}
```

## Permissions & secrets

- Only outbound HTTPS calls to `api.soniox.com` (upload, job, transcript endpoints)
- Single secret: `SONIOX_API_KEY` (falls back to `tts.providers...apiKey` config)
- No inbound listeners, no filesystem writes

## Update

```bash
openclaw plugins update soniox
```

## Smoke test

```bash
openclaw agent -m '转写这段语音并回我文字'   # send a voice note, expect text back
# or unit-level:
cd extensions/soniox && npx vitest run   # 5 tests: happy path, overrides, diarization, errors
```
