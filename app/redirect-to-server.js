(function () {
  "use strict";

  if (window.location.protocol !== "file:") {
    return;
  }

  const path = window.location.pathname.replace(/\\/g, "/").toLowerCase();
  let serverPath = "/index.html";

  if (path.endsWith("/menu.html")) {
    serverPath = "/menu.html";
  } else if (path.endsWith("/admin/index.html")) {
    serverPath = "/admin/";
  }

  window.location.replace(
    `http://localhost:3000${serverPath}${window.location.search}${window.location.hash}`
  );
})();
