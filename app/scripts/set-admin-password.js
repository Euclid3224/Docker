"use strict";

require("../lib/load-env").loadEnv();

const { createPostgresStore } = require("../lib/postgres-store");
const { hashPassword, validatePassword } = require("../lib/password");

async function readPassword() {
  if (!process.stdin.isTTY) {
    let password = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      password += chunk;
    }
    return password.replace(/\r?\n$/, "");
  }

  return new Promise((resolve, reject) => {
    let password = "";

    function cleanup() {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }

    function onData(chunk) {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("Операция отменена."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(password);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          password = password.slice(0, -1);
        } else if (character >= " ") {
          password += character;
        }
      }
    }

    process.stdout.write("Новый пароль: ");
    process.stdin.setEncoding("utf8");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

async function main() {
  const username = String(process.argv[2] || "").trim();

  if (!username) {
    throw new Error(
      'Использование: node scripts/set-admin-password.js "admin"'
    );
  }
  if (process.argv[3]) {
    throw new Error("Не передавайте пароль в аргументах командной строки.");
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("Задайте DATABASE_URL.");
  }

  const password = await readPassword();
  validatePassword(password);
  const store = createPostgresStore({ connectionString: process.env.DATABASE_URL });

  try {
    await store.init();
    const user = await store.findUserByUsername(username.toLowerCase());
    if (!user) {
      throw new Error("Пользователь не найден.");
    }
    await store.updateUserPasswordAndDeleteSessions(
      user.id,
      await hashPassword(password)
    );
    console.log(`Пароль пользователя ${user.username} обновлён. Все сессии завершены.`);
  } finally {
    await store.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { main, readPassword };
