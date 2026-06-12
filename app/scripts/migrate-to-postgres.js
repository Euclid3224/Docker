"use strict";

require("../lib/load-env").loadEnv();

const fs = require("node:fs/promises");
const path = require("node:path");
const { createPostgresStore } = require("../lib/postgres-store");
const { hashPassword, validatePassword } = require("../lib/password");

async function readJsonArray(file) {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("Задайте DATABASE_URL перед миграцией.");
  }

  const adminUsername = String(process.env.ADMIN_USERNAME || "admin").trim();
  const adminPassword = process.env.ADMIN_PASSWORD;
  const products = await readJsonArray(
    path.join(__dirname, "..", "data", "products.json")
  );
  const orders = await readJsonArray(
    path.join(__dirname, "..", "data", "orders.json")
  );
  const productIds = new Set(products.map((product) => product.id));
  const normalizedOrders = orders.map((order) => ({
    ...order,
    items: order.items.map((item) => ({
      ...item,
      productId: productIds.has(item.productId) ? item.productId : null,
    })),
  }));
  const store = createPostgresStore({ connectionString: process.env.DATABASE_URL });

  try {
    await store.init();
    await store.importLegacyData(products, normalizedOrders);

    if ((await store.countUsers()) === 0) {
      if (!adminPassword) {
        throw new Error(
          "Для первого владельца задайте ADMIN_PASSWORD длиной не менее 12 символов."
        );
      }
      validatePassword(adminPassword);
      await store.createUser({
        username: adminUsername,
        passwordHash: await hashPassword(adminPassword),
      });
    }

    console.log(`Импортировано товаров: ${products.length}`);
    console.log(`Импортировано заказов: ${orders.length}`);
    console.log(`Пользователь владельца: ${adminUsername}`);
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
