(function () {
  "use strict";

  const CATEGORY_LABELS = {
    all: "Все",
    bread: "Хлеб",
    pastry: "Выпечка",
    drinks: "Напитки",
    desserts: "Десерты",
    other: "Другое",
  };

  const catalog = document.querySelector("[data-product-catalog]");
  const tabs = document.querySelector("[data-category-tabs]");
  const emptyState = document.querySelector("[data-empty-state]");
  const cartDrawer = document.querySelector("[data-cart-drawer]");
  const cartBackdrop = document.querySelector("[data-cart-backdrop]");
  const cartItems = document.querySelector("[data-cart-items]");
  const cartEmpty = document.querySelector("[data-cart-empty]");
  const cartTotal = document.querySelector("[data-cart-total]");
  const cartToggleTotal = document.querySelector("[data-cart-toggle-total]");
  const cartCount = document.querySelector("[data-cart-count]");
  const checkoutButton = document.querySelector("[data-checkout]");
  const checkoutMessage = document.querySelector("[data-checkout-message]");
  const orderForm = document.querySelector("[data-order-form]");
  const orderCancelButton = document.querySelector("[data-order-cancel]");
  const cartToggle = document.querySelector("[data-cart-toggle]");
  const pageRegions = document.querySelectorAll(
    ".site-header, main, .site-footer"
  );

  if (!catalog || !window.ProductStore || !window.OrderStore) {
    return;
  }

  let products = [];
  let activeCategory = "all";
  let cartReturnFocus = null;
  const CART_STORAGE_KEY = "teply-hleb-cart";
  const cart = new Map();
  const focusableSelector = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");

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

  function getStockLabel(stock) {
    if (stock === 0) {
      return "Нет в наличии";
    }

    if (stock <= 5) {
      return `Осталось ${stock} шт.`;
    }

    return `В наличии: ${stock} шт.`;
  }

  function renderTabs() {
    const productCategories = products.map((product) => product.category);
    const categories = ["all", ...new Set(productCategories)];

    if (!categories.includes(activeCategory)) {
      activeCategory = "all";
    }

    tabs.innerHTML = categories
      .map(
        (category) => `
          <button
            class="tab-button ${category === activeCategory ? "is-active" : ""}"
            type="button"
            data-category="${escapeHtml(category)}"
            aria-pressed="${category === activeCategory}"
          >
            ${escapeHtml(CATEGORY_LABELS[category] || category)}
          </button>
        `
      )
      .join("");
  }

  function renderProducts() {
    const visibleProducts =
      activeCategory === "all"
        ? products
        : products.filter((product) => product.category === activeCategory);

    emptyState.hidden = visibleProducts.length > 0;
    catalog.innerHTML = visibleProducts
      .map((product) => {
        const quantity = cart.get(product.id) || 0;
        const purchaseControl =
          product.stock === 0
            ? `
              <button class="button add-to-cart" type="button" disabled>
                Распродано
              </button>
            `
            : quantity > 0
              ? `
                <div class="card-quantity-control" aria-label="Количество товара в корзине">
                  <button
                    type="button"
                    data-product-decrease="${escapeHtml(product.id)}"
                    aria-label="Уменьшить количество ${escapeHtml(product.name)}"
                  >−</button>
                  <strong>${quantity}</strong>
                  <button
                    type="button"
                    data-product-increase="${escapeHtml(product.id)}"
                    aria-label="Увеличить количество ${escapeHtml(product.name)}"
                    ${quantity >= product.stock ? "disabled" : ""}
                  >+</button>
                </div>
              `
              : `
                <button
                  class="button add-to-cart"
                  type="button"
                  data-add-product="${escapeHtml(product.id)}"
                >
                  В корзину
                </button>
              `;

        return `
          <article class="catalog-card">
            <img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.name)}" width="640" height="440" loading="lazy" decoding="async">
            <div class="catalog-card__body">
              <div class="catalog-card__topline">
                <span class="stock-badge ${product.stock === 0 ? "is-empty" : ""}">
                  ${getStockLabel(product.stock)}
                </span>
                <strong class="catalog-price">${formatPrice(product.price)}</strong>
              </div>
              <h3>${escapeHtml(product.name)}</h3>
              <p>${escapeHtml(product.description)}</p>
              ${purchaseControl}
            </div>
          </article>
        `;
      })
      .join("");
  }

  function reconcileCart() {
    cart.forEach((quantity, productId) => {
      const product = products.find((item) => item.id === productId);

      if (!product || product.stock === 0) {
        cart.delete(productId);
      } else if (quantity > product.stock) {
        cart.set(productId, product.stock);
      }
    });
  }

  function restoreCart() {
    try {
      const savedCart = JSON.parse(localStorage.getItem(CART_STORAGE_KEY) || "[]");

      if (!Array.isArray(savedCart)) {
        return;
      }

      savedCart.forEach(([productId, quantity]) => {
        const normalizedQuantity = Number(quantity);
        if (typeof productId === "string" && Number.isInteger(normalizedQuantity)) {
          cart.set(productId, normalizedQuantity);
        }
      });
    } catch {
      localStorage.removeItem(CART_STORAGE_KEY);
    }
  }

  function saveCart() {
    try {
      localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(Array.from(cart.entries())));
    } catch {
      // The cart still works when browser storage is unavailable.
    }
  }

  function renderCart() {
    reconcileCart();
    const lines = Array.from(cart.entries())
      .map(([productId, quantity]) => {
        const product = products.find((item) => item.id === productId);
        return product ? { product, quantity } : null;
      })
      .filter(Boolean);

    const itemCount = lines.reduce((sum, line) => sum + line.quantity, 0);
    const total = lines.reduce((sum, line) => sum + line.product.price * line.quantity, 0);

    cartCount.textContent = String(itemCount);
    cartTotal.textContent = formatPrice(total);
    cartToggleTotal.textContent = formatPrice(total);
    cartToggle.classList.toggle("has-items", itemCount > 0);
    cartToggle.setAttribute(
      "aria-label",
      `Открыть корзину. Товаров: ${itemCount}. Сумма: ${formatPrice(total)}.`
    );
    saveCart();
    cartEmpty.hidden = lines.length > 0;
    checkoutButton.disabled = lines.length === 0;
    if (lines.length === 0) {
      orderForm.hidden = true;
      checkoutButton.hidden = false;
    }
    cartItems.innerHTML = lines
      .map(
        ({ product, quantity }) => `
          <div class="cart-line">
            <img src="${escapeHtml(product.image)}" alt="" width="64" height="64" loading="lazy" decoding="async">
            <div class="cart-line__info">
              <strong>${escapeHtml(product.name)}</strong>
              <span>${formatPrice(product.price * quantity)}</span>
            </div>
            <div class="quantity-control" aria-label="Количество товара">
              <button type="button" data-cart-decrease="${escapeHtml(product.id)}" aria-label="Уменьшить">−</button>
              <span>${quantity}</span>
              <button
                type="button"
                data-cart-increase="${escapeHtml(product.id)}"
                aria-label="Увеличить"
                ${quantity >= product.stock ? "disabled" : ""}
              >+</button>
            </div>
          </div>
        `
      )
      .join("");
  }

  function render() {
    renderTabs();
    renderProducts();
    renderCart();
  }

  function openCart() {
    cartReturnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : cartToggle;
    cartDrawer.inert = false;
    cartDrawer.classList.add("is-open");
    cartDrawer.setAttribute("aria-hidden", "false");
    cartToggle.setAttribute("aria-expanded", "true");
    cartBackdrop.hidden = false;
    pageRegions.forEach((region) => {
      region.inert = true;
    });
    document.body.classList.add("drawer-open");
    document.querySelector("[data-cart-close]").focus();
  }

  function closeCart({ restoreFocus = true } = {}) {
    cartDrawer.classList.remove("is-open");
    cartDrawer.setAttribute("aria-hidden", "true");
    cartToggle.setAttribute("aria-expanded", "false");
    cartDrawer.inert = true;
    cartBackdrop.hidden = true;
    pageRegions.forEach((region) => {
      region.inert = false;
    });
    document.body.classList.remove("drawer-open");

    if (restoreFocus && cartReturnFocus?.isConnected) {
      cartReturnFocus.focus();
    }
  }

  function changeCartQuantity(productId, change) {
    const product = products.find((item) => item.id === productId);

    if (!product) {
      return;
    }

    const currentQuantity = cart.get(productId) || 0;
    const nextQuantity = Math.min(product.stock, Math.max(0, currentQuantity + change));

    if (nextQuantity === 0) {
      cart.delete(productId);
    } else {
      cart.set(productId, nextQuantity);
    }

    checkoutMessage.textContent = "";
    renderProducts();
    renderCart();
  }

  tabs.addEventListener("click", (event) => {
    const button = event.target.closest("[data-category]");
    if (!button) {
      return;
    }

    activeCategory = button.dataset.category;
    renderTabs();
    renderProducts();
  });

  catalog.addEventListener("click", (event) => {
    const addButton = event.target.closest("[data-add-product]");
    const decreaseButton = event.target.closest("[data-product-decrease]");
    const increaseButton = event.target.closest("[data-product-increase]");
    const productId =
      addButton?.dataset.addProduct ||
      decreaseButton?.dataset.productDecrease ||
      increaseButton?.dataset.productIncrease;

    if (!productId) {
      return;
    }

    changeCartQuantity(productId, decreaseButton ? -1 : 1);
  });

  cartItems.addEventListener("click", (event) => {
    const decreaseButton = event.target.closest("[data-cart-decrease]");
    const increaseButton = event.target.closest("[data-cart-increase]");
    const productId = decreaseButton?.dataset.cartDecrease || increaseButton?.dataset.cartIncrease;

    if (!productId) {
      return;
    }

    changeCartQuantity(productId, decreaseButton ? -1 : 1);
  });

  cartToggle.addEventListener("click", openCart);
  document.querySelector("[data-cart-close]").addEventListener("click", closeCart);
  cartBackdrop.addEventListener("click", closeCart);

  document.addEventListener("keydown", (event) => {
    if (!cartDrawer.classList.contains("is-open")) {
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      closeCart();
      return;
    }

    if (event.key !== "Tab") {
      return;
    }

    const focusableElements = Array.from(
      cartDrawer.querySelectorAll(focusableSelector)
    ).filter((element) => element.getClientRects().length > 0);
    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    if (!firstElement || !lastElement) {
      event.preventDefault();
      cartDrawer.focus();
    } else if (event.shiftKey && document.activeElement === firstElement) {
      event.preventDefault();
      lastElement.focus();
    } else if (!event.shiftKey && document.activeElement === lastElement) {
      event.preventDefault();
      firstElement.focus();
    }
  });

  checkoutButton.addEventListener("click", async () => {
    checkoutMessage.textContent = "";
    checkoutButton.hidden = true;
    orderForm.hidden = false;
    orderForm.elements.name.focus();
  });

  orderCancelButton.addEventListener("click", () => {
    orderForm.hidden = true;
    checkoutButton.hidden = false;
  });

  orderForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = orderForm.querySelector('[type="submit"]');
    const formData = new FormData(orderForm);
    submitButton.disabled = true;
    submitButton.textContent = "Создаём заказ...";

    try {
      const order = await window.OrderStore.create(
        Array.from(cart.entries()).map(([productId, quantity]) => ({ productId, quantity })),
        {
          name: String(formData.get("name")),
          phone: String(formData.get("phone")),
          pickupTime: String(formData.get("pickupTime")),
          comment: String(formData.get("comment")),
        }
      );

      products = await window.ProductStore.refresh();
      cart.clear();
      orderForm.reset();
      orderForm.hidden = true;
      checkoutButton.hidden = false;
      checkoutMessage.textContent =
        `Заказ ${order.number} принят. К оплате при получении: ${formatPrice(order.total)}.`;
      checkoutMessage.className = "form-message is-success";
      render();
    } catch (error) {
      checkoutMessage.textContent = error.message;
      checkoutMessage.className = "form-message is-error";
      products = await window.ProductStore.refresh().catch(() => products);
      render();
    } finally {
      submitButton.textContent = "Подтвердить заказ";
      submitButton.disabled = false;
    }
  });

  async function initialize() {
    catalog.innerHTML = '<p class="loading-state">Загружаем сегодняшнюю витрину...</p>';

    try {
      products = await window.ProductStore.getAll();
      restoreCart();
      render();
      window.ProductStore.subscribe((nextProducts) => {
        products = nextProducts;
        render();
      });
    } catch (error) {
      catalog.innerHTML = `<p class="form-message is-error">${escapeHtml(error.message)}</p>`;
    }
  }

  initialize();
})();
