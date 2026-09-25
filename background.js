chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onStartup?.addListener?.(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "STASH_OPEN_DECK") {
    const url = chrome.runtime.getURL("deck.html");
    chrome.tabs.create({ url }).then((tab) => sendResponse({ ok: true, tabId: tab.id })).catch((err) => {
      sendResponse({ ok: false, error: String(err) });
    });
    return true;
  }
});
