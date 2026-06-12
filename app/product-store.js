(function () {
  "use strict";

  let products = [];
  let loadingPromise = null;

  async function request(url, options = {}) {
    const response = await fetch(url, {
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
      ...options,
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload.error || "Не удалось выполнить запрос.");
    }

    return payload;
  }

  async function refresh() {
    loadingPromise = request("/api/products").then((nextProducts) => {
      products = nextProducts;
      return getCached();
    });

    return loadingPromise;
  }

  async function getAll() {
    if (products.length > 0) {
      return getCached();
    }

    return loadingPromise || refresh();
  }

  function getCached() {
    return products.map((product) => ({ ...product }));
  }

  function getById(id) {
    const product = products.find((item) => item.id === id);
    return product ? { ...product } : null;
  }

  async function create(product) {
    const created = await request("/api/admin/products", {
      method: "POST",
      body: JSON.stringify(product),
    });
    await refresh();
    return created;
  }

  async function update(id, changes) {
    const current = getById(id);

    if (!current) {
      throw new Error("Товар не найден.");
    }

    const updated = await request(`/api/admin/products/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({ ...current, ...changes, id }),
    });
    await refresh();
    return updated;
  }

  async function remove(id) {
    await request(`/api/admin/products/${encodeURIComponent(id)}`, { method: "DELETE" });
    await refresh();
  }

  async function reorder(productIds) {
    const reorderedProducts = await request("/api/admin/products/order", {
      method: "PUT",
      body: JSON.stringify({ productIds }),
    });
    products = reorderedProducts;
    return getCached();
  }

  function subscribe(listener) {
    const eventSource = new EventSource("/api/events");
    let stopped = false;

    eventSource.addEventListener("products", async () => {
      if (stopped) {
        return;
      }

      try {
        listener(await refresh());
      } catch (error) {
        console.error("Не удалось обновить товары.", error);
      }
    });

    return () => {
      stopped = true;
      eventSource.close();
    };
  }

  window.ProductStore = {
    getAll,
    getCached,
    getById,
    create,
    update,
    remove,
    reorder,
    refresh,
    subscribe,
  };
})();
