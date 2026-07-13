importScripts("core.js");

const { DEFAULT_SETTINGS, validateSettings, cleanReply, emptyHistory, lockExpired } = globalThis.XReplierCore;
const LOCK_KEY = "activeJob";
let lockChain = Promise.resolve();

chrome.runtime.onInstalled.addListener(async () => {
  const { settings, history } = await chrome.storage.local.get(["settings", "history"]);
  await chrome.storage.local.set({
    settings: { ...DEFAULT_SETTINGS, ...(settings || {}), autoConfirmed: Boolean(settings?.autoConfirmed) },
    history: history || emptyHistory()
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  const handlers = {
    GENERATE_REPLY: () => generateReply(message.postText),
    TEST_OPENAI: () => generateReply("Say only: connection ok"),
    CLAIM_JOB: () => claimJob(tabId),
    HEARTBEAT_JOB: () => heartbeatJob(tabId, message.jobId),
    RELEASE_JOB: () => releaseJob(tabId, message.jobId),
    GET_JOB_STATUS: () => chrome.storage.local.get(LOCK_KEY).then((v) => ({ ok: true, job: v[LOCK_KEY] || null })),
    CLEAR_HISTORY: () => chrome.storage.local.set({ history: emptyHistory() }).then(() => ({ ok: true })),
    DELETE_API_KEY: () => deleteApiKey()
  };
  if (!handlers[message.type]) return;
  Promise.resolve(handlers[message.type]()).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

async function deleteApiKey() {
  const { settings = DEFAULT_SETTINGS } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({ settings: { ...settings, apiKey: "" } });
  return { ok: true };
}

function withLock(fn) {
  const next = lockChain.then(fn, fn);
  lockChain = next.catch(() => {});
  return next;
}

function claimJob(tabId) {
  return withLock(async () => {
    if (!tabId) return { ok: false, error: "Не удалось определить вкладку." };
    const { activeJob } = await chrome.storage.local.get(LOCK_KEY);
    if (activeJob && !lockExpired(activeJob)) return { ok: false, error: "Обработка уже запущена в другой вкладке.", job: activeJob };
    const job = { id: crypto.randomUUID(), tabId, startedAt: Date.now(), heartbeatAt: Date.now(), state: "running" };
    await chrome.storage.local.set({ [LOCK_KEY]: job });
    return { ok: true, job };
  });
}

function heartbeatJob(tabId, jobId) {
  return withLock(async () => {
    const { activeJob } = await chrome.storage.local.get(LOCK_KEY);
    if (!activeJob || activeJob.id !== jobId || activeJob.tabId !== tabId) return { ok: false, error: "Задача больше не активна." };
    const job = { ...activeJob, heartbeatAt: Date.now() };
    await chrome.storage.local.set({ [LOCK_KEY]: job });
    return { ok: true };
  });
}

function releaseJob(tabId, jobId) {
  return withLock(async () => {
    const { activeJob } = await chrome.storage.local.get(LOCK_KEY);
    if (activeJob && activeJob.id === jobId && activeJob.tabId === tabId) await chrome.storage.local.remove(LOCK_KEY);
    return { ok: true };
  });
}

async function generateReply(postText) {
  const { settings = DEFAULT_SETTINGS } = await chrome.storage.local.get("settings");
  const validated = validateSettings(settings);
  if (!validated.settings.apiKey) return { ok: false, error: "Добавьте OpenAI API key в настройках расширения." };
  if (!validated.ok && !validated.errors.every((e) => e.includes("автоотправки"))) return { ok: false, error: validated.errors[0] };
  const body = {
    model: validated.settings.model,
    temperature: 0.7,
    max_tokens: 180,
    messages: [
      { role: "system", content: validated.settings.systemPrompt },
      { role: "user", content: `Post from X:\n\n${String(postText || "").slice(0, 2500)}` }
    ]
  };
  let lastError = "Не удалось связаться с OpenAI.";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${validated.settings.apiKey}` }, body: JSON.stringify(body), signal: controller.signal });
      const data = await response.json().catch(() => ({}));
      if (response.ok) return cleanReply(data?.choices?.[0]?.message?.content);
      lastError = data?.error?.message || `OpenAI вернул HTTP ${response.status}.`;
      if (response.status !== 429 && response.status < 500) break;
    } catch (error) {
      lastError = error.name === "AbortError" ? "OpenAI не ответил за 45 секунд." : "Сетевая ошибка при обращении к OpenAI.";
    } finally { clearTimeout(timeout); }
    await new Promise((resolve) => setTimeout(resolve, 800 * 2 ** attempt));
  }
  return { ok: false, error: lastError };
}
