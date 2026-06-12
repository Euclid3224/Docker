(function () {
  "use strict";

  async function request(url, options = {}) {
    const response = await fetch(url, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload.error || "Не удалось выполнить запрос.");
    }

    return payload;
  }

  function create(items, customer) {
    return request("/api/orders", {
      method: "POST",
      body: JSON.stringify({ items, customer }),
    });
  }

  function getAll() {
    return request("/api/admin/orders");
  }

  function updateStatus(id, status) {
    return request(`/api/admin/orders/${encodeURIComponent(id)}/status`, {
      method: "PUT",
      body: JSON.stringify({ status }),
    });
  }

  function subscribe(listener) {
    const eventSource = new EventSource("/api/events");
    eventSource.addEventListener("orders", listener);
    return () => eventSource.close();
  }

  window.OrderStore = { create, getAll, updateStatus, subscribe };
})();
