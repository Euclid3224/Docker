"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

function createFileStore(options = {}) {
  const dataDirectory = options.dataDirectory || path.join(__dirname, "..", "data");
  const productsFile = path.join(dataDirectory, "products.json");
  const ordersFile = path.join(dataDirectory, "orders.json");
  const usersFile = path.join(dataDirectory, "users.json");
  const sessions = new Map();
  const loginAttempts = [];
  const orderAttempts = [];
  let queue = Promise.resolve();

  async function readArray(file, fallback = []) {
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8"));
      if (!Array.isArray(parsed)) {
        throw new Error(`Некорректный формат файла ${path.basename(file)}.`);
      }
      return parsed;
    } catch (error) {
      if (error.code === "ENOENT") {
        return fallback;
      }
      throw error;
    }
  }

  async function writeArray(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporaryFile = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporaryFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(temporaryFile, file);
  }

  function mutate(callback) {
    const operation = queue.then(callback);
    queue = operation.catch(() => {});
    return operation;
  }

  async function init() {
    await fs.mkdir(dataDirectory, { recursive: true });
    for (const file of [productsFile, ordersFile, usersFile]) {
      try {
        await fs.access(file);
      } catch {
        await writeArray(file, []);
      }
    }
  }

  function listProducts() {
    return readArray(productsFile);
  }

  async function createProduct(product) {
    return mutate(async () => {
      const products = await readArray(productsFile);
      products.push(product);
      await writeArray(productsFile, products);
      return product;
    });
  }

  async function updateProduct(id, product) {
    return mutate(async () => {
      const products = await readArray(productsFile);
      const index = products.findIndex((item) => item.id === id);
      if (index < 0) {
        return null;
      }
      products[index] = { ...product, id };
      await writeArray(productsFile, products);
      return products[index];
    });
  }

  async function deleteProduct(id) {
    return mutate(async () => {
      const products = await readArray(productsFile);
      const nextProducts = products.filter((item) => item.id !== id);
      if (nextProducts.length === products.length) {
        return false;
      }
      await writeArray(productsFile, nextProducts);
      return true;
    });
  }

  async function reorderProducts(productIds) {
    return mutate(async () => {
      const products = await readArray(productsFile);
      const productsById = new Map(products.map((product) => [product.id, product]));
      const uniqueIds = new Set(productIds);
      if (
        uniqueIds.size !== productIds.length ||
        products.length !== productIds.length ||
        products.some((product) => !uniqueIds.has(product.id))
      ) {
        const error = new Error("Новый порядок содержит неверный набор товаров.");
        error.statusCode = 400;
        throw error;
      }
      const reordered = productIds.map((id) => productsById.get(id));
      await writeArray(productsFile, reordered);
      return reordered;
    });
  }

  async function createOrder({ id, number, customer, requestedItems, rateLimit }) {
    return mutate(async () => {
      if (rateLimit) {
        const cutoff = Date.now() - rateLimit.windowMinutes * 60 * 1000;
        while (orderAttempts[0]?.attemptedAt < cutoff) {
          orderAttempts.shift();
        }
        const recentOrders = orderAttempts.filter(
          (attempt) =>
            attempt.attemptedAt > cutoff &&
            (attempt.ipAddress === rateLimit.ipAddress ||
              attempt.phoneNormalized === rateLimit.phoneNormalized)
        ).length;

        if (recentOrders >= rateLimit.limit) {
          const error = new Error(
            "Слишком много заказов за короткое время. Повторите через 15 минут."
          );
          error.statusCode = 429;
          error.headers = {
            "Retry-After": String(rateLimit.windowMinutes * 60),
          };
          throw error;
        }
      }

      const products = await readArray(productsFile);
      const orders = await readArray(ordersFile);
      const orderItems = [];
      let total = 0;
      let itemCount = 0;

      for (const requested of requestedItems) {
        const product = products.find((item) => item.id === requested.productId);
        if (!product) {
          const error = new Error("Один из товаров больше не продаётся.");
          error.statusCode = 409;
          throw error;
        }
        if (product.stock < requested.quantity) {
          const error = new Error(
            `Недостаточно товара «${product.name}». Доступно: ${product.stock}.`
          );
          error.statusCode = 409;
          throw error;
        }
        orderItems.push({
          productId: product.id,
          name: product.name,
          price: product.price,
          quantity: requested.quantity,
        });
        total += product.price * requested.quantity;
        itemCount += requested.quantity;
      }

      orderItems.forEach((item) => {
        const product = products.find((candidate) => candidate.id === item.productId);
        product.stock -= item.quantity;
      });

      const now = new Date().toISOString();
      const order = {
        id,
        number,
        status: "new",
        customer,
        items: orderItems,
        total,
        itemCount,
        createdAt: now,
        updatedAt: now,
      };
      orders.unshift(order);
      await writeArray(productsFile, products);
      await writeArray(ordersFile, orders);
      if (rateLimit) {
        orderAttempts.push({
          ipAddress: rateLimit.ipAddress,
          phoneNormalized: rateLimit.phoneNormalized,
          attemptedAt: Date.now(),
        });
      }
      return order;
    });
  }

  function listOrders() {
    return readArray(ordersFile);
  }

  async function updateOrderStatus(id, status) {
    return mutate(async () => {
      const products = await readArray(productsFile);
      const orders = await readArray(ordersFile);
      const order = orders.find((item) => item.id === id);
      if (!order) {
        return null;
      }
      if (order.status === "cancelled" && status !== "cancelled") {
        const error = new Error("Отменённый заказ нельзя вернуть в работу.");
        error.statusCode = 409;
        throw error;
      }
      if (order.status === "completed" && status !== "completed") {
        const error = new Error("Выданный заказ нельзя изменить.");
        error.statusCode = 409;
        throw error;
      }
      if (status === "cancelled" && order.status !== "cancelled") {
        order.items.forEach((item) => {
          const product = products.find((candidate) => candidate.id === item.productId);
          if (product) {
            product.stock += item.quantity;
          }
        });
        await writeArray(productsFile, products);
      }
      order.status = status;
      order.updatedAt = new Date().toISOString();
      await writeArray(ordersFile, orders);
      return order;
    });
  }

  async function findUserByUsername(usernameNormalized) {
    const users = await readArray(usersFile);
    return users.find((user) => user.usernameNormalized === usernameNormalized) || null;
  }

  async function countUsers() {
    return (await readArray(usersFile)).length;
  }

  async function createUser({ id = crypto.randomUUID(), username, passwordHash }) {
    return mutate(async () => {
      const users = await readArray(usersFile);
      const user = {
        id,
        username: username.trim(),
        usernameNormalized: username.trim().toLowerCase(),
        passwordHash,
        role: "owner",
        active: true,
      };
      users.push(user);
      await writeArray(usersFile, users);
      return user;
    });
  }

  async function updateUserPassword(userId, passwordHash) {
    return mutate(async () => {
      const users = await readArray(usersFile);
      const user = users.find((item) => item.id === userId);
      if (!user) {
        return false;
      }
      user.passwordHash = passwordHash;
      await writeArray(usersFile, users);
      return true;
    });
  }

  async function createSession(session) {
    sessions.set(session.tokenHash, { ...session });
  }

  async function getSession(tokenHash) {
    const session = sessions.get(tokenHash);
    if (!session || new Date(session.expiresAt).getTime() <= Date.now()) {
      sessions.delete(tokenHash);
      return null;
    }
    const users = await readArray(usersFile);
    const user = users.find((item) => item.id === session.userId && item.active);
    return user
      ? {
          ...session,
          username: user.username,
          role: user.role,
        }
      : null;
  }

  async function deleteSession(tokenHash) {
    sessions.delete(tokenHash);
  }

  async function deleteUserSessions(userId) {
    sessions.forEach((session, tokenHash) => {
      if (session.userId === userId) {
        sessions.delete(tokenHash);
      }
    });
  }

  async function recordLoginAttempt(attempt) {
    loginAttempts.push({ ...attempt, attemptedAt: Date.now() });
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    while (loginAttempts[0]?.attemptedAt < cutoff) {
      loginAttempts.shift();
    }
  }

  async function countRecentFailedLogins({
    usernameNormalized,
    ipAddress,
    windowMinutes,
  }) {
    const cutoff = Date.now() - windowMinutes * 60 * 1000;
    return loginAttempts.filter(
      (attempt) =>
        !attempt.successful &&
        attempt.attemptedAt > cutoff &&
        attempt.usernameNormalized === usernameNormalized &&
        attempt.ipAddress === ipAddress
    ).length;
  }

  async function recordOrderAttempt(attempt) {
    orderAttempts.push({ ...attempt, attemptedAt: Date.now() });
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    while (orderAttempts[0]?.attemptedAt < cutoff) {
      orderAttempts.shift();
    }
  }

  async function countRecentOrders({ ipAddress, phoneNormalized, windowMinutes }) {
    const cutoff = Date.now() - windowMinutes * 60 * 1000;
    return orderAttempts.filter(
      (attempt) =>
        attempt.attemptedAt > cutoff &&
        (attempt.ipAddress === ipAddress ||
          attempt.phoneNormalized === phoneNormalized)
    ).length;
  }

  async function importLegacyData(products, orders) {
    await writeArray(productsFile, products);
    await writeArray(ordersFile, orders);
  }

  async function close() {}

  return {
    init,
    listProducts,
    createProduct,
    updateProduct,
    deleteProduct,
    reorderProducts,
    createOrder,
    listOrders,
    updateOrderStatus,
    findUserByUsername,
    countUsers,
    createUser,
    updateUserPassword,
    createSession,
    getSession,
    deleteSession,
    deleteUserSessions,
    recordLoginAttempt,
    countRecentFailedLogins,
    recordOrderAttempt,
    countRecentOrders,
    importLegacyData,
    close,
  };
}

module.exports = { createFileStore };
