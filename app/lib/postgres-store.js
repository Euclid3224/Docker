"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

function createPostgresStore(options = {}) {
  let pool = options.pool;
  if (!pool) {
    const { Pool } = require("pg");
    pool = new Pool({
      connectionString: options.connectionString || process.env.DATABASE_URL,
      ssl:
        process.env.DATABASE_SSL === "true"
          ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false" }
          : undefined,
      max: Number(process.env.DATABASE_POOL_SIZE) || 10,
    });
  }

  const productSelect = `
    SELECT id, category, name, description, image, price::float8 AS price, stock
    FROM products
  `;

  const mapOrder = (row, items = []) => ({
    id: row.id,
    number: row.number,
    status: row.status,
    customer: {
      name: row.customer_name,
      phone: row.customer_phone,
      pickupTime: row.pickup_time,
      comment: row.comment,
    },
    items,
    total: Number(row.total),
    itemCount: row.item_count,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  });

  async function withTransaction(callback) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function init() {
    const schema = await fs.readFile(
      path.join(__dirname, "..", "db", "schema.sql"),
      "utf8"
    );
    await pool.query(schema);
    await pool.query("DELETE FROM sessions WHERE expires_at <= NOW()");
    await pool.query("DELETE FROM login_attempts WHERE attempted_at < NOW() - INTERVAL '1 day'");
    await pool.query("DELETE FROM order_attempts WHERE attempted_at < NOW() - INTERVAL '1 day'");
  }

  async function listProducts() {
    const { rows } = await pool.query(`${productSelect} ORDER BY position, created_at`);
    return rows;
  }

  async function createProduct(product) {
    const { rows } = await pool.query(
      `
        INSERT INTO products (id, category, name, description, image, price, stock, position)
        VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE((SELECT MAX(position) + 1 FROM products), 0))
        RETURNING id, category, name, description, image, price::float8 AS price, stock
      `,
      [
        product.id,
        product.category,
        product.name,
        product.description,
        product.image,
        product.price,
        product.stock,
      ]
    );
    return rows[0];
  }

  async function updateProduct(id, product) {
    const { rows } = await pool.query(
      `
        UPDATE products
        SET category = $2, name = $3, description = $4, image = $5,
            price = $6, stock = $7, updated_at = NOW()
        WHERE id = $1
        RETURNING id, category, name, description, image, price::float8 AS price, stock
      `,
      [
        id,
        product.category,
        product.name,
        product.description,
        product.image,
        product.price,
        product.stock,
      ]
    );
    return rows[0] || null;
  }

  async function deleteProduct(id) {
    const result = await pool.query("DELETE FROM products WHERE id = $1", [id]);
    return result.rowCount > 0;
  }

  async function reorderProducts(productIds) {
    return withTransaction(async (client) => {
      const { rows } = await client.query("SELECT id FROM products FOR UPDATE");
      const currentIds = rows.map((row) => row.id);
      const uniqueIds = new Set(productIds);

      if (
        uniqueIds.size !== productIds.length ||
        currentIds.length !== productIds.length ||
        currentIds.some((id) => !uniqueIds.has(id))
      ) {
        const error = new Error("Новый порядок содержит неверный набор товаров.");
        error.statusCode = 400;
        throw error;
      }

      for (let index = 0; index < productIds.length; index += 1) {
        await client.query(
          "UPDATE products SET position = $2, updated_at = NOW() WHERE id = $1",
          [productIds[index], index]
        );
      }

      const { rows: products } = await client.query(
        `${productSelect} ORDER BY position, created_at`
      );
      return products;
    });
  }

  async function createOrder({ id, number, customer, requestedItems, rateLimit }) {
    return withTransaction(async (client) => {
      if (rateLimit) {
        const lockKeys = [
          `ip:${rateLimit.ipAddress}`,
          `phone:${rateLimit.phoneNormalized}`,
        ].sort();

        for (const lockKey of lockKeys) {
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
            lockKey,
          ]);
        }

        const { rows: attemptRows } = await client.query(
          `
            SELECT COUNT(*)::int AS count
            FROM order_attempts
            WHERE attempted_at > NOW() - ($3 * INTERVAL '1 minute')
              AND (ip_address = $1 OR phone_normalized = $2)
          `,
          [
            rateLimit.ipAddress,
            rateLimit.phoneNormalized,
            rateLimit.windowMinutes,
          ]
        );
        if (attemptRows[0].count >= rateLimit.limit) {
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

      const productIds = requestedItems.map((item) => item.productId);
      const { rows: products } = await client.query(
        `
          SELECT id, name, price::float8 AS price, stock
          FROM products
          WHERE id = ANY($1::text[])
          FOR UPDATE
        `,
        [productIds]
      );
      const productsById = new Map(products.map((product) => [product.id, product]));
      const orderItems = [];
      let total = 0;
      let itemCount = 0;

      for (const requested of requestedItems) {
        const product = productsById.get(requested.productId);
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

      for (const item of orderItems) {
        await client.query(
          "UPDATE products SET stock = stock - $2, updated_at = NOW() WHERE id = $1",
          [item.productId, item.quantity]
        );
      }

      const now = new Date();
      await client.query(
        `
          INSERT INTO orders (
            id, number, status, customer_name, customer_phone, pickup_time,
            comment, total, item_count, created_at, updated_at
          )
          VALUES ($1, $2, 'new', $3, $4, $5, $6, $7, $8, $9, $9)
        `,
        [
          id,
          number,
          customer.name,
          customer.phone,
          customer.pickupTime,
          customer.comment,
          total,
          itemCount,
          now,
        ]
      );

      for (const item of orderItems) {
        await client.query(
          `
            INSERT INTO order_items (order_id, product_id, product_name, price, quantity)
            VALUES ($1, $2, $3, $4, $5)
          `,
          [id, item.productId, item.name, item.price, item.quantity]
        );
      }

      if (rateLimit) {
        await client.query(
          `
            INSERT INTO order_attempts (ip_address, phone_normalized)
            VALUES ($1, $2)
          `,
          [rateLimit.ipAddress, rateLimit.phoneNormalized]
        );
      }

      return {
        id,
        number,
        status: "new",
        customer,
        items: orderItems,
        total,
        itemCount,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
    });
  }

  async function listOrders() {
    const { rows: orderRows } = await pool.query(
      "SELECT * FROM orders ORDER BY created_at DESC"
    );

    if (orderRows.length === 0) {
      return [];
    }

    const orderIds = orderRows.map((order) => order.id);
    const { rows: itemRows } = await pool.query(
      `
        SELECT order_id, product_id, product_name, price::float8 AS price, quantity
        FROM order_items
        WHERE order_id = ANY($1::uuid[])
        ORDER BY id
      `,
      [orderIds]
    );
    const itemsByOrder = new Map();

    itemRows.forEach((row) => {
      if (!itemsByOrder.has(row.order_id)) {
        itemsByOrder.set(row.order_id, []);
      }
      itemsByOrder.get(row.order_id).push({
        productId: row.product_id,
        name: row.product_name,
        price: row.price,
        quantity: row.quantity,
      });
    });

    return orderRows.map((row) => mapOrder(row, itemsByOrder.get(row.id) || []));
  }

  async function updateOrderStatus(id, status) {
    return withTransaction(async (client) => {
      const { rows } = await client.query(
        "SELECT * FROM orders WHERE id = $1 FOR UPDATE",
        [id]
      );
      const order = rows[0];
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

      const { rows: itemRows } = await client.query(
        `
          SELECT product_id, product_name, price::float8 AS price, quantity
          FROM order_items WHERE order_id = $1 ORDER BY id
        `,
        [id]
      );

      if (status === "cancelled" && order.status !== "cancelled") {
        for (const item of itemRows) {
          if (item.product_id) {
            await client.query(
              "UPDATE products SET stock = stock + $2, updated_at = NOW() WHERE id = $1",
              [item.product_id, item.quantity]
            );
          }
        }
      }

      const { rows: updatedRows } = await client.query(
        "UPDATE orders SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING *",
        [id, status]
      );
      return mapOrder(
        updatedRows[0],
        itemRows.map((item) => ({
          productId: item.product_id,
          name: item.product_name,
          price: item.price,
          quantity: item.quantity,
        }))
      );
    });
  }

  async function findUserByUsername(usernameNormalized) {
    const { rows } = await pool.query(
      `
        SELECT id, username, username_normalized, password_hash, role, active
        FROM users WHERE username_normalized = $1
      `,
      [usernameNormalized]
    );
    return rows[0]
      ? {
          id: rows[0].id,
          username: rows[0].username,
          usernameNormalized: rows[0].username_normalized,
          passwordHash: rows[0].password_hash,
          role: rows[0].role,
          active: rows[0].active,
        }
      : null;
  }

  async function countUsers() {
    const { rows } = await pool.query("SELECT COUNT(*)::int AS count FROM users");
    return rows[0].count;
  }

  async function createUser({ id = crypto.randomUUID(), username, passwordHash }) {
    const normalized = username.trim().toLowerCase();
    const { rows } = await pool.query(
      `
        INSERT INTO users (id, username, username_normalized, password_hash)
        VALUES ($1, $2, $3, $4)
        RETURNING id, username, username_normalized, role, active
      `,
      [id, username.trim(), normalized, passwordHash]
    );
    return rows[0];
  }

  async function updateUserPassword(userId, passwordHash) {
    await pool.query(
      "UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1",
      [userId, passwordHash]
    );
  }

  async function updateUserPasswordAndDeleteSessions(userId, passwordHash) {
    return withTransaction(async (client) => {
      const result = await client.query(
        "UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1",
        [userId, passwordHash]
      );
      if (result.rowCount === 0) {
        return false;
      }
      await client.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
      return true;
    });
  }

  async function createSession(session) {
    await pool.query(
      `
        INSERT INTO sessions (
          token_hash, user_id, expires_at, ip_address, user_agent
        ) VALUES ($1, $2, $3, $4, $5)
      `,
      [
        session.tokenHash,
        session.userId,
        session.expiresAt,
        session.ipAddress,
        session.userAgent,
      ]
    );
  }

  async function getSession(tokenHash) {
    const { rows } = await pool.query(
      `
        SELECT s.token_hash, s.user_id, s.expires_at, u.username, u.role
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > NOW() AND u.active = TRUE
      `,
      [tokenHash]
    );
    if (!rows[0]) {
      return null;
    }
    await pool.query("UPDATE sessions SET last_seen_at = NOW() WHERE token_hash = $1", [
      tokenHash,
    ]);
    return {
      tokenHash: rows[0].token_hash,
      userId: rows[0].user_id,
      username: rows[0].username,
      role: rows[0].role,
      expiresAt: new Date(rows[0].expires_at),
    };
  }

  async function deleteSession(tokenHash) {
    await pool.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
  }

  async function deleteUserSessions(userId) {
    await pool.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
  }

  async function reserveLoginAttempt({
    usernameNormalized,
    ipAddress,
    windowMinutes,
    limit,
  }) {
    return withTransaction(async (client) => {
      const lockKey = `login:${usernameNormalized}:${ipAddress}`;
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey]);
      await client.query(
        "DELETE FROM login_attempts WHERE attempted_at < NOW() - INTERVAL '1 day'"
      );

      const { rows } = await client.query(
        `
          SELECT COUNT(*)::int AS count
          FROM login_attempts
          WHERE successful = FALSE
            AND attempted_at > NOW() - ($3 * INTERVAL '1 minute')
            AND username_normalized = $1
            AND ip_address = $2
        `,
        [usernameNormalized, ipAddress, windowMinutes]
      );
      if (rows[0].count >= limit) {
        return { allowed: false };
      }

      const { rows: insertedRows } = await client.query(
        `
          INSERT INTO login_attempts (username_normalized, ip_address, successful)
          VALUES ($1, $2, FALSE)
          RETURNING id
        `,
        [usernameNormalized, ipAddress]
      );
      return { allowed: true, attemptId: insertedRows[0].id };
    });
  }

  async function completeLoginAttempt({ attemptId, successful }) {
    if (!successful) {
      return;
    }
    await pool.query("UPDATE login_attempts SET successful = TRUE WHERE id = $1", [
      attemptId,
    ]);
  }

  async function recordOrderAttempt({ ipAddress, phoneNormalized }) {
    await pool.query(
      `
        INSERT INTO order_attempts (ip_address, phone_normalized)
        VALUES ($1, $2)
      `,
      [ipAddress, phoneNormalized]
    );
  }

  async function countRecentOrders({ ipAddress, phoneNormalized, windowMinutes }) {
    const { rows } = await pool.query(
      `
        SELECT COUNT(*)::int AS count
        FROM order_attempts
        WHERE attempted_at > NOW() - ($3 * INTERVAL '1 minute')
          AND (ip_address = $1 OR phone_normalized = $2)
      `,
      [ipAddress, phoneNormalized, windowMinutes]
    );
    return rows[0].count;
  }

  async function importLegacyData(products, orders) {
    return withTransaction(async (client) => {
      for (let index = 0; index < products.length; index += 1) {
        const product = products[index];
        await client.query(
          `
            INSERT INTO products (
              id, category, name, description, image, price, stock, position
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
            ON CONFLICT (id) DO UPDATE SET
              category = EXCLUDED.category,
              name = EXCLUDED.name,
              description = EXCLUDED.description,
              image = EXCLUDED.image,
              price = EXCLUDED.price,
              stock = EXCLUDED.stock,
              position = EXCLUDED.position,
              updated_at = NOW()
          `,
          [
            product.id,
            product.category,
            product.name,
            product.description,
            product.image,
            product.price,
            product.stock,
            index,
          ]
        );
      }

      for (const order of orders) {
        await client.query(
          `
            INSERT INTO orders (
              id, number, status, customer_name, customer_phone, pickup_time,
              comment, total, item_count, created_at, updated_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            ON CONFLICT (id) DO UPDATE SET
              number = EXCLUDED.number,
              status = EXCLUDED.status,
              customer_name = EXCLUDED.customer_name,
              customer_phone = EXCLUDED.customer_phone,
              pickup_time = EXCLUDED.pickup_time,
              comment = EXCLUDED.comment,
              total = EXCLUDED.total,
              item_count = EXCLUDED.item_count,
              updated_at = EXCLUDED.updated_at
          `,
          [
            order.id,
            order.number,
            order.status,
            order.customer.name,
            order.customer.phone,
            order.customer.pickupTime || "",
            order.customer.comment || "",
            order.total,
            order.itemCount,
            order.createdAt,
            order.updatedAt,
          ]
        );
        await client.query("DELETE FROM order_items WHERE order_id = $1", [order.id]);
        for (const item of order.items) {
          await client.query(
            `
              INSERT INTO order_items (order_id, product_id, product_name, price, quantity)
              VALUES ($1, $2, $3, $4, $5)
            `,
            [order.id, item.productId || null, item.name, item.price, item.quantity]
          );
        }
      }
    });
  }

  async function close() {
    await pool.end();
  }

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
    updateUserPasswordAndDeleteSessions,
    createSession,
    getSession,
    deleteSession,
    deleteUserSessions,
    reserveLoginAttempt,
    completeLoginAttempt,
    recordOrderAttempt,
    countRecentOrders,
    importLegacyData,
    close,
  };
}

module.exports = { createPostgresStore };
