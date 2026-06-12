"use strict";

const path = require("node:path");
const { createFileStore } = require("./file-store");

function createStoreFromEnvironment(options = {}) {
  const connectionString = options.connectionString || process.env.DATABASE_URL;

  if (connectionString) {
    const { createPostgresStore } = require("./postgres-store");
    return createPostgresStore({ connectionString });
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("В production необходимо задать DATABASE_URL.");
  }

  console.warn(
    "DATABASE_URL не задан: используется файловое хранилище только для локальной разработки."
  );
  return createFileStore({
    dataDirectory: options.dataDirectory || path.join(__dirname, "..", "data"),
  });
}

module.exports = { createStoreFromEnvironment };
