
let authV3Cache = null;
let lastXsupplierid = null;

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const headers = details.requestHeaders || [];
    for (const h of headers) {
      const name = (h.name || "").toLowerCase();
      if (name === "authorizev3" && h.value) {
        authV3Cache = h.value;
        chrome.storage.local.set({ authorizev3: authV3Cache });
        console.log("[WB-EXT] captured authorizev3");
      }
      if (name === "x-supplierid" && h.value) {
        lastXsupplierid = h.value;
        chrome.storage.local.set({ lastXsupplierid });
        console.log("[WB-EXT] captured x-supplierid:", lastXsupplierid);
      }
    }
  },
  { urls: ["https://cmp.wildberries.ru/*"] },
  ["requestHeaders","extraHeaders"]
);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "GET_COOKIES") {
    const domains = ["cmp.wildberries.ru", "wildberries.ru"];
    let found = {};
    let pending = domains.length;
    domains.forEach(domain => {
      chrome.cookies.getAll({ domain }, (list) => {
        for (const c of list) found[c.name] = c.value;
        pending--;
        if (pending === 0) {
          sendResponse({ ok: true, cookies: found });
        }
      });
    });
    return true;
  }

  if (msg?.type === "GET_AUTHV3") {
    chrome.storage.local.get(["authorizev3","lastXsupplierid"], (res) => {
      sendResponse({ ok: true, authorizev3: res.authorizev3 || authV3Cache || null, lastXsupplierid: res.lastXsupplierid || lastXsupplierid || null });
    });
    return true;
  }
});
