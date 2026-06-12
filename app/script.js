(function () {
  "use strict";

  const menuToggle = document.querySelector(".menu-toggle");
  const mainNav = document.querySelector(".main-nav");

  if (menuToggle && mainNav) {
    const mobileNavigation = window.matchMedia("(max-width: 760px)");

    function setMenuState(isOpen, restoreFocus = false) {
      const openOnMobile = mobileNavigation.matches && isOpen;
      mainNav.classList.toggle("is-open", openOnMobile);
      mainNav.inert = mobileNavigation.matches && !openOnMobile;
      mainNav.setAttribute(
        "aria-hidden",
        String(mobileNavigation.matches && !openOnMobile)
      );
      menuToggle.classList.toggle("is-open", openOnMobile);
      menuToggle.setAttribute("aria-expanded", String(openOnMobile));
      menuToggle.setAttribute(
        "aria-label",
        openOnMobile ? "Закрыть меню" : "Открыть меню"
      );

      if (restoreFocus) {
        menuToggle.focus();
      }
    }

    menuToggle.addEventListener("click", () => {
      setMenuState(menuToggle.getAttribute("aria-expanded") !== "true");
    });

    mainNav.addEventListener("click", () => {
      setMenuState(false);
    });

    document.addEventListener("click", (event) => {
      if (!event.target.closest(".site-header")) {
        setMenuState(false);
      }
    });

    document.addEventListener("keydown", (event) => {
      if (
        event.key === "Escape" &&
        menuToggle.getAttribute("aria-expanded") === "true"
      ) {
        setMenuState(false, true);
      }
    });

    mobileNavigation.addEventListener("change", () => setMenuState(false));
    setMenuState(false);
  }

  const revealItems = document.querySelectorAll(
    ".section, .catalog-card, .gallery-grid img, blockquote"
  );

  if ("IntersectionObserver" in window) {
    revealItems.forEach((item) => item.classList.add("reveal"));

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.1 }
    );

    revealItems.forEach((item) => observer.observe(item));
  }
})();
