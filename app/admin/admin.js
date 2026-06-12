(function () {
  "use strict";

  const loginScreen = document.querySelector("[data-login-screen]");
  const loginForm = document.querySelector("[data-login-form]");
  const loginMessage = document.querySelector("[data-login-message]");
  const adminApp = document.querySelector("[data-admin-app]");
  const productsContainer = document.querySelector("[data-admin-products]");
  const ordersContainer = document.querySelector("[data-admin-orders]");
  const activeOrdersCount = document.querySelector("[data-active-orders-count]");
  const historyOrdersCount = document.querySelector("[data-history-orders-count]");
  const orderTabs = document.querySelectorAll("[data-orders-view]");
  const adminMessage = document.querySelector("[data-admin-message]");
  const modal = document.querySelector("[data-product-modal]");
  const passwordModal = document.querySelector("[data-password-modal]");
  const passwordForm = document.querySelector("[data-password-form]");
  const passwordMessage = document.querySelector("[data-password-message]");
  const productForm = document.querySelector("[data-product-form]");
  const productFormMessage = document.querySelector("[data-product-form-message]");
  const formTitle = document.querySelector("[data-form-title]");

  let products = [];
  let orders = [];
  let ordersView = "active";
  let uploadedImage = "";
  let draggedProductId = null;

  const formatPrice = (price) =>
    new Intl.NumberFormat("ru-RU", {
      style: "currency",
      currency: "RUB",
      maximumFractionDigits: 0,
    }).format(price);

  const escapeHtml = (value) => {
    const element = document.createElement("div");
    element.textContent = value;
    return element.innerHTML;
  };

  const ORDER_STATUS_LABELS = {
    new: "Новый",
    preparing: "Готовится",
    ready: "Готов к выдаче",
    completed: "Выдан",
    cancelled: "Отменён",
  };

  const formatDateTime = (value) =>
    new Intl.DateTimeFormat("ru-RU", {
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(value));

  function resolveAdminImage(image) {
    if (/^(data:|https?:|\/)/.test(image)) {
      return image;
    }

    return `../${image}`;
  }

  function showAdminMessage(message, type = "success") {
    adminMessage.textContent = message;
    adminMessage.className = `form-message admin-notice is-${type}`;
  }

  function updateSummary() {
    document.querySelector("[data-total-products]").textContent = String(products.length);
    document.querySelector("[data-total-stock]").textContent = String(
      products.reduce((sum, product) => sum + product.stock, 0)
    );
    document.querySelector("[data-out-of-stock]").textContent = String(
      products.filter((product) => product.stock === 0).length
    );
  }

  function renderProducts() {
    updateSummary();

    if (products.length === 0) {
      productsContainer.innerHTML = '<p class="empty-state">Товаров пока нет. Добавьте первую позицию.</p>';
      return;
    }

    productsContainer.innerHTML = products
      .map(
        (product, index) => `
          <article
            class="admin-product"
            data-product-id="${escapeHtml(product.id)}"
            draggable="true"
          >
            <div class="admin-product__reorder" aria-label="Изменить позицию товара">
              <button
                class="reorder-button drag-handle"
                type="button"
                title="Перетащить товар"
                aria-label="Перетащить товар"
              >⋮⋮</button>
              <button
                class="reorder-button"
                type="button"
                data-move-product="up"
                aria-label="Поднять товар"
                ${index === 0 ? "disabled" : ""}
              >↑</button>
              <button
                class="reorder-button"
                type="button"
                data-move-product="down"
                aria-label="Опустить товар"
                ${index === products.length - 1 ? "disabled" : ""}
              >↓</button>
            </div>
            <img src="${escapeHtml(resolveAdminImage(product.image))}" alt="${escapeHtml(product.name)}" width="96" height="96" loading="lazy" decoding="async">
            <div class="admin-product__info">
              <div>
                <h3>${escapeHtml(product.name)}</h3>
                <p>${escapeHtml(product.description)}</p>
              </div>
              <span>${formatPrice(product.price)} · ${product.stock > 0 ? `${product.stock} шт.` : "нет в наличии"}</span>
            </div>
            <label class="compact-field">
              <span>Цена, ₽</span>
              <input type="number" min="0" step="1" value="${product.price}" data-quick-price>
            </label>
            <label class="compact-field">
              <span>Остаток</span>
              <input type="number" min="0" step="1" value="${product.stock}" data-quick-stock>
            </label>
            <div class="admin-product__actions">
              <button class="button small-button" type="button" data-quick-save>Сохранить</button>
              <button class="text-button" type="button" data-edit-product>Редактировать</button>
              <button class="text-button is-danger" type="button" data-delete-product>Удалить</button>
            </div>
          </article>
        `
      )
      .join("");
  }

  function renderOrders() {
    const activeOrders = orders.filter(
      (order) => order.status !== "completed" && order.status !== "cancelled"
    );
    const historyOrders = orders.filter(
      (order) => order.status === "completed" || order.status === "cancelled"
    );
    const visibleOrders = ordersView === "history" ? historyOrders : activeOrders;

    activeOrdersCount.textContent = String(activeOrders.length);
    historyOrdersCount.textContent = String(historyOrders.length);
    orderTabs.forEach((tab) => {
      const isActive = tab.dataset.ordersView === ordersView;
      tab.classList.toggle("is-active", isActive);
      tab.setAttribute("aria-pressed", String(isActive));
    });

    if (visibleOrders.length === 0) {
      ordersContainer.innerHTML =
        ordersView === "history"
          ? '<p class="empty-state">История заказов пока пуста.</p>'
          : '<p class="empty-state">Активных заказов пока нет. Новые заказы появятся здесь автоматически.</p>';
      return;
    }

    ordersContainer.innerHTML = visibleOrders
      .map((order) => {
        const statusOptions = Object.entries(ORDER_STATUS_LABELS)
          .map(
            ([status, label]) =>
              `<option value="${status}" ${order.status === status ? "selected" : ""}>${label}</option>`
          )
          .join("");
        const items = order.items
          .map(
            (item) =>
              `<li><span>${escapeHtml(item.name)} × ${item.quantity}</span><strong>${formatPrice(
                item.price * item.quantity
              )}</strong></li>`
          )
          .join("");
        const isFinal = order.status === "completed" || order.status === "cancelled";

        return `
          <article class="admin-order status-${escapeHtml(order.status)}" data-order-id="${escapeHtml(order.id)}">
            <div class="admin-order__header">
              <div>
                <span class="order-number">${escapeHtml(order.number)}</span>
                <time datetime="${escapeHtml(order.createdAt)}">${formatDateTime(order.createdAt)}</time>
              </div>
              <label class="order-status">
                <span>Статус</span>
                <select data-order-status ${isFinal ? "disabled" : ""}>
                  ${statusOptions}
                </select>
              </label>
            </div>
            <div class="admin-order__customer">
              <strong>${escapeHtml(order.customer.name)}</strong>
              <a href="tel:${escapeHtml(order.customer.phone)}">${escapeHtml(order.customer.phone)}</a>
              ${
                order.customer.pickupTime
                  ? `<span>Заберёт: ${escapeHtml(order.customer.pickupTime)}</span>`
                  : ""
              }
              ${
                order.customer.comment
                  ? `<p>Комментарий: ${escapeHtml(order.customer.comment)}</p>`
                  : ""
              }
            </div>
            <ul class="admin-order__items">${items}</ul>
            <div class="admin-order__total">
              <span>${order.itemCount} шт.</span>
              <strong>${formatPrice(order.total)}</strong>
            </div>
          </article>
        `;
      })
      .join("");
  }

  async function loadProducts() {
    products = await window.ProductStore.refresh();
    renderProducts();
  }

  async function loadOrders() {
    orders = await window.OrderStore.getAll();
    renderOrders();
  }

  function showAuthenticatedState(authenticated) {
    loginScreen.hidden = authenticated;
    adminApp.hidden = !authenticated;
  }

  function openProductModal(product = null) {
    uploadedImage = "";
    productForm.reset();
    productFormMessage.textContent = "";
    productForm.elements.id.value = product?.id || "";
    productForm.elements.name.value = product?.name || "";
    productForm.elements.category.value = product?.category || "bread";
    productForm.elements.price.value = product?.price ?? 0;
    productForm.elements.stock.value = product?.stock ?? 0;
    productForm.elements.description.value = product?.description || "";
    productForm.elements.image.value = product?.image || "assets/bakery-1.jfif";
    formTitle.textContent = product ? "Редактировать товар" : "Новый товар";
    modal.hidden = false;
    document.body.classList.add("modal-open");
    productForm.elements.name.focus();
  }

  function closeProductModal() {
    modal.hidden = true;
    document.body.classList.remove("modal-open");
  }

  function openPasswordModal() {
    passwordForm.reset();
    passwordMessage.textContent = "";
    passwordModal.hidden = false;
    document.body.classList.add("modal-open");
    passwordForm.elements.currentPassword.focus();
  }

  function closePasswordModal() {
    passwordModal.hidden = true;
    document.body.classList.remove("modal-open");
  }

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = loginForm.querySelector('[type="submit"]');
    const formData = new FormData(loginForm);
    submitButton.disabled = true;

    try {
      await window.AdminAuth.login(
        String(formData.get("username")),
        String(formData.get("password"))
      );
      loginMessage.textContent = "";
      loginForm.reset();
      showAuthenticatedState(true);
      await Promise.all([loadProducts(), loadOrders()]);
    } catch (error) {
      loginMessage.textContent = error.message;
      loginMessage.className = "form-message is-error";
    } finally {
      submitButton.disabled = false;
    }
  });

  document.querySelector("[data-logout]").addEventListener("click", async () => {
    await window.AdminAuth.logout();
    showAuthenticatedState(false);
  });

  document
    .querySelector("[data-open-password-modal]")
    .addEventListener("click", openPasswordModal);

  document.querySelectorAll("[data-close-password-modal]").forEach((button) => {
    button.addEventListener("click", closePasswordModal);
  });

  passwordForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = passwordForm.querySelector('[type="submit"]');
    const formData = new FormData(passwordForm);
    const currentPassword = String(formData.get("currentPassword"));
    const newPassword = String(formData.get("newPassword"));
    const confirmPassword = String(formData.get("confirmPassword"));

    if (newPassword !== confirmPassword) {
      passwordMessage.textContent = "Новые пароли не совпадают.";
      passwordMessage.className = "form-message is-error";
      return;
    }

    submitButton.disabled = true;
    try {
      await window.AdminAuth.changePassword(currentPassword, newPassword);
      closePasswordModal();
      showAuthenticatedState(false);
      loginMessage.textContent = "Пароль изменён. Войдите с новым паролем.";
      loginMessage.className = "form-message is-success";
    } catch (error) {
      passwordMessage.textContent = error.message;
      passwordMessage.className = "form-message is-error";
    } finally {
      submitButton.disabled = false;
    }
  });

  document.querySelector("[data-add-product]").addEventListener("click", () => {
    openProductModal();
  });

  document.querySelectorAll("[data-close-modal]").forEach((button) => {
    button.addEventListener("click", closeProductModal);
  });

  productsContainer.addEventListener("click", async (event) => {
    const productElement = event.target.closest("[data-product-id]");
    if (!productElement) {
      return;
    }

    const productId = productElement.dataset.productId;
    const actionButton = event.target.closest("button");
    const moveButton = event.target.closest("[data-move-product]");

    if (moveButton) {
      const currentIndex = products.findIndex((product) => product.id === productId);
      const offset = moveButton.dataset.moveProduct === "up" ? -1 : 1;
      const nextIndex = currentIndex + offset;

      if (currentIndex < 0 || nextIndex < 0 || nextIndex >= products.length) {
        return;
      }

      const productIds = products.map((product) => product.id);
      [productIds[currentIndex], productIds[nextIndex]] = [
        productIds[nextIndex],
        productIds[currentIndex],
      ];
      moveButton.disabled = true;

      try {
        products = await window.ProductStore.reorder(productIds);
        renderProducts();
        showAdminMessage("Порядок товаров сохранён.");
      } catch (error) {
        showAdminMessage(error.message, "error");
        moveButton.disabled = false;
      }
      return;
    }

    if (event.target.closest("[data-quick-save]")) {
      const price = Number(productElement.querySelector("[data-quick-price]").value);
      const stock = Number(productElement.querySelector("[data-quick-stock]").value);
      actionButton.disabled = true;

      try {
        await window.ProductStore.update(productId, { price, stock });
        products = window.ProductStore.getCached();
        renderProducts();
        showAdminMessage("Цена и остаток сохранены.");
      } catch (error) {
        showAdminMessage(error.message, "error");
        actionButton.disabled = false;
      }
      return;
    }

    if (event.target.closest("[data-edit-product]")) {
      const product = products.find((item) => item.id === productId);
      if (product) {
        openProductModal(product);
      }
      return;
    }

    if (event.target.closest("[data-delete-product]")) {
      const product = products.find((item) => item.id === productId);
      if (product && window.confirm(`Удалить товар «${product.name}»?`)) {
        actionButton.disabled = true;
        try {
          await window.ProductStore.remove(productId);
          products = window.ProductStore.getCached();
          renderProducts();
          showAdminMessage("Товар удалён.");
        } catch (error) {
          showAdminMessage(error.message, "error");
          actionButton.disabled = false;
        }
      }
    }
  });

  ordersContainer.addEventListener("change", async (event) => {
    const select = event.target.closest("[data-order-status]");
    const orderElement = event.target.closest("[data-order-id]");

    if (!select || !orderElement) {
      return;
    }

    const order = orders.find((item) => item.id === orderElement.dataset.orderId);
    const previousStatus = order?.status;
    const nextStatus = select.value;

    if (!order || previousStatus === nextStatus) {
      return;
    }

    if (
      nextStatus === "cancelled" &&
      !window.confirm(`Отменить заказ ${order.number} и вернуть товары в остатки?`)
    ) {
      select.value = previousStatus;
      return;
    }

    select.disabled = true;

    try {
      await window.OrderStore.updateStatus(order.id, nextStatus);
      await Promise.all([loadOrders(), loadProducts()]);
      showAdminMessage(`Статус заказа ${order.number} обновлён.`);
    } catch (error) {
      select.value = previousStatus;
      select.disabled = false;
      showAdminMessage(error.message, "error");
    }
  });

  orderTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      ordersView = tab.dataset.ordersView;
      renderOrders();
    });
  });

  productsContainer.addEventListener("dragstart", (event) => {
    const productElement = event.target.closest("[data-product-id]");

    if (!productElement) {
      return;
    }

    draggedProductId = productElement.dataset.productId;
    productElement.classList.add("is-dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggedProductId);
  });

  productsContainer.addEventListener("dragover", (event) => {
    const targetElement = event.target.closest("[data-product-id]");

    if (!targetElement || targetElement.dataset.productId === draggedProductId) {
      return;
    }

    event.preventDefault();
    const bounds = targetElement.getBoundingClientRect();
    const insertAfter = event.clientY > bounds.top + bounds.height / 2;

    productsContainer
      .querySelectorAll(".is-drag-over-before, .is-drag-over-after")
      .forEach((element) => {
        element.classList.remove("is-drag-over-before", "is-drag-over-after");
      });
    targetElement.classList.add(insertAfter ? "is-drag-over-after" : "is-drag-over-before");
  });

  productsContainer.addEventListener("drop", async (event) => {
    const targetElement = event.target.closest("[data-product-id]");

    if (!targetElement || !draggedProductId) {
      return;
    }

    event.preventDefault();
    const targetId = targetElement.dataset.productId;
    const bounds = targetElement.getBoundingClientRect();
    const insertAfter = event.clientY > bounds.top + bounds.height / 2;
    const productIds = products
      .map((product) => product.id)
      .filter((productId) => productId !== draggedProductId);
    let targetIndex = productIds.indexOf(targetId);

    if (insertAfter) {
      targetIndex += 1;
    }

    productIds.splice(targetIndex, 0, draggedProductId);

    try {
      products = await window.ProductStore.reorder(productIds);
      renderProducts();
      showAdminMessage("Порядок товаров сохранён.");
    } catch (error) {
      showAdminMessage(error.message, "error");
    }
  });

  productsContainer.addEventListener("dragend", () => {
    draggedProductId = null;
    productsContainer
      .querySelectorAll(".is-dragging, .is-drag-over-before, .is-drag-over-after")
      .forEach((element) => {
        element.classList.remove(
          "is-dragging",
          "is-drag-over-before",
          "is-drag-over-after"
        );
      });
  });

  productForm.elements.imageFile.addEventListener("change", (event) => {
    const [file] = event.target.files;

    if (!file) {
      uploadedImage = "";
      return;
    }

    if (file.size > 1024 * 1024) {
      productFormMessage.textContent = "Фото больше 1 МБ. Выберите файл меньшего размера.";
      productFormMessage.className = "form-message form-field--wide is-error";
      event.target.value = "";
      return;
    }

    const reader = new FileReader();
    reader.addEventListener("load", () => {
      uploadedImage = String(reader.result);
      productFormMessage.textContent = "Новое фото готово к сохранению.";
      productFormMessage.className = "form-message form-field--wide is-success";
    });
    reader.readAsDataURL(file);
  });

  productForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = productForm.querySelector('[type="submit"]');
    const formData = new FormData(productForm);
    const existingId = String(formData.get("id") || "");
    const product = {
      name: String(formData.get("name")),
      category: String(formData.get("category")),
      price: Number(formData.get("price")),
      stock: Number(formData.get("stock")),
      description: String(formData.get("description")),
      image: uploadedImage || String(formData.get("image") || "assets/bakery-1.jfif"),
    };
    submitButton.disabled = true;

    try {
      if (existingId) {
        await window.ProductStore.update(existingId, product);
        showAdminMessage("Товар обновлён.");
      } else {
        await window.ProductStore.create(product);
        showAdminMessage("Новый товар добавлен.");
      }

      products = window.ProductStore.getCached();
      renderProducts();
      closeProductModal();
    } catch (error) {
      productFormMessage.textContent = error.message;
      productFormMessage.className = "form-message form-field--wide is-error";
    } finally {
      submitButton.disabled = false;
    }
  });

  window.ProductStore.subscribe((nextProducts) => {
    products = nextProducts;
    if (!adminApp.hidden) {
      renderProducts();
    }
  });

  window.OrderStore.subscribe(() => {
    if (!adminApp.hidden) {
      loadOrders().catch((error) => showAdminMessage(error.message, "error"));
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.hidden) {
      closeProductModal();
    } else if (event.key === "Escape" && !passwordModal.hidden) {
      closePasswordModal();
    }
  });

  async function initialize() {
    try {
      const session = await window.AdminAuth.getSession();
      showAuthenticatedState(session.authenticated);

      if (session.authenticated) {
        await Promise.all([loadProducts(), loadOrders()]);
      }
    } catch (error) {
      showAuthenticatedState(false);
      loginMessage.textContent = "Сервер недоступен. Запустите проект командой node server.js.";
      loginMessage.className = "form-message is-error";
    }
  }

  initialize();
})();
