(() => {
  const Core = globalThis.XReplierCore;
  const Sel = globalThis.XReplierSelectors;
  let controller = null;
  let job = null;
  let heartbeat = null;
  let panel = null;
  let pendingChoice = null;

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === "START_REPLIER") { start().then(respond); return true; }
    if (message.type === "STOP_REPLIER") { stop("Остановлено пользователем."); respond({ ok: true }); }
  });

  async function start() {
    if (controller) return { ok: false, error: "Реплаер уже запущен в этой вкладке." };
    if (!/^(x|twitter)\.com$/i.test(location.hostname)) return { ok: false, error: "Откройте ленту на x.com." };
    const claimed = await message({ type: "CLAIM_JOB" });
    if (!claimed?.ok) return claimed || { ok: false, error: "Не удалось заблокировать задачу." };
    job = claimed.job;
    controller = new AbortController();
    heartbeat = setInterval(() => message({ type: "HEARTBEAT_JOB", jobId: job.id }), 10000);
    renderPanel();
    try {
      const { settings: rawSettings, history: rawHistory } = await chrome.storage.local.get(["settings", "history"]);
      const valid = Core.validateSettings(rawSettings);
      if (!valid.ok) throw new Error(valid.errors[0]);
      const settings = valid.settings;
      let history = Core.normalizeHistory(rawHistory);
      const available = settings.dailyLimit - history.sentToday;
      if (available <= 0) throw new Error("Дневной лимит уже исчерпан.");
      const queue = collectTargets(settings, history).slice(0, available);
      if (!queue.length) throw new Error("В видимой части ленты нет подходящих постов.");
      setPanel(`Найдено целей: ${queue.length}.`, { running: true });
      let completed = 0;
      for (let index = 0; index < queue.length; index += 1) {
        throwIfAborted();
        const target = queue[index];
        setPanel(`Цель ${index + 1}/${queue.length}: @${target.handle}. Генерирую…`, { running: true, target });
        const card = await findCardWhenAvailable(target.postId, controller.signal);
        if (!card) { history = await saveState(history, target.postId, "failed"); continue; }
        let response = await message({ type: "GENERATE_REPLY", postText: target.text });
        throwIfAborted();
        if (!response?.ok) { history = await saveState(history, target.postId, "failed"); setPanel(response?.error || "Не удалось создать черновик.", { running: true, target }); continue; }
        const composer = await openComposer(card, controller.signal);
        if (!composer) { history = await saveState(history, target.postId, "failed"); continue; }
        const inserted = setComposerText(composer, response.reply);
        if (!inserted.ok) { history = await saveState(history, target.postId, "failed"); setPanel(`Черновик не вставлен: ${inserted.error}`, { running: true, target }); continue; }
        history = await saveState(history, target.postId, "drafted");
        if (settings.mode === "draft") {
          setPanel("Черновик вставлен. Проверьте текст и выберите действие.", { draft: true, target, reply: inserted.actualText });
          const action = await waitForChoice(controller.signal);
          if (action === "sent") { history = await saveState(history, target.postId, "sent"); completed += 1; }
          if (action === "skip") history = await saveState(history, target.postId, "skipped");
          if (action === "next") setPanel("Черновик оставлен как черновик.", { running: true, target });
          continue;
        }
        const seconds = Core.randomDelay(settings.minDelaySec, settings.maxDelaySec);
        setPanel(`Черновик проверен. Автоотправка через ${seconds} сек…`, { running: true, target, countdown: seconds });
        await abortableDelay(seconds * 1000, controller.signal, (left) => setPanel(`Автоотправка через ${left} сек…`, { running: true, target, countdown: left }));
        throwIfAborted();
        history = await saveState(history, target.postId, "sending");
        const sent = await sendAndVerify(composer, controller.signal);
        if (sent.status === "sent") { history = await saveState(history, target.postId, "sent"); completed += 1; }
        else history = await saveState(history, target.postId, sent.status);
        setPanel(sent.message, { running: true, target });
      }
      setPanel(`Готово. Подтверждённых отправок: ${completed}.`, { finished: true });
      return { ok: true, completed };
    } catch (error) {
      const stopped = error.name === "AbortError";
      setPanel(stopped ? "Остановлено пользователем." : `Ошибка: ${error.message || error}`, { finished: true });
      return { ok: stopped, stopped, error: stopped ? undefined : (error.message || String(error)) };
    } finally { await cleanup(); }
  }

  function collectTargets(settings, history) {
    const ownHandle = Sel.getOwnHandle(); const seen = new Set();
    const targets = [];
    for (const card of document.querySelectorAll('article[data-testid="tweet"]')) {
      const post = Sel.candidateFromCard(card);
      if (!post || seen.has(post.postId)) continue;
      seen.add(post.postId);
      if (post.promoted || post.repost || post.reply || post.handle === ownHandle || post.text.length < settings.minPostLength || Core.isProcessed(history, post.postId)) continue;
      targets.push({ ...post, discoveredAt: Date.now(), state: "discovered" });
    }
    return targets;
  }

  async function findCardWhenAvailable(postId, signal) {
    const initial = Sel.findCard(postId); if (initial) return initial;
    return waitFor(() => Sel.findCard(postId), 5000, signal);
  }

  async function openComposer(card, signal) {
    const button = card.querySelector('[data-testid="reply"]');
    if (!button) return null;
    button.click();
    return waitFor(() => document.querySelector('[role="dialog"] [data-testid="tweetTextarea_0"], [data-testid="tweetTextarea_0"]'), 6000, signal);
  }

  function setComposerText(element, text) {
    const expected = String(text).trim();
    if (!expected) return { ok: false, error: "Пустой черновик." };
    clearEditor(element);
    const strategies = [
      () => { const data = new DataTransfer(); data.setData("text/plain", expected); element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data })); return "paste"; },
      () => { element.focus(); document.execCommand("insertText", false, expected); return "execCommand"; },
      () => { element.textContent = expected; element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: expected })); return "dom"; }
    ];
    for (const run of strategies) {
      clearEditor(element);
      try {
        const strategy = run(); const actualText = editorText(element);
        if (actualText === expected) return { ok: true, strategy, actualText };
      } catch (_) {}
    }
    return { ok: false, error: "X не подтвердил вставку текста." };
  }

  function clearEditor(element) {
    element.focus();
    const range = document.createRange(); range.selectNodeContents(element); range.collapse(false);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.execCommand("delete", false);
    if (editorText(element)) { element.replaceChildren(); element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" })); }
  }
  function editorText(element) { return (element.innerText || element.textContent || "").replace(/\r/g, "").trim(); }

  async function sendAndVerify(composer, signal) {
    const button = [...document.querySelectorAll('[role="dialog"]')].at(-1)?.querySelector('[data-testid="tweetButton"]') || document.querySelector('[data-testid="tweetButton"]');
    if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") return { status: "failed", message: "Кнопка отправки недоступна; черновик сохранён." };
    button.click();
    const result = await waitFor(() => {
      const error = [...document.querySelectorAll('[role="alert"]')].map((el) => el.innerText).find((text) => /error|ошибк|try again|повтор/i.test(text || ""));
      if (error) return { status: "failed", message: `X сообщил об ошибке: ${error}` };
      if (!document.contains(composer) || !composer.closest('[role="dialog"]')) return { status: "sent", message: "X закрыл редактор: отправка подтверждена." };
      return null;
    }, 10000, signal);
    return result || { status: "unknown", message: "Не удалось надёжно подтвердить отправку. Проверьте X вручную." };
  }

  async function saveState(history, postId, state) {
    const next = Core.applyPostState(history, postId, state);
    await chrome.storage.local.set({ history: next }); return next;
  }

  function stop(reason) {
    if (controller && !controller.signal.aborted) controller.abort(reason);
    pendingChoice?.("next"); pendingChoice = null;
  }
  function throwIfAborted() { if (controller?.signal.aborted) throw new DOMException("Stopped", "AbortError"); }
  async function cleanup() {
    if (heartbeat) clearInterval(heartbeat);
    if (job) await message({ type: "RELEASE_JOB", jobId: job.id });
    heartbeat = null; job = null; controller = null; pendingChoice = null;
  }
  function message(payload) { return chrome.runtime.sendMessage(payload); }

  function waitFor(find, timeout, signal) { return new Promise((resolve, reject) => { const end = Date.now() + timeout; const timer = setInterval(check, 120); const cancel = () => done(reject, new DOMException("Stopped", "AbortError")); signal?.addEventListener("abort", cancel, { once: true }); function done(fn, value) { clearInterval(timer); signal?.removeEventListener("abort", cancel); fn(value); } function check() { const value = find(); if (value) done(resolve, value); else if (Date.now() >= end) done(resolve, null); } check(); }); }
  function abortableDelay(ms, signal, onTick) { return new Promise((resolve, reject) => { const end = Date.now() + ms; const timer = setInterval(tick, 250); const cancel = () => done(reject, new DOMException("Stopped", "AbortError")); signal.addEventListener("abort", cancel, { once: true }); function done(fn, value) { clearInterval(timer); signal.removeEventListener("abort", cancel); fn(value); } function tick() { const left = Math.max(0, Math.ceil((end - Date.now()) / 1000)); onTick?.(left); if (left <= 0) done(resolve); } tick(); }); }

  function renderPanel() {
    if (panel) return; panel = document.createElement("aside"); panel.id = "x-replier-panel";
    panel.innerHTML = '<strong>X-replier</strong><p id="x-replier-status">Подготовка…</p><p id="x-replier-target"></p><div id="x-replier-actions"><button data-action="sent">Отправлено</button><button data-action="skip">Пропустить</button><button data-action="next">Следующий</button><button data-action="stop">Стоп</button></div>';
    panel.addEventListener("click", (event) => { const action = event.target.dataset.action; if (!action) return; if (action === "stop") stop(); else if (pendingChoice) { pendingChoice(action); pendingChoice = null; } }); document.body.append(panel);
  }
  function setPanel(text, options = {}) { renderPanel(); panel.querySelector("#x-replier-status").textContent = text; panel.querySelector("#x-replier-target").textContent = options.target ? `@${options.target.handle} · ${options.target.postId}` : ""; const actions = panel.querySelector("#x-replier-actions"); actions.classList.toggle("draft", Boolean(options.draft)); actions.querySelector('[data-action="stop"]').style.display = options.finished ? "none" : "inline-block"; }
  function waitForChoice(signal) { return new Promise((resolve, reject) => { const cancel = () => { pendingChoice = null; reject(new DOMException("Stopped", "AbortError")); }; pendingChoice = (action) => { signal.removeEventListener("abort", cancel); resolve(action); }; signal.addEventListener("abort", cancel, { once: true }); }); }
})();
