document.addEventListener("DOMContentLoaded", async () => {
  const cfg = await chrome.storage.local.get(["apiUrl", "apiKey", "connected"]);
  document.getElementById("url").value = cfg.apiUrl || "https://pezant.ca/api/browser-agent";
  document.getElementById("key").value = cfg.apiKey || "";

  // Check connection status via background
  updateStatus();

  document.getElementById("save").addEventListener("click", async () => {
    const apiUrl = document.getElementById("url").value.trim();
    const apiKey = document.getElementById("key").value.trim();
    await chrome.storage.local.set({ apiUrl, apiKey });
    updateStatus();
  });
});

async function updateStatus() {
  // Ping the relay to check connection
  const cfg = await chrome.storage.local.get(["apiUrl", "apiKey"]);
  const el = document.getElementById("status");
  if (!cfg.apiKey) {
    el.textContent = "Not configured";
    el.className = "status disconnected";
    return;
  }
  try {
    const resp = await fetch(`${cfg.apiUrl}/ext/status`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
    });
    if (resp.ok) {
      el.textContent = "Connected";
      el.className = "status connected";
    } else {
      el.textContent = "Auth failed";
      el.className = "status disconnected";
    }
  } catch {
    el.textContent = "Unreachable";
    el.className = "status disconnected";
  }
}
