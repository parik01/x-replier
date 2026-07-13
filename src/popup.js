const Core = globalThis.XReplierCore;
const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", async () => {
  const { settings = Core.DEFAULT_SETTINGS, history } = await chrome.storage.local.get(["settings", "history"]);
  fill({ ...Core.DEFAULT_SETTINGS, ...settings }); renderHistory(Core.normalizeHistory(history)); await refreshJob();
  $("save").addEventListener("click", save);
  $("start").addEventListener("click", () => messageTab({ type: "START_REPLIER" }));
  $("stop").addEventListener("click", () => messageTab({ type: "STOP_REPLIER" }));
  $("test").addEventListener("click", testOpenAI);
  $("deleteKey").addEventListener("click", deleteKey);
  $("clearHistory").addEventListener("click", clearHistory);
  $("autoMode").addEventListener("change", toggleAutoConfirm);
});

function fill(s) { for (const key of ["apiKey", "model", "systemPrompt", "dailyLimit", "minDelaySec", "maxDelaySec", "minPostLength"]) $(key).value = s[key] ?? Core.DEFAULT_SETTINGS[key]; $("autoMode").checked = s.mode === "auto"; $("autoConfirmed").checked = Boolean(s.autoConfirmed); toggleAutoConfirm(); }
function toggleAutoConfirm() { $("autoConfirmRow").classList.toggle("hidden", !$("autoMode").checked); }
function read() { return { apiKey: $("apiKey").value.trim(), model: $("model").value.trim(), systemPrompt: $("systemPrompt").value.trim(), mode: $("autoMode").checked ? "auto" : "draft", autoConfirmed: $("autoMode").checked && $("autoConfirmed").checked, dailyLimit: $("dailyLimit").value, minPostLength: $("minPostLength").value, minDelaySec: $("minDelaySec").value, maxDelaySec: $("maxDelaySec").value }; }
async function save() { const result = Core.validateSettings(read()); if (!result.ok) return status(result.errors[0]); await chrome.storage.local.set({ settings: result.settings }); status("Настройки сохранены."); }
async function messageTab(payload) { const settings = Core.validateSettings(read()); if (!settings.ok) return status(settings.errors[0]); await chrome.storage.local.set({ settings: settings.settings }); const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (!tab?.id) return status("Не найдена активная вкладка."); const result = await chrome.tabs.sendMessage(tab.id, payload).catch(() => ({ ok: false, error: "Откройте x.com и обновите страницу." })); status(result?.ok ? (result.completed != null ? `Готово: ${result.completed}.` : "Команда выполнена.") : (result?.error || "Команда не выполнена.")); await refreshJob(); }
async function testOpenAI() { await save(); status("Проверяю OpenAI…"); const result = await chrome.runtime.sendMessage({ type: "TEST_OPENAI" }); status(result?.ok ? `OpenAI доступен: ${result.reply}` : (result?.error || "Проверка не удалась.")); }
async function deleteKey() { await chrome.runtime.sendMessage({ type: "DELETE_API_KEY" }); $("apiKey").value = ""; status("API key удалён из настроек."); }
async function clearHistory() { if (!confirm("Сбросить локальную историю обработанных постов?")) return; await chrome.runtime.sendMessage({ type: "CLEAR_HISTORY" }); renderHistory(Core.emptyHistory()); status("История сброшена."); }
async function refreshJob() { const result = await chrome.runtime.sendMessage({ type: "GET_JOB_STATUS" }); $("job").textContent = result?.job ? `Запущено в вкладке #${result.job.tabId}` : "Сейчас задач нет."; }
function renderHistory(history) { $("job").textContent = `Сегодня подтверждённых отправок: ${history.sentToday}/${readLimit()}`; }
function readLimit() { return Number($("dailyLimit").value) || Core.DEFAULT_SETTINGS.dailyLimit; }
function status(text) { $("status").textContent = text; }
