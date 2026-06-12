(function () {
  "use strict";

  async function request(url, options = {}) {
    const response = await fetch(url, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload.error || "Ошибка авторизации.");
    }

    return payload;
  }

  window.AdminAuth = {
    login(username, password) {
      return request("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
    },
    logout() {
      return request("/api/auth/logout", { method: "POST" });
    },
    getSession() {
      return request("/api/auth/session");
    },
    changePassword(currentPassword, newPassword) {
      return request("/api/auth/password", {
        method: "PUT",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
    },
  };
})();
