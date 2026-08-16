// index.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

// audio.ts
import {
  assertOkOrThrowProviderError,
  readProviderJsonResponse,
  requireTranscriptionText
} from "openclaw/plugin-sdk/provider-http";
import { trimToUndefined } from "openclaw/plugin-sdk/speech-core";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname
} from "openclaw/plugin-sdk/ssrf-runtime";
var DEFAULT_SONIOX_API_BASE_URL = "https://api.soniox.com/v1";
var DEFAULT_SONIOX_STT_MODEL = "stt-async-v5";
var SONIOX_POLL_INTERVAL_MS = 1e3;
var SONIOX_REQUEST_TIMEOUT_MS = 3e4;
function resolveBaseUrl(baseUrl) {
  return (trimToUndefined(baseUrl) ?? DEFAULT_SONIOX_API_BASE_URL).replace(/\/+$/, "");
}
function resolveModel(model) {
  const trimmed = model?.trim();
  return trimmed || DEFAULT_SONIOX_STT_MODEL;
}
async function fetchJson(params) {
  const { response, release } = await fetchWithSsrFGuard({
    url: params.url,
    init: params.init,
    timeoutMs: params.timeoutMs,
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(params.url),
    auditContext: params.auditContext,
    ...params.fetchFn ? { fetchImpl: params.fetchFn } : {}
  });
  try {
    await assertOkOrThrowProviderError(response, "Soniox transcription API error");
    return await readProviderJsonResponse(response, params.auditContext);
  } finally {
    await release();
  }
}
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Soniox transcription aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Soniox transcription aborted"));
      },
      { once: true }
    );
  });
}
function readTranscriptionStatus(payload) {
  const status = payload.status;
  if (typeof status !== "string") {
    throw new Error("Soniox transcription failed: malformed JSON response");
  }
  return status;
}
function readTranscriptionError(payload) {
  const errorMessage = payload.error_message;
  return typeof errorMessage === "string" ? errorMessage : "unknown error";
}
function readTranscriptText(payload) {
  if (payload.text !== void 0 && typeof payload.text !== "string") {
    throw new Error("Soniox transcription failed: malformed JSON response");
  }
  return payload.text;
}
async function transcribeSonioxAudio(params) {
  const baseUrl = resolveBaseUrl(params.baseUrl);
  const model = resolveModel(params.model);
  const apiKey = params.auth?.kind === "api-key" ? params.auth.apiKey : params.apiKey;
  if (!apiKey) {
    throw new Error("Soniox API key missing");
  }
  const fetchFn = params.fetchFn ?? fetch;
  const deadline = Date.now() + params.timeoutMs;
  const requestTimeout = Math.min(params.timeoutMs, SONIOX_REQUEST_TIMEOUT_MS);
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(params.buffer)], {
      type: params.mime ?? "application/octet-stream"
    }),
    params.fileName
  );
  const uploaded = await fetchJson({
    url: `${baseUrl}/files`,
    init: {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": "OpenClaw" },
      body: form
    },
    apiKey,
    timeoutMs: requestTimeout,
    signal: params.signal,
    fetchFn,
    auditContext: "soniox.transcription.upload"
  });
  const fileId = trimToUndefined(uploaded.id);
  if (!fileId) {
    throw new Error("Soniox transcription failed: missing file id");
  }
  const transcriptionBody = {
    model,
    file_id: fileId
  };
  if (params.language?.trim()) {
    transcriptionBody.language_hints = [params.language.trim()];
  }
  if (params.enableSpeakerDiarization) {
    transcriptionBody.enable_speaker_diarization = true;
  }
  const created = await fetchJson({
    url: `${baseUrl}/transcriptions`,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "OpenClaw"
      },
      body: JSON.stringify(transcriptionBody)
    },
    apiKey,
    timeoutMs: requestTimeout,
    signal: params.signal,
    fetchFn,
    auditContext: "soniox.transcription.create"
  });
  const transcriptionId = trimToUndefined(created.id);
  if (!transcriptionId) {
    throw new Error("Soniox transcription failed: missing transcription id");
  }
  for (; ; ) {
    if (params.signal?.aborted) {
      throw new Error("Soniox transcription aborted");
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error("Soniox transcription timed out");
    }
    const job = await fetchJson({
      url: `${baseUrl}/transcriptions/${transcriptionId}`,
      init: {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": "OpenClaw" }
      },
      apiKey,
      timeoutMs: Math.min(remaining, requestTimeout),
      signal: params.signal,
      fetchFn,
      auditContext: "soniox.transcription.status"
    });
    const status = readTranscriptionStatus(job);
    if (status === "completed") {
      break;
    }
    if (status === "failed" || status === "error") {
      throw new Error(`Soniox transcription failed: ${readTranscriptionError(job)}`);
    }
    await delay(Math.min(SONIOX_POLL_INTERVAL_MS, remaining), params.signal);
  }
  const transcript = await fetchJson({
    url: `${baseUrl}/transcriptions/${transcriptionId}/transcript`,
    init: {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": "OpenClaw" }
    },
    apiKey,
    timeoutMs: requestTimeout,
    signal: params.signal,
    fetchFn,
    auditContext: "soniox.transcription.transcript"
  });
  const text = requireTranscriptionText(
    readTranscriptText(transcript),
    "Soniox transcription response missing transcript"
  );
  return { text, model };
}

// media-understanding-provider.ts
var sonioxMediaUnderstandingProvider = {
  id: "soniox",
  capabilities: ["audio"],
  defaultModels: { audio: "stt-async-v5" },
  autoPriority: { audio: 30 },
  transcribeAudio: transcribeSonioxAudio
};

// index.ts
var index_default = definePluginEntry({
  id: "soniox",
  name: "Soniox",
  description: "Bundled Soniox async speech-to-text (media-understanding) provider",
  register(api) {
    api.registerMediaUnderstandingProvider(sonioxMediaUnderstandingProvider);
  }
});
export {
  index_default as default
};
