const DEFAULTS = { apiKey: "", model: "gpt-4.1-mini", systemPrompt: "Write one concise, natural reply to the post. Match its language. Be helpful and specific. Do not use hashtags unless they are genuinely useful. Return only the reply text.", mode: "draft", dailyLimit: 10, minDelaySec: 45, maxDelaySec: 120, minPostLength: 35 };
const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", async () => {
  const { settings = DEFAULTS } = await chrome.storage.local.get("settings");
  fill({ ...DEFAULTS, ...settings });
  $("save").addEventListener("click", save);
  $("start").addEventListener("click", () => messageTab({ type: "START_REPLIER" }));
  $("stop").addEventListener("click", () => messageTab({ type: "STOP_REPLIER" }));
});

function fill(s) { ["apiKey", "model", "systemPrompt", "dailyLimit", "minDelaySec", "maxDelaySec", "minPostLength"].forEach(key => $(key).value = s[key] ?? DEFAULTS[key]); $("autoMode").checked = s.mode === "auto"; }
async function save() { const settings = read(); await chrome.storage.local.set({ settings }); status("Настройки сохранены."); }
function read() { return { apiKey: $("apiKey").value.trim(), model: $("model").value.trim() || DEFAULTS.model, systemPrompt: $("systemPrompt").value.trim() || DEFAULTS.systemPrompt, mode: $("autoMode").checked ? "auto" : "draft", dailyLimit: number("dailyLimit", 10), minPostLength: number("minPostLength", 35), minDelaySec: number("minDelaySec", 45), maxDelaySec: number("maxDelaySec", 120) }; }
function number(id, fallback) { return Math.max(1, Number($(id).value) || fallback); }
async function messageTab(message) { await chrome.storage.local.set({ settings: read() }); const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (!tab?.id) return status("Не найдена активная вкладка."); const result = await chrome.tabs.sendMessage(tab.id, message).catch(() => ({ ok: false, error: "Откройте x.com и обновите страницу." })); status(result?.ok ? (result.completed ? `Готово: ${result.completed}.` : "Запущено.") : (result?.error || "Команда не выполнена.")); }
function status(text) { $("status").textContent = text; }
