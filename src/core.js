(() => {
  const MAX_HISTORY = 3000;
  const STATES = new Set(["discovered", "generating", "drafted", "sending", "sent", "skipped", "failed", "unknown"]);

  const DEFAULT_SETTINGS = Object.freeze({
    apiKey: "",
    model: "gpt-4.1-mini",
    systemPrompt: "Write one concise, natural reply to the post. Match its language. Be helpful and specific. Do not use hashtags unless they are genuinely useful. Return only the reply text.",
    mode: "draft",
    autoConfirmed: false,
    dailyLimit: 10,
    minDelaySec: 45,
    maxDelaySec: 120,
    minPostLength: 35
  });

  function localDay(now = new Date()) {
    const offset = now.getTimezoneOffset() * 60000;
    return new Date(now.getTime() - offset).toISOString().slice(0, 10);
  }

  function positive(value, fallback, maximum) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(maximum, Math.max(1, Math.floor(n)));
  }

  function validateSettings(input = {}) {
    const s = { ...DEFAULT_SETTINGS, ...input };
    const errors = [];
    s.apiKey = String(s.apiKey || "").trim();
    s.model = String(s.model || "").trim();
    s.systemPrompt = String(s.systemPrompt || "").trim();
    s.mode = s.mode === "auto" ? "auto" : "draft";
    s.autoConfirmed = Boolean(s.autoConfirmed);
    s.dailyLimit = positive(s.dailyLimit, DEFAULT_SETTINGS.dailyLimit, 100);
    s.minPostLength = positive(s.minPostLength, DEFAULT_SETTINGS.minPostLength, 10000);
    s.minDelaySec = positive(s.minDelaySec, DEFAULT_SETTINGS.minDelaySec, 3600);
    s.maxDelaySec = positive(s.maxDelaySec, DEFAULT_SETTINGS.maxDelaySec, 3600);
    if (s.minDelaySec > s.maxDelaySec) errors.push("Минимальная задержка не может быть больше максимальной.");
    if (s.systemPrompt.length > 8000) errors.push("Системный промпт слишком длинный.");
    if (!s.model) errors.push("Укажите модель OpenAI.");
    if (s.mode === "auto" && !s.autoConfirmed) errors.push("Подтвердите включение автоотправки.");
    return { ok: errors.length === 0, settings: s, errors };
  }

  function emptyHistory(day = localDay()) {
    return { day, sentToday: 0, draftedPosts: {}, sentPosts: {}, skippedPosts: {}, failedPosts: {}, unknownPosts: {} };
  }

  function normalizeHistory(history = {}, day = localDay()) {
    const base = emptyHistory(day);
    const out = { ...base, ...history };
    if (out.day !== day) return base;
    const sent = Number(out.sentToday);
    out.sentToday = Number.isFinite(sent) ? Math.min(100000, Math.max(0, Math.floor(sent))) : 0;
    for (const key of ["draftedPosts", "sentPosts", "skippedPosts", "failedPosts", "unknownPosts"]) out[key] = pruneMap(out[key]);
    return out;
  }

  function pruneMap(map = {}, limit = MAX_HISTORY) {
    return Object.fromEntries(Object.entries(map).filter(([, value]) => Number.isFinite(Number(value))).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, limit));
  }

  function applyPostState(history, postId, state, now = Date.now()) {
    if (!STATES.has(state)) throw new Error(`Неизвестное состояние: ${state}`);
    const out = normalizeHistory(history);
    const maps = ["draftedPosts", "sentPosts", "skippedPosts", "failedPosts", "unknownPosts"];
    for (const key of maps) delete out[key][postId];
    const mapByState = { drafted: "draftedPosts", sent: "sentPosts", skipped: "skippedPosts", failed: "failedPosts", unknown: "unknownPosts" };
    if (mapByState[state]) out[mapByState[state]][postId] = now;
    if (state === "sent") out.sentToday += 1;
    for (const key of maps) out[key] = pruneMap(out[key]);
    return out;
  }

  function isProcessed(history, postId) {
    return ["draftedPosts", "sentPosts", "skippedPosts", "failedPosts", "unknownPosts"].some((key) => Boolean(history?.[key]?.[postId]));
  }

  function cleanReply(value, maxLength = 280) {
    let reply = String(value || "").trim();
    const json = reply.match(/\{[\s\S]*\}/);
    if (json) { try { const parsed = JSON.parse(json[0]); if (typeof parsed.reply === "string") reply = parsed.reply; } catch (_) {} }
    reply = reply.replace(/^```(?:\w+)?\s*|\s*```$/g, "").replace(/^(?:reply|ответ)\s*:\s*/i, "").replace(/^["'«]+|["'»]+$/g, "").trim();
    if (!reply) return { ok: false, error: "Модель вернула пустой ответ." };
    if (reply.length > maxLength) return { ok: false, error: `Ответ длиннее ${maxLength} символов.` };
    return { ok: true, reply };
  }

  function randomDelay(min, max, random = Math.random) {
    const low = positive(min, 1, 3600); const high = positive(max, low, 3600);
    return Math.floor(Math.min(low, high) + random() * (Math.abs(high - low) + 1));
  }

  function lockExpired(lock, now = Date.now(), ttlMs = 30000) { return !lock || !lock.heartbeatAt || now - lock.heartbeatAt > ttlMs; }

  const api = { DEFAULT_SETTINGS, MAX_HISTORY, localDay, validateSettings, emptyHistory, normalizeHistory, pruneMap, applyPostState, isProcessed, cleanReply, randomDelay, lockExpired };
  globalThis.XReplierCore = api;
  if (typeof module !== "undefined") module.exports = api;
})();
