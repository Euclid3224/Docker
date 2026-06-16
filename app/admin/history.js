(function () {
  "use strict";

  const U = window.OrderUtils;

  const screen = document.querySelector("[data-history-screen]");
  const listContainer = document.querySelector("[data-history-list]");
  const rangeLabel = document.querySelector("[data-week-range]");
  const totalCount = document.querySelector("[data-history-total]");
  const gateMessage = document.querySelector("[data-history-gate]");

  const escapeHtml = (value) => {
    const element = document.createElement("div");
    element.textContent = value;
    return element.innerHTML;
  };

  const STATUS_LABELS = { completed: "Выдан", cancelled: "Отменён" };

  function setRangeLabel(range) {
    const lastDay = new Date(range.end.getTime() - 1);
    rangeLabel.textContent = `${U.formatDayShort(range.start)} — ${U.formatDayShort(lastDay)}`;
  }

  function renderHistory(orders) {
    const range = U.currentWeekRange();
    setRangeLabel(range);

    const numbers = U.assignDailyNumbers(orders);
    const weekOrders = orders
      .filter(
        (order) =>
          (order.status === "completed" || order.status === "cancelled") &&
          U.isInRange(order.createdAt, range)
      )
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    totalCount.textContent = String(weekOrders.length);

    if (weekOrders.length === 0) {
      listContainer.innerHTML =
        '<p class="empty-state">За эту неделю завершённых заказов пока нет.</p>';
      return;
    }

    // Группируем по дню (новые дни сверху)
    const groups = new Map();
    for (const order of weekOrders) {
      const key = U.localDayKey(order.createdAt);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(order);
    }

    listContainer.innerHTML = [...groups.entries()]
      .map(([, dayOrders]) => {
        const dayTotal = dayOrders
          .filter((order) => order.status === "completed")
          .reduce((sum, order) => sum + order.total, 0);

        const cards = dayOrders
          .map((order) => {
            const items = order.items
              .map(
                (item) =>
                  `<li><span>${escapeHtml(item.name)} × ${item.quantity}</span><strong>${U.formatPrice(
                    item.price * item.quantity
                  )}</strong></li>`
              )
              .join("");

            return `
              <article class="admin-order status-${escapeHtml(order.status)}">
                <div class="admin-order__header">
                  <div>
                    <span class="order-number">Заказ № ${escapeHtml(numbers.get(order.id) || "—")}</span>
                    <time datetime="${escapeHtml(order.createdAt)}">${U.formatTime(order.createdAt)}</time>
                  </div>
                  <span class="order-badge order-badge--${escapeHtml(order.status)}">${STATUS_LABELS[order.status]}</span>
                </div>
                <div class="admin-order__customer">
                  <strong>${escapeHtml(order.customer.name)}</strong>
                  <a href="tel:${escapeHtml(order.customer.phone)}">${escapeHtml(order.customer.phone)}</a>
                  ${order.customer.comment ? `<p>Комментарий: ${escapeHtml(order.customer.comment)}</p>` : ""}
                </div>
                <ul class="admin-order__items">${items}</ul>
                <div class="admin-order__total">
                  <span>${order.itemCount} шт.</span>
                  <strong>${U.formatPrice(order.total)}</strong>
                </div>
              </article>
            `;
          })
          .join("");

        return `
          <section class="history-day">
            <div class="history-day__head">
              <h2>${escapeHtml(U.formatDayHeading(dayOrders[0].createdAt))}</h2>
              <span>Выручка: <strong>${U.formatPrice(dayTotal)}</strong></span>
            </div>
            <div class="admin-orders">${cards}</div>
          </section>
        `;
      })
      .join("");
  }

  async function loadHistory() {
    const orders = await window.OrderStore.getAll();
    renderHistory(orders);
  }

  function showGate(message) {
    screen.hidden = true;
    gateMessage.hidden = false;
    gateMessage.querySelector("[data-gate-text]").textContent = message;
  }

  async function initialize() {
    try {
      const session = await window.AdminAuth.getSession();
      if (!session.authenticated) {
        showGate("Войдите в кабинет владельца, чтобы посмотреть историю заказов.");
        return;
      }
      screen.hidden = false;
      gateMessage.hidden = true;
      await loadHistory();
      window.OrderStore.subscribe(() => {
        loadHistory().catch(() => {});
      });
    } catch (error) {
      showGate("Сервер недоступен. Запустите проект командой node server.js.");
    }
  }

  initialize();
})();
