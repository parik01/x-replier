(() => {
  function parseStatusHref(href) {
    const match = String(href || "").match(/^\/([A-Za-z0-9_]+)\/status\/(\d+)/);
    return match ? { handle: match[1].toLowerCase(), postId: match[2], postUrl: `https://x.com/${match[1]}/status/${match[2]}` } : null;
  }

  function getOwnHandle(doc = document) {
    const link = doc.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    return (link?.getAttribute("href") || "").replace(/^\//, "").toLowerCase();
  }

  function textOf(card) {
    return [...card.querySelectorAll('[data-testid="tweetText"]')].filter((el) => !el.closest('div[role="link"][tabindex="0"]')).map((el) => el.innerText || el.textContent || "").join("\n").trim();
  }

  function isReplyCard(card, postId) {
    const head = (card.innerText || "").slice(0, 240);
    const root = location.pathname.match(/\/status\/(\d+)/)?.[1];
    return Boolean(root && root !== postId) || /(^|\n)\s*(Replying to|В ответ)/i.test(head);
  }

  function candidateFromCard(card) {
    const anchor = [...card.querySelectorAll('a[href*="/status/"]')].find((link) => parseStatusHref(link.getAttribute("href")));
    const meta = parseStatusHref(anchor?.getAttribute("href"));
    if (!meta) return null;
    const allText = card.innerText || "";
    return { ...meta, text: textOf(card), promoted: /\bPromoted\b|\bAd\b|Реклама/i.test(allText), repost: /(^|\n).*?(Reposted|Retweeted|Репост)/i.test(allText), reply: isReplyCard(card, meta.postId) };
  }

  function findCard(postId, doc = document) {
    return [...doc.querySelectorAll('article[data-testid="tweet"]')].find((card) => candidateFromCard(card)?.postId === String(postId)) || null;
  }

  globalThis.XReplierSelectors = { parseStatusHref, getOwnHandle, candidateFromCard, findCard };
  if (typeof module !== "undefined") module.exports = globalThis.XReplierSelectors;
})();
