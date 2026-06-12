"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { createBakeryServer, createOrderNumber } = require("../server");
const { createFileStore } = require("../lib/file-store");

const TEST_PASSWORD = "Admin-Test-123!";

async function startTestServer(options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bakery-test-"));
  await fs.writeFile(
    path.join(directory, "products.json"),
    JSON.stringify(
      [
        {
          id: "test-bread",
          category: "bread",
          name: "Test bread",
          description: "Fresh bread used by integration tests.",
          image: "assets/bakery-1.jfif",
          price: 100,
          stock: 5,
        },
      ],
      null,
      2
    )
  );
  await fs.writeFile(path.join(directory, "orders.json"), "[]\n");

  const store = createFileStore({ dataDirectory: directory });
  const server = createBakeryServer({
    ...options,
    store,
    adminUsername: "admin",
    adminPassword: TEST_PASSWORD,
    cookieSecure: false,
  });
  await server.ready;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
  });
  const body = await response.json();
  return { response, body };
}

async function login(baseUrl, password = TEST_PASSWORD) {
  const result = await jsonRequest(`${baseUrl}/api/auth/login`, {
    method: "POST",
    body: JSON.stringify({ username: "admin", password }),
  });
  return {
    ...result,
    cookie: result.response.headers.get("set-cookie")?.split(";")[0],
  };
}

async function rawHttpRequest(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.end(request));
    let response = "";

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });
}

test("malformed Host header returns 400 without crashing the server", async (context) => {
  const app = await startTestServer();
  context.after(app.close);
  const port = Number(new URL(app.baseUrl).port);

  const response = await rawHttpRequest(
    port,
    "GET / HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n"
  );
  assert.match(response, /^HTTP\/1\.1 400 /);

  const products = await jsonRequest(`${app.baseUrl}/api/products`);
  assert.equal(products.response.status, 200);
});

test("responses include browser security headers", async (context) => {
  const app = await startTestServer();
  context.after(app.close);

  const page = await fetch(`${app.baseUrl}/`);
  assert.match(
    page.headers.get("content-security-policy"),
    /frame-ancestors 'none'/
  );
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.equal(
    page.headers.get("referrer-policy"),
    "strict-origin-when-cross-origin"
  );
  assert.match(page.headers.get("permissions-policy"), /camera=\(\)/);

  const missing = await fetch(`${app.baseUrl}/missing`);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("x-content-type-options"), "nosniff");
});

test("event stream connections are limited per client", async (context) => {
  const app = await startTestServer({
    eventClientLimit: 2,
    eventClientIpLimit: 1,
  });
  context.after(app.close);

  const first = await fetch(`${app.baseUrl}/api/events`);
  assert.equal(first.status, 200);

  const blocked = await fetch(`${app.baseUrl}/api/events`);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "10");

  await first.body.cancel();
});

test("public order creation is rate limited by client and phone", async (context) => {
  const app = await startTestServer();
  context.after(app.close);
  const orderPayload = {
    customer: {
      name: "Test customer",
      phone: "+7 900 000-00-00",
      pickupTime: "Today",
    },
    items: [{ productId: "test-bread", quantity: 1 }],
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const order = await jsonRequest(`${app.baseUrl}/api/orders`, {
      method: "POST",
      body: JSON.stringify(orderPayload),
    });
    assert.equal(order.response.status, 201);
  }

  const blocked = await jsonRequest(`${app.baseUrl}/api/orders`, {
    method: "POST",
    body: JSON.stringify(orderPayload),
  });
  assert.equal(blocked.response.status, 429);
  assert.equal(blocked.response.headers.get("retry-after"), "900");

  const products = await jsonRequest(`${app.baseUrl}/api/products`);
  assert.equal(products.body[0].stock, 2);
});

test("parallel public orders cannot bypass the rate limit", async (context) => {
  const app = await startTestServer();
  context.after(app.close);
  const orderPayload = {
    customer: {
      name: "Parallel customer",
      phone: "+7 911 111-11-11",
    },
    items: [{ productId: "test-bread", quantity: 1 }],
  };

  const responses = await Promise.all(
    Array.from({ length: 5 }, () =>
      jsonRequest(`${app.baseUrl}/api/orders`, {
        method: "POST",
        body: JSON.stringify(orderPayload),
      })
    )
  );
  const statuses = responses.map(({ response }) => response.status).sort();

  assert.deepEqual(statuses, [201, 201, 201, 429, 429]);
  const products = await jsonRequest(`${app.baseUrl}/api/products`);
  assert.equal(products.body[0].stock, 2);
});

test("login failures from other addresses do not lock out the owner", async (context) => {
  const app = await startTestServer({ trustProxy: true });
  context.after(app.close);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const failed = await jsonRequest(`${app.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "X-Forwarded-For": `203.0.113.${attempt + 1}` },
      body: JSON.stringify({ username: "admin", password: "wrong-password" }),
    });
    assert.equal(failed.response.status, 401);
  }

  const owner = await jsonRequest(`${app.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "X-Forwarded-For": "198.51.100.10" },
    body: JSON.stringify({ username: "admin", password: TEST_PASSWORD }),
  });
  assert.equal(owner.response.status, 200);
});

test("order numbers derive sufficient entropy from the order id", () => {
  assert.equal(
    createOrderNumber(
      "12345678-90ab-cdef-1234-567890abcdef",
      new Date("2026-06-12T12:00:00Z")
    ),
    "TH-20260612-1234567890AB"
  );
});

test("frontend keeps public admin links hidden and uses local hero assets", async () => {
  const [
    indexHtml,
    menuHtml,
    adminHtml,
    catalogScript,
    navigationScript,
    stylesheet,
  ] =
    await Promise.all([
      fs.readFile(path.join(__dirname, "..", "index.html"), "utf8"),
      fs.readFile(path.join(__dirname, "..", "menu.html"), "utf8"),
      fs.readFile(path.join(__dirname, "..", "admin", "index.html"), "utf8"),
      fs.readFile(path.join(__dirname, "..", "catalog.js"), "utf8"),
      fs.readFile(path.join(__dirname, "..", "script.js"), "utf8"),
      fs.readFile(path.join(__dirname, "..", "style.css"), "utf8"),
    ]);

  assert.match(indexHtml, /loading="lazy"/);
  assert.match(menuHtml, /data-cart-drawer[^>]*inert/);
  assert.match(catalogScript, /event\.key === "Escape"/);
  assert.match(catalogScript, /event\.key !== "Tab"/);
  assert.match(navigationScript, /mainNav\.inert/);
  assert.doesNotMatch(indexHtml, /href=["']admin\/?["']/);
  assert.doesNotMatch(menuHtml, /href=["']admin\/?["']/);
  assert.doesNotMatch(stylesheet, /images\.unsplash\.com/);
  assert.match(stylesheet, /assets\/hero-bakery\.webp/);
  assert.match(stylesheet, /assets\/bakery-1\.jfif/);
  assert.doesNotMatch(stylesheet, /assets\/XXXL\.webp/);
  assert.doesNotMatch(indexHtml, /class="mobile-order-cta"/);
  assert.doesNotMatch(indexHtml, />Узнать о пекарне</);
  assert.match(indexHtml, /class="trust-strip"/);
  assert.match(menuHtml, /class="trust-strip trust-strip--menu"/);
  assert.match(menuHtml, /Свежие вкусы на каждый день/);
  assert.match(menuHtml, /class="trust-icon"/);
  assert.match(menuHtml, /data-cart-toggle-total/);
  assert.match(menuHtml, /data-build="20260612-cart-dock-v4"/);
  assert.match(menuHtml, /catalog\.js\?v=20260612-cart-dock-v4/);
  assert.match(adminHtml, /class="admin-rail"/);
  assert.match(catalogScript, /src="\$\{escapeHtml\(product\.image\)\}"/);
  assert.doesNotMatch(catalogScript, /updateFloatingCart/);
  assert.match(stylesheet, /min-height:\s*calc\(100svh - 73px\)/);
  assert.match(stylesheet, /height:\s*100dvh/);
  assert.match(stylesheet, /Persistent cart dock/);
});

test("pickup order reserves stock and cancellation restores it", async (context) => {
  const app = await startTestServer();
  context.after(app.close);

  const adminPage = await fetch(`${app.baseUrl}/admin`);
  assert.equal(adminPage.status, 200);

  const initial = await jsonRequest(`${app.baseUrl}/api/products`);
  assert.equal(initial.body[0].stock, 5);

  const unauthorized = await jsonRequest(
    `${app.baseUrl}/api/admin/products/test-bread`,
    {
      method: "PUT",
      body: JSON.stringify(initial.body[0]),
    }
  );
  assert.equal(unauthorized.response.status, 401);

  const auth = await login(app.baseUrl);
  assert.equal(auth.response.status, 200);

  const update = await jsonRequest(
    `${app.baseUrl}/api/admin/products/test-bread`,
    {
      method: "PUT",
      headers: { Cookie: auth.cookie },
      body: JSON.stringify({ ...initial.body[0], price: 125, stock: 7 }),
    }
  );
  assert.equal(update.body.stock, 7);

  const order = await jsonRequest(`${app.baseUrl}/api/orders`, {
    method: "POST",
    body: JSON.stringify({
      customer: {
        name: "Test customer",
        phone: "+7 900 000-00-00",
        pickupTime: "Today",
      },
      items: [{ productId: "test-bread", quantity: 2 }],
    }),
  });
  assert.equal(order.response.status, 201);
  assert.equal(order.body.total, 250);

  const productsAfterOrder = await jsonRequest(`${app.baseUrl}/api/products`);
  assert.equal(productsAfterOrder.body[0].stock, 5);

  const cancellation = await jsonRequest(
    `${app.baseUrl}/api/admin/orders/${encodeURIComponent(order.body.id)}/status`,
    {
      method: "PUT",
      headers: { Cookie: auth.cookie },
      body: JSON.stringify({ status: "cancelled" }),
    }
  );
  assert.equal(cancellation.body.status, "cancelled");

  const productsAfterCancellation = await jsonRequest(`${app.baseUrl}/api/products`);
  assert.equal(productsAfterCancellation.body[0].stock, 7);
});

test("admin product CRUD and ordering are persisted", async (context) => {
  const app = await startTestServer();
  context.after(app.close);
  const auth = await login(app.baseUrl);

  const create = await jsonRequest(`${app.baseUrl}/api/admin/products`, {
    method: "POST",
    headers: { Cookie: auth.cookie },
    body: JSON.stringify({
      category: "pastry",
      name: "New bun",
      description: "A product used to test creation and ordering.",
      image: "assets/bakery-2.jfif",
      price: 80,
      stock: 3,
    }),
  });
  assert.equal(create.response.status, 201);

  const reorder = await jsonRequest(`${app.baseUrl}/api/admin/products/order`, {
    method: "PUT",
    headers: { Cookie: auth.cookie },
    body: JSON.stringify({ productIds: [create.body.id, "test-bread"] }),
  });
  assert.deepEqual(
    reorder.body.map((product) => product.id),
    [create.body.id, "test-bread"]
  );

  const remove = await jsonRequest(
    `${app.baseUrl}/api/admin/products/${encodeURIComponent(create.body.id)}`,
    {
      method: "DELETE",
      headers: { Cookie: auth.cookie },
    }
  );
  assert.equal(remove.response.status, 200);
});

test("password change revokes sessions and replaces the old password", async (context) => {
  const app = await startTestServer();
  context.after(app.close);
  const auth = await login(app.baseUrl);
  const newPassword = "Changed-Admin-456!";

  const change = await jsonRequest(`${app.baseUrl}/api/auth/password`, {
    method: "PUT",
    headers: { Cookie: auth.cookie },
    body: JSON.stringify({
      currentPassword: TEST_PASSWORD,
      newPassword,
    }),
  });
  assert.equal(change.response.status, 200);

  const oldSession = await jsonRequest(`${app.baseUrl}/api/admin/orders`, {
    headers: { Cookie: auth.cookie },
  });
  assert.equal(oldSession.response.status, 401);

  const oldLogin = await login(app.baseUrl, TEST_PASSWORD);
  assert.equal(oldLogin.response.status, 401);

  const newLogin = await login(app.baseUrl, newPassword);
  assert.equal(newLogin.response.status, 200);
});

test("login is rate limited after repeated failures", async (context) => {
  const app = await startTestServer();
  context.after(app.close);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const failed = await login(app.baseUrl, "wrong-password");
    assert.equal(failed.response.status, 401);
  }

  const blocked = await login(app.baseUrl, TEST_PASSWORD);
  assert.equal(blocked.response.status, 429);
  assert.equal(blocked.response.headers.get("retry-after"), "900");
});
