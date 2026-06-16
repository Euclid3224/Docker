/* =====================================================================
   Тёплая пекарня — ДЕМО-данные и запасные хранилища.
   Назначение: если страница открыта БЕЗ работающего сервера
   (например, для просмотра дизайна), реальные product-store.js /
   order-store.js / auth.js не загрузятся и window.ProductStore и т.д.
   будут отсутствовать. Тогда этот файл подставляет демо-реализацию,
   чтобы кабинет можно было увидеть и потыкать.

   В рабочем режиме (сервер на месте) настоящие хранилища уже
   определены — здесь НИЧЕГО не подменяется.
   ===================================================================== */
(function () {
  "use strict";

  const DAY = 24 * 60 * 60 * 1000;
  const now = new Date();

  // Сегодня в указанный час:минуту
  function todayAt(h, m) {
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  }
  // N дней назад в указанный час:минуту
  function daysAgoAt(days, h, m) {
    const d = new Date(now.getTime() - days * DAY);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  }

  const demoProducts = [
    { id: "p1", category: "bread", name: "Бородинский хлеб", description: "Бородинский хлеб", image: "../assets/bakery-1.jfif", price: 95, stock: 18 },
    { id: "p2", category: "bread", name: "Чиабатта", description: "Чиабатта", image: "../assets/bakery-1.jfif", price: 120, stock: 9 },
    { id: "p3", category: "pastry", name: "Круассан с маслом", description: "Круассан с маслом", image: "../assets/bakery-1.jfif", price: 110, stock: 24 },
    { id: "p4", category: "pastry", name: "Улитка с корицей", description: "Улитка с корицей", image: "../assets/bakery-1.jfif", price: 130, stock: 0 },
    { id: "p5", category: "desserts", name: "Чизкейк", description: "Чизкейк", image: "../assets/bakery-1.jfif", price: 220, stock: 6 },
    { id: "p6", category: "drinks", name: "Капучино", description: "Капучино", image: "../assets/bakery-1.jfif", price: 150, stock: 40 },
  ];

  function buildOrder(id, number, createdAt, status, customer, items) {
    const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);
    const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    return { id, number, createdAt, status, customer, items, itemCount, total };
  }

  const demoOrders = [
    // — Активные (сегодня) —
    buildOrder("o1", "TH-DEMO-0001", todayAt(8, 5), "new",
      { name: "Анна", phone: "+79281234501", pickupTime: "к 9:30", comment: "Нарежьте, пожалуйста" },
      [{ name: "Бородинский хлеб", quantity: 2, price: 95 }, { name: "Капучино", quantity: 1, price: 150 }]),
    buildOrder("o2", "TH-DEMO-0002", todayAt(8, 40), "preparing",
      { name: "Игорь", phone: "+79281234502", pickupTime: "к 10:00", comment: "" },
      [{ name: "Круассан с маслом", quantity: 4, price: 110 }]),
    buildOrder("o3", "TH-DEMO-0003", todayAt(9, 15), "ready",
      { name: "Мария", phone: "+79281234503", pickupTime: "после 11:00", comment: "" },
      [{ name: "Чизкейк", quantity: 1, price: 220 }, { name: "Чиабатта", quantity: 1, price: 120 }]),

    // — История за текущую неделю (Пн–Вс) —
    buildOrder("o4", "TH-DEMO-0004", todayAt(7, 50), "completed",
      { name: "Олег", phone: "+79281234504", pickupTime: "к 8:30", comment: "" },
      [{ name: "Капучино", quantity: 2, price: 150 }]),
    buildOrder("o5", "TH-DEMO-0005", daysAgoAt(1, 12, 10), "completed",
      { name: "Светлана", phone: "+79281234505", pickupTime: "к 13:00", comment: "" },
      [{ name: "Чиабатта", quantity: 2, price: 120 }, { name: "Улитка с корицей", quantity: 2, price: 130 }]),
    buildOrder("o6", "TH-DEMO-0006", daysAgoAt(1, 9, 30), "cancelled",
      { name: "Дмитрий", phone: "+79281234506", pickupTime: "", comment: "Передумал" },
      [{ name: "Бородинский хлеб", quantity: 1, price: 95 }]),
    buildOrder("o7", "TH-DEMO-0007", daysAgoAt(2, 16, 0), "completed",
      { name: "Екатерина", phone: "+79281234507", pickupTime: "к 17:00", comment: "" },
      [{ name: "Чизкейк", quantity: 2, price: 220 }]),

    // — Старше недели — НЕ показывается на странице истории —
    buildOrder("o8", "TH-DEMO-0008", daysAgoAt(9, 11, 0), "completed",
      { name: "Прошлая неделя", phone: "+79281234508", pickupTime: "", comment: "" },
      [{ name: "Капучино", quantity: 1, price: 150 }]),
  ];

  // ---- Запасное хранилище товаров ----
  function makeDemoProductStore() {
    let products = demoProducts.map((p) => ({ ...p }));
    const cached = () => products.map((p) => ({ ...p }));
    return {
      getAll: async () => cached(),
      refresh: async () => cached(),
      getCached: cached,
      getById: (id) => {
        const found = products.find((p) => p.id === id);
        return found ? { ...found } : null;
      },
      create: async (product) => {
        const created = { ...product, id: "p" + (Date.now() % 100000) };
        products.push(created);
        return created;
      },
      update: async (id, changes) => {
        products = products.map((p) => (p.id === id ? { ...p, ...changes } : p));
        return products.find((p) => p.id === id);
      },
      remove: async (id) => {
        products = products.filter((p) => p.id !== id);
      },
      reorder: async (ids) => {
        products = ids.map((id) => products.find((p) => p.id === id)).filter(Boolean);
        return cached();
      },
      subscribe: () => () => {},
    };
  }

  // ---- Запасное хранилище заказов ----
  function makeDemoOrderStore() {
    let orders = demoOrders.map((o) => ({ ...o }));
    return {
      create: async () => ({}),
      getAll: async () => orders.map((o) => ({ ...o })),
      updateStatus: async (id, status) => {
        orders = orders.map((o) => (o.id === id ? { ...o, status } : o));
        return orders.find((o) => o.id === id);
      },
      subscribe: () => () => {},
    };
  }

  // ---- Запасная авторизация (всегда «вошёл», для показа дизайна) ----
  function makeDemoAuth() {
    return {
      login: async () => ({ authenticated: true }),
      logout: async () => ({ authenticated: false }),
      getSession: async () => ({ authenticated: true }),
      changePassword: async () => ({ ok: true }),
    };
  }

  if (!window.ProductStore) window.ProductStore = makeDemoProductStore();
  if (!window.OrderStore) window.OrderStore = makeDemoOrderStore();
  if (!window.AdminAuth) window.AdminAuth = makeDemoAuth();
})();
