const DEFAULT_SETTINGS = {
  apiKey: "",
  model: "gpt-4.1-mini",
  systemPrompt: "Write one concise, natural reply to the post. Match its language. Be helpful and specific. Do not use hashtags unless they are genuinely useful. Return only the reply text.",
  mode: "draft",
  dailyLimit: 10,
  minDelaySec: 45,
  maxDelaySec: 120,
  minPostLength: 35
};

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get("settings");
  if (!current.settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS, history: {} });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "GENERATE_REPLY") return;
  generateReply(message.postText).then(sendResponse).catch((error) => {
    sendResponse({ ok: false, error: error.message || String(error) });
  });
  return true;
});

async function generateReply(postText) {
  const { settings = DEFAULT_SETTINGS } = await chrome.storage.local.get("settings");
  if (!settings.apiKey) return { ok: false, error: "Добавьте OpenAI API key в настройках расширения." };
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify({
      model: settings.model || DEFAULT_SETTINGS.model,
      temperature: 0.7,
      max_tokens: 180,
      messages: [
        { role: "system", content: settings.systemPrompt || DEFAULT_SETTINGS.systemPrompt },
        { role: "user", content: `Post from X:\n\n${String(postText).slice(0, 2500)}` }
      ]
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return { ok: false, error: data?.error?.message || `OpenAI returned HTTP ${response.status}` };
  const reply = data?.choices?.[0]?.message?.content?.trim();
  return reply ? { ok: true, reply } : { ok: false, error: "Модель не вернула текст ответа." };
}
