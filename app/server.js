"use strict";

require("./lib/load-env").loadEnv();

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createStoreFromEnvironment } = require("./lib/store");
const { hashPassword, verifyPassword, validatePassword } = require("./lib/password");

const ROOT_DIR = __dirname;
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const SESSION_COOKIE = "bakery_admin_session";
const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MINUTES = 15;
const LOGIN_ATTEMPT_LIMIT = 5;
const LOGIN_USERNAME_MAX_LENGTH = 128;
const ORDER_WINDOW_MINUTES = 15;
const ORDER_ATTEMPT_LIMIT = 3;
const EVENT_CLIENT_LIMIT = 100;
const EVENT_CLIENT_IP_LIMIT = 5;
const BODY_LIMIT = 2 * 1024 * 1024;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".jfif": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function createOrderNumber(orderId, date = new Date()) {
  const datePart = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("");
  const identifier = String(orderId).replace(/[^a-f0-9]/gi, "").slice(0, 12);

  if (identifier.length !== 12) {
    throw new Error("Не удалось сформировать номер заказа.");
  }

  return `TH-${datePart}-${identifier.toUpperCase()}`;
}

function createBakeryServer(options = {}) {
  const store = options.store || createStoreFromEnvironment(options);
  const eventClients = new Map();
  const eventClientLimit = options.eventClientLimit ?? EVENT_CLIENT_LIMIT;
  const eventClientIpLimit =
    options.eventClientIpLimit ?? EVENT_CLIENT_IP_LIMIT;
  const trustProxy =
    options.trustProxy ?? process.env.TRUST_PROXY === "true";
  const cookieSecure =
    options.cookieSecure ??
    (process.env.COOKIE_SECURE === "true" || process.env.NODE_ENV === "production");

  const ready = (async () => {
    await store.init();

    if ((await store.countUsers()) === 0) {
      const username = String(
        options.adminUsername || process.env.ADMIN_USERNAME || "admin"
      ).trim();
      let password = options.adminPassword || process.env.ADMIN_PASSWORD;

      if (!password && process.env.NODE_ENV === "production") {
        throw new Error(
          "Первый запуск требует ADMIN_PASSWORD длиной не менее 12 символов."
        );
      }

      if (!password) {
        password = crypto.randomBytes(12).toString("base64url");
        console.warn(`Временный пароль владельца ${username}: ${password}`);
        console.warn("Войдите и сразу смените пароль в личном кабинете.");
      }

      validatePassword(password);
      await store.createUser({
        username,
        passwordHash: await hashPassword(password),
      });
    }
  })();

  function getSecurityHeaders() {
    const headers = {
      "Content-Security-Policy": [
        "default-src 'self'",
        "base-uri 'self'",
        "connect-src 'self'",
        "font-src 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "img-src 'self' data: https:",
        "object-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
      ].join("; "),
      "Cross-Origin-Opener-Policy": "same-origin",
      "Permissions-Policy":
        "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    };

    if (cookieSecure) {
      headers["Strict-Transport-Security"] =
        "max-age=31536000; includeSubDomains";
    }

    return headers;
  }

  function sendJson(response, statusCode, payload, headers = {}) {
    response.writeHead(statusCode, {
      ...getSecurityHeaders(),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    });
    response.end(JSON.stringify(payload));
  }

  function sendError(response, statusCode, message, headers = {}) {
    sendJson(response, statusCode, { error: message }, headers);
  }

  async function readJsonBody(request) {
    const contentType = String(request.headers["content-type"] || "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (contentType !== "application/json") {
      const error = new Error("Для API-запроса требуется Content-Type application/json.");
      error.statusCode = 415;
      throw error;
    }

    let size = 0;
    const chunks = [];

    for await (const chunk of request) {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        const error = new Error("Размер запроса превышает 2 МБ.");
        error.statusCode = 413;
        throw error;
      }
      chunks.push(chunk);
    }

    if (chunks.length === 0) {
      return {};
    }

    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      const error = new Error("Некорректный JSON.");
      error.statusCode = 400;
      throw error;
    }
  }

  function parseCookies(request) {
    return Object.fromEntries(
      String(request.headers.cookie || "")
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const separator = part.indexOf("=");
          return [
            decodeURIComponent(separator >= 0 ? part.slice(0, separator) : part),
            decodeURIComponent(separator >= 0 ? part.slice(separator + 1) : ""),
          ];
        })
    );
  }

  function hashSessionToken(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  function getClientIp(request) {
    if (trustProxy) {
      const forwarded = String(request.headers["x-forwarded-for"] || "")
        .split(",")[0]
        .trim();
      if (forwarded) {
        return forwarded;
      }
    }
    return request.socket.remoteAddress || "";
  }

  function getSessionCookie(token, maxAgeSeconds) {
    const attributes = [
      `${SESSION_COOKIE}=${token}`,
      "HttpOnly",
      "SameSite=Strict",
      "Path=/",
      `Max-Age=${maxAgeSeconds}`,
    ];
    if (cookieSecure) {
      attributes.push("Secure");
    }
    return attributes.join("; ");
  }

  async function getSession(request) {
    const token = parseCookies(request)[SESSION_COOKIE];
    return token ? store.getSession(hashSessionToken(token)) : null;
  }

  async function requireAdmin(request, response) {
    const session = await getSession(request);
    if (!session || session.role !== "owner") {
      sendError(response, 401, "Требуется вход владельца.");
      return null;
    }
    return session;
  }

  function normalizeProduct(input, id = crypto.randomUUID()) {
    const name = String(input.name || "").trim();
    const description = String(input.description || "").trim();
    const category = String(input.category || "other").trim();
    const image = String(input.image || "assets/bakery-1.jfif").trim();
    const price = Number(input.price);
    const stock = Number(input.stock);

    if (!name || name.length > 80) {
      throw Object.assign(new Error("Укажите название до 80 символов."), {
        statusCode: 400,
      });
    }
    if (!description || description.length > 300) {
      throw Object.assign(new Error("Укажите описание до 300 символов."), {
        statusCode: 400,
      });
    }
    if (!Number.isFinite(price) || price < 0) {
      throw Object.assign(new Error("Цена должна быть неотрицательным числом."), {
        statusCode: 400,
      });
    }
    if (!Number.isInteger(stock) || stock < 0) {
      throw Object.assign(
        new Error("Остаток должен быть целым неотрицательным числом."),
        { statusCode: 400 }
      );
    }
    if (image.length > 1_500_000) {
      throw Object.assign(new Error("Изображение слишком большое."), {
        statusCode: 413,
      });
    }

    return { id, category, name, description, image, price, stock };
  }

  function normalizeCustomer(input) {
    const name = String(input?.name || "").trim();
    const phone = String(input?.phone || "").trim();
    const pickupTime = String(input?.pickupTime || "").trim();
    const comment = String(input?.comment || "").trim();
    const phoneDigits = phone.replace(/\D/g, "");

    if (name.length < 2 || name.length > 80) {
      throw Object.assign(new Error("Укажите имя покупателя."), { statusCode: 400 });
    }
    if (phoneDigits.length < 10 || phoneDigits.length > 15) {
      throw Object.assign(new Error("Укажите корректный номер телефона."), {
        statusCode: 400,
      });
    }
    if (pickupTime.length > 80 || comment.length > 300) {
      throw Object.assign(
        new Error("Комментарий или время получения слишком длинные."),
        { statusCode: 400 }
      );
    }

    return { name, phone, pickupTime, comment };
  }

  function notify(eventName) {
    eventClients.forEach((_ipAddress, response) => {
      response.write(`event: ${eventName}\ndata: ${Date.now()}\n\n`);
    });
  }

  async function handleApi(request, response, url) {
    if (request.method === "GET" && url.pathname === "/api/products") {
      sendJson(response, 200, await store.listProducts());
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/events") {
      const ipAddress = getClientIp(request);
      const clientIpConnections = Array.from(eventClients.values()).filter(
        (clientIp) => clientIp === ipAddress
      ).length;

      if (
        eventClients.size >= eventClientLimit ||
        clientIpConnections >= eventClientIpLimit
      ) {
        sendError(
          response,
          429,
          "Слишком много открытых соединений. Повторите позже.",
          { "Retry-After": "10" }
        );
        return true;
      }

      response.writeHead(200, {
        ...getSecurityHeaders(),
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      response.write("retry: 3000\n\n");
      eventClients.set(response, ipAddress);
      const removeClient = () => eventClients.delete(response);
      request.on("close", removeClient);
      response.on("close", removeClient);
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/auth/login") {
      const body = await readJsonBody(request);
      const username = String(body.username || "").trim();
      if (!username || username.length > LOGIN_USERNAME_MAX_LENGTH) {
        sendError(response, 400, "Логин должен содержать от 1 до 128 символов.");
        return true;
      }
      const usernameNormalized = username.toLowerCase();
      const ipAddress = getClientIp(request);
      const reservation = await store.reserveLoginAttempt({
        usernameNormalized,
        ipAddress,
        windowMinutes: LOGIN_WINDOW_MINUTES,
        limit: LOGIN_ATTEMPT_LIMIT,
      });

      if (!reservation.allowed) {
        sendError(
          response,
          429,
          "Слишком много попыток входа. Повторите через 15 минут.",
          { "Retry-After": String(LOGIN_WINDOW_MINUTES * 60) }
        );
        return true;
      }

      const user = await store.findUserByUsername(usernameNormalized);
      const authenticated =
        Boolean(user?.active) &&
        (await verifyPassword(String(body.password || ""), user.passwordHash));

      await store.completeLoginAttempt({
        attemptId: reservation.attemptId,
        successful: authenticated,
      });

      if (!authenticated) {
        await sleep(250);
        sendError(response, 401, "Неверный логин или пароль.");
        return true;
      }

      const token = crypto.randomBytes(32).toString("base64url");
      await store.createSession({
        tokenHash: hashSessionToken(token),
        userId: user.id,
        expiresAt: new Date(Date.now() + SESSION_LIFETIME_MS),
        ipAddress,
        userAgent: String(request.headers["user-agent"] || "").slice(0, 500),
      });
      sendJson(
        response,
        200,
        { authenticated: true, username: user.username },
        { "Set-Cookie": getSessionCookie(token, SESSION_LIFETIME_MS / 1000) }
      );
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/auth/session") {
      const session = await getSession(request);
      sendJson(response, 200, {
        authenticated: Boolean(session),
        username: session?.username || null,
      });
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/auth/logout") {
      const token = parseCookies(request)[SESSION_COOKIE];
      if (token) {
        await store.deleteSession(hashSessionToken(token));
      }
      sendJson(
        response,
        200,
        { authenticated: false },
        { "Set-Cookie": getSessionCookie("", 0) }
      );
      return true;
    }

    if (request.method === "PUT" && url.pathname === "/api/auth/password") {
      const session = await requireAdmin(request, response);
      if (!session) {
        return true;
      }
      const body = await readJsonBody(request);
      const user = await store.findUserByUsername(session.username.toLowerCase());
      if (
        !user ||
        !(await verifyPassword(String(body.currentPassword || ""), user.passwordHash))
      ) {
        sendError(response, 400, "Текущий пароль указан неверно.");
        return true;
      }
      validatePassword(body.newPassword);
      await store.updateUserPasswordAndDeleteSessions(
        session.userId,
        await hashPassword(body.newPassword)
      );
      sendJson(
        response,
        200,
        { changed: true },
        { "Set-Cookie": getSessionCookie("", 0) }
      );
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/orders") {
      const body = await readJsonBody(request);
      const customer = normalizeCustomer(body.customer);
      const ipAddress = getClientIp(request);
      const phoneNormalized = customer.phone.replace(/\D/g, "");
      const recentOrders = await store.countRecentOrders({
        ipAddress,
        phoneNormalized,
        windowMinutes: ORDER_WINDOW_MINUTES,
      });

      if (recentOrders >= ORDER_ATTEMPT_LIMIT) {
        sendError(
          response,
          429,
          "Слишком много заказов за короткое время. Повторите через 15 минут.",
          { "Retry-After": String(ORDER_WINDOW_MINUTES * 60) }
        );
        return true;
      }

      const requested = new Map();

      if (!Array.isArray(body.items)) {
        sendError(response, 400, "Передайте товары для заказа.");
        return true;
      }
      body.items.forEach((item) => {
        const quantity = Number(item.quantity);
        if (typeof item.productId === "string" && Number.isInteger(quantity) && quantity > 0) {
          requested.set(item.productId, (requested.get(item.productId) || 0) + quantity);
        }
      });
      if (requested.size === 0) {
        sendError(response, 400, "Корзина пуста.");
        return true;
      }

      const orderId = crypto.randomUUID();
      const order = await store.createOrder({
        id: orderId,
        number: createOrderNumber(orderId),
        customer,
        requestedItems: Array.from(requested, ([productId, quantity]) => ({
          productId,
          quantity,
        })),
        rateLimit: {
          ipAddress,
          phoneNormalized,
          windowMinutes: ORDER_WINDOW_MINUTES,
          limit: ORDER_ATTEMPT_LIMIT,
        },
      });
      notify("products");
      notify("orders");
      sendJson(response, 201, order);
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/orders") {
      if (!(await requireAdmin(request, response))) {
        return true;
      }
      sendJson(response, 200, await store.listOrders());
      return true;
    }

    const orderStatusMatch = url.pathname.match(
      /^\/api\/admin\/orders\/([^/]+)\/status$/
    );
    if (orderStatusMatch && request.method === "PUT") {
      if (!(await requireAdmin(request, response))) {
        return true;
      }
      const body = await readJsonBody(request);
      const allowedStatuses = new Set([
        "new",
        "preparing",
        "ready",
        "completed",
        "cancelled",
      ]);
      if (!allowedStatuses.has(body.status)) {
        sendError(response, 400, "Неизвестный статус заказа.");
        return true;
      }
      const order = await store.updateOrderStatus(
        decodeURIComponent(orderStatusMatch[1]),
        body.status
      );
      if (!order) {
        sendError(response, 404, "Заказ не найден.");
        return true;
      }
      if (body.status === "cancelled") {
        notify("products");
      }
      notify("orders");
      sendJson(response, 200, order);
      return true;
    }

    if (url.pathname === "/api/admin/products/order" && request.method === "PUT") {
      if (!(await requireAdmin(request, response))) {
        return true;
      }
      const body = await readJsonBody(request);
      if (!Array.isArray(body.productIds)) {
        sendError(response, 400, "Передайте новый порядок товаров.");
        return true;
      }
      const products = await store.reorderProducts(body.productIds.map(String));
      notify("products");
      sendJson(response, 200, products);
      return true;
    }

    if (url.pathname === "/api/admin/products" && request.method === "POST") {
      if (!(await requireAdmin(request, response))) {
        return true;
      }
      const product = await store.createProduct(normalizeProduct(await readJsonBody(request)));
      notify("products");
      sendJson(response, 201, product);
      return true;
    }

    const productMatch = url.pathname.match(/^\/api\/admin\/products\/([^/]+)$/);
    if (productMatch && request.method === "PUT") {
      if (!(await requireAdmin(request, response))) {
        return true;
      }
      const productId = decodeURIComponent(productMatch[1]);
      const product = await store.updateProduct(
        productId,
        normalizeProduct(await readJsonBody(request), productId)
      );
      if (!product) {
        sendError(response, 404, "Товар не найден.");
        return true;
      }
      notify("products");
      sendJson(response, 200, product);
      return true;
    }

    if (productMatch && request.method === "DELETE") {
      if (!(await requireAdmin(request, response))) {
        return true;
      }
      const deleted = await store.deleteProduct(decodeURIComponent(productMatch[1]));
      if (!deleted) {
        sendError(response, 404, "Товар не найден.");
        return true;
      }
      notify("products");
      sendJson(response, 200, { deleted: true });
      return true;
    }

    return false;
  }

  async function serveStatic(response, url) {
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") {
      pathname = "/index.html";
    } else if (pathname === "/admin") {
      pathname = "/admin/index.html";
    } else if (pathname.endsWith("/")) {
      pathname += "index.html";
    }

    const filePath = path.resolve(ROOT_DIR, `.${pathname}`);
    const relativePath = path.relative(ROOT_DIR, filePath);
    const firstSegment = relativePath.split(path.sep)[0];
    if (
      relativePath.startsWith("..") ||
      path.isAbsolute(relativePath) ||
      firstSegment.startsWith(".") ||
      relativePath === "server.js" ||
      relativePath === "package.json" ||
      relativePath.startsWith(`data${path.sep}`) ||
      relativePath.startsWith(`tests${path.sep}`) ||
      relativePath.startsWith(`db${path.sep}`) ||
      relativePath.startsWith(`lib${path.sep}`) ||
      relativePath.startsWith(`scripts${path.sep}`)
    ) {
      sendError(response, 404, "Страница не найдена.");
      return;
    }

    try {
      const content = await fs.readFile(filePath);
      response.writeHead(200, {
        ...getSecurityHeaders(),
        "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] ||
          "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      response.end(content);
    } catch (error) {
      if (error.code === "ENOENT") {
        sendError(response, 404, "Страница не найдена.");
        return;
      }
      throw error;
    }
  }

  const server = http.createServer(async (request, response) => {
    try {
      let url;
      try {
        const host = String(request.headers.host || "localhost");
        new URL(`http://${host}`);
        url = new URL(request.url || "/", "http://localhost");
      } catch {
        sendError(response, 400, "Некорректный HTTP-запрос.");
        return;
      }

      await ready;
      if (url.pathname.startsWith("/api/")) {
        if (!(await handleApi(request, response, url))) {
          sendError(response, 404, "API-метод не найден.");
        }
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendError(response, 405, "Метод не поддерживается.");
        return;
      }
      await serveStatic(response, url);
    } catch (error) {
      if (!error.statusCode || error.statusCode >= 500) {
        console.error(error);
      }
      sendError(
        response,
        error.statusCode || 500,
        error.statusCode ? error.message : "Ошибка сервера.",
        error.headers || {}
      );
    }
  });

  server.on("close", () => {
    eventClients.forEach((_ipAddress, response) => response.end());
    eventClients.clear();
    store.close().catch((error) => console.error("Ошибка закрытия хранилища:", error));
  });

  server.ready = ready;
  return server;
}

if (require.main === module) {
  const server = createBakeryServer();
  server.ready
    .then(() => {
      server.listen(PORT, HOST, () => {
        console.log(`Пекарня запущена: http://${HOST}:${PORT}`);
        console.log(`Личный кабинет: http://${HOST}:${PORT}/admin/`);
      });
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

module.exports = { createBakeryServer, createOrderNumber };
