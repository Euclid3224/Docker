"use strict";

require("../lib/load-env").loadEnv();

const { createPostgresStore } = require("../lib/postgres-store");
const { hashPassword, validatePassword } = require("../lib/password");

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("Задайте DATABASE_URL.");
  }

  const username = String(process.argv[2] || "").trim();
  const password = String(process.argv[3] || "");

  if (!username || !password) {
    throw new Error(
      'Использование: node scripts/set-admin-password.js "admin" "НовыйНадёжныйПароль"'
    );
  }

  validatePassword(password);
  const store = createPostgresStore({ connectionString: process.env.DATABASE_URL });

  try {
    await store.init();
    const user = await store.findUserByUsername(username.toLowerCase());
    if (!user) {
      throw new Error("Пользователь не найден.");
    }
    await store.updateUserPassword(user.id, await hashPassword(password));
    await store.deleteUserSessions(user.id);
    console.log(`Пароль пользователя ${user.username} обновлён. Все сессии завершены.`);
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
