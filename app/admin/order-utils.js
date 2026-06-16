/* =====================================================================
   Тёплая пекарня — утилиты заказов (общие для кабинета и истории)
   • Простая нумерация: «№ N» — порядковый номер заказа за день
     (сбрасывается каждый день, рядом всегда видна дата).
   • Текущая неделя Пн–Вс для страницы истории.
   • Форматирование цены и даты.
   ===================================================================== */
(function () {
  "use strict";

  const priceFormatter = new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  });

  const dateTimeFormatter = new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short",
    timeStyle: "short",
  });

  const timeFormatter = new Intl.DateTimeFormat("ru-RU", { timeStyle: "short" });

  const dayHeadingFormatter = new Intl.DateTimeFormat("ru-RU", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  const dayShortFormatter = new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
  });

  const formatPrice = (value) => priceFormatter.format(Number(value) || 0);
  const formatDateTime = (value) => dateTimeFormatter.format(new Date(value));
  const formatTime = (value) => timeFormatter.format(new Date(value));
  const formatDayHeading = (value) => dayHeadingFormatter.format(new Date(value));
  const formatDayShort = (value) => dayShortFormatter.format(new Date(value));

  const localDayKey = (value) => {
    const date = new Date(value);
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ].join("-");
  };

  /**
   * Присваивает каждому заказу простой порядковый номер за день.
   * Считаем по всем заказам дня (включая выданные/отменённые) в порядке
   * создания, поэтому номер заказа не «съезжает» при смене статуса.
   * Возвращает Map: id заказа → строка вида «7».
   */
  function assignDailyNumbers(orders) {
    const byDay = new Map();
    const sorted = [...orders].sort(
      (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
    );
    const labels = new Map();

    for (const order of sorted) {
      const key = localDayKey(order.createdAt);
      const next = (byDay.get(key) || 0) + 1;
      byDay.set(key, next);
      labels.set(order.id, String(next));
    }

    return labels;
  }

  /**
   * Текущая неделя: понедельник 00:00 (включительно) — следующий
   * понедельник 00:00 (не включая). Возвращает { start, end }.
   */
  function currentWeekRange(now = new Date()) {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const mondayOffset = (start.getDay() + 6) % 7; // Пн = 0 … Вс = 6
    start.setDate(start.getDate() - mondayOffset);

    const end = new Date(start);
    end.setDate(start.getDate() + 7);

    return { start, end };
  }

  function isInRange(value, range) {
    const time = new Date(value).getTime();
    return time >= range.start.getTime() && time < range.end.getTime();
  }

  window.OrderUtils = {
    formatPrice,
    formatDateTime,
    formatTime,
    formatDayHeading,
    formatDayShort,
    localDayKey,
    assignDailyNumbers,
    currentWeekRange,
    isInRange,
  };
})();
