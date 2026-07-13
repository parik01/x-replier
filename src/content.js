(() => {
  const DEFAULTS = { mode: "draft", dailyLimit: 10, minDelaySec: 45, maxDelaySec: 120, minPostLength: 35 };
  let running = false;
  let stopRequested = false;

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === "START_REPLIER") {
      start().then(respond);
      return true;
    }
    if (message.type === "STOP_REPLIER") {
      stopRequested = true;
      respond({ ok: true });
    }
  });

  async function start() {
    if (running) return { ok: false, error: "Реплаер уже запущен в этой вкладке." };
    if (!/^(x|twitter)\.com$/i.test(location.hostname)) return { ok: false, error: "Откройте ленту на x.com." };
    running = true;
    stopRequested = false;
    try {
      const { settings = DEFAULTS, history = {} } = await chrome.storage.local.get(["settings", "history"]);
      const today = new Date().toISOString().slice(0, 10);
      const sentToday = history.day === today ? Number(history.sentToday || 0) : 0;
      const slots = Math.max(0, Number(settings.dailyLimit || 0) - sentToday);
      if (!slots) return { ok: false, error: "Дневной лимит уже исчерпан." };
      const targets = collectTargets(settings, history.replied || {}).slice(0, slots);
      if (!targets.length) return { ok: false, error: "В видимой части ленты нет подходящих постов." };
      showStatus(`Найдено постов: ${targets.length}`);
      let completed = 0;
      for (const target of targets) {
        if (stopRequested) break;
        showStatus(`Генерирую ответ ${completed + 1}/${targets.length}…`);
        const generated = await chrome.runtime.sendMessage({ type: "GENERATE_REPLY", postText: target.text });
        if (!generated?.ok) throw new Error(generated?.error || "Не удалось сгенерировать ответ.");
        const composer = await openComposer(target.card);
        if (!composer) { showStatus("Не удалось открыть редактор ответа; пост пропущен."); continue; }
        setComposerText(composer, generated.reply);
        if (settings.mode === "auto") {
          const seconds = randomInt(Number(settings.minDelaySec), Number(settings.maxDelaySec));
          showStatus(`Черновик готов. Автоотправка через ${seconds} сек…`);
          await delay(seconds * 1000);
          if (stopRequested) break;
          const sent = clickSend();
          if (!sent) { showStatus("Кнопка «Ответить» не найдена; черновик оставлен для ручной отправки."); break; }
          await remember(target.id, today, sentToday + completed + 1);
          completed += 1;
          await delay(1300);
        } else {
          await remember(target.id, today, sentToday + completed + 1);
          completed += 1;
          showStatus("Черновик вставлен. Проверьте и отправьте его вручную.");
          break;
        }
      }
      return { ok: true, completed, stopped: stopRequested };
    } catch (error) {
      showStatus(`Ошибка: ${error.message || error}`);
      return { ok: false, error: error.message || String(error) };
    } finally { running = false; }
  }

  function collectTargets(settings, replied) {
    const seen = new Set();
    const ownHandle = getOwnHandle();
    return [...document.querySelectorAll('article[data-testid="tweet"]')].map((card) => {
      const link = [...card.querySelectorAll('a[href*="/status/"]')].find(a => /\/[A-Za-z0-9_]+\/status\/\d+/.test(a.getAttribute("href") || ""));
      const match = (link?.getAttribute("href") || "").match(/\/([A-Za-z0-9_]+)\/status\/(\d+)/);
      const text = [...card.querySelectorAll('[data-testid="tweetText"]')].map(el => el.innerText).join("\n").trim();
      const cardText = card.innerText || "";
      return { card, id: match?.[2], handle: match?.[1]?.toLowerCase(), text, promoted: /\bPromoted\b|Реклама/i.test(cardText), repost: /\bReposted\b|Репост/i.test(cardText), reply: /^Replying to|^В ответ/i.test(cardText) };
    }).filter((post) => post.id && post.text.length >= Number(settings.minPostLength || 35) && !post.promoted && !post.repost && !post.reply && post.handle !== ownHandle && !replied[post.id] && !seen.has(post.id) && seen.add(post.id));
  }

  function getOwnHandle() {
    const profile = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    return (profile?.getAttribute("href") || "").replace(/^\//, "").toLowerCase();
  }

  async function openComposer(card) {
    const button = card.querySelector('[data-testid="reply"]');
    if (!button) return null;
    button.click();
    return waitFor(() => document.querySelector('[role="dialog"] [data-testid="tweetTextarea_0"], [data-testid="tweetTextarea_0"]'), 6000);
  }

  function setComposerText(element, text) {
    element.focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges(); selection.addRange(range);
    try {
      const data = new DataTransfer(); data.setData("text/plain", text);
      element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
    } catch (_) {
      document.execCommand("insertText", false, text);
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    }
  }

  function clickSend() {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')];
    const scope = dialogs.at(-1) || document;
    const button = scope.querySelector('[data-testid="tweetButton"]');
    if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") return false;
    button.click(); return true;
  }

  async function remember(id, day, count) {
    const { history = {} } = await chrome.storage.local.get("history");
    const replied = history.replied || {};
    replied[id] = Date.now();
    const ids = Object.entries(replied).sort((a, b) => b[1] - a[1]).slice(0, 3000);
    await chrome.storage.local.set({ history: { day, sentToday: count, replied: Object.fromEntries(ids) } });
  }

  function waitFor(find, timeout) { return new Promise(resolve => { const until = Date.now() + timeout; const id = setInterval(() => { const el = find(); if (el || Date.now() > until) { clearInterval(id); resolve(el || null); } }, 150); }); }
  function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  function randomInt(min, max) { min = Math.max(1, min || 1); max = Math.max(min, max || min); return Math.floor(min + Math.random() * (max - min + 1)); }
  function showStatus(text) { let el = document.getElementById("x-replier-status"); if (!el) { el = document.createElement("div"); el.id = "x-replier-status"; document.body.append(el); } el.textContent = `X-replier: ${text}`; }
})();
