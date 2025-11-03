(function () {
  function navigateTo(href) {
    if (!href) return;
    window.location.href = href;
  }

  function initGlobalNavigation(options = {}) {
    const toggle = document.getElementById('navToggle');
    const drawer = document.getElementById('navDrawer');
    const backdrop = document.getElementById('navBackdrop');
    if (!toggle || !drawer || !backdrop) {
      return;
    }

    const closeBtn = document.getElementById('navClose');
    const focusableSelectors = 'a[href], button:not([disabled])';
    let lastFocusedElement = null;
    let closeTimer = null;
    let isOpen = false;

    const actionHandlers = {
      manageLocations: () => {
        if (typeof options.onManageLocations === 'function') {
          options.onManageLocations();
          return;
        }
        if (options.manageLocationsHref) {
          navigateTo(options.manageLocationsHref);
        }
      },
      connectCrm: () => {
        if (typeof options.onConnectCrm === 'function') {
          options.onConnectCrm();
        }
      },
      compareLocations: () => {
        if (typeof options.onCompareLocations === 'function') {
          options.onCompareLocations();
          return;
        }
        if (options.compareLocationsHref) {
          navigateTo(options.compareLocationsHref);
        }
      },
      showPricing: () => {
        if (typeof options.onShowPricing === 'function') {
          options.onShowPricing();
          return;
        }
        if (options.showPricingHref) {
          navigateTo(options.showPricingHref);
        }
      }
    };

    function applyHiddenState(hidden) {
      if (hidden) {
        drawer.setAttribute('hidden', '');
        backdrop.setAttribute('hidden', '');
      } else {
        drawer.removeAttribute('hidden');
        backdrop.removeAttribute('hidden');
      }
    }

    function closeDrawer(focusToggle = true) {
      if (!isOpen) {
        return;
      }

      drawer.classList.remove('open');
      backdrop.classList.remove('visible');
      toggle.classList.remove('is-active');
      toggle.setAttribute('aria-expanded', 'false');
      document.body.classList.remove('nav-open');
      isOpen = false;

      if (closeTimer) {
        clearTimeout(closeTimer);
      }
      closeTimer = setTimeout(() => {
        if (!isOpen) {
          applyHiddenState(true);
        }
      }, 250);

      if (focusToggle) {
        const target = lastFocusedElement || toggle;
        if (target && typeof target.focus === 'function') {
          target.focus({ preventScroll: true });
        }
      }
    }

    function openDrawer() {
      if (isOpen) {
        return;
      }
      lastFocusedElement = document.activeElement;
      applyHiddenState(false);
      requestAnimationFrame(() => {
        drawer.classList.add('open');
        backdrop.classList.add('visible');
        toggle.classList.add('is-active');
        toggle.setAttribute('aria-expanded', 'true');
        document.body.classList.add('nav-open');
        const focusTarget = drawer.querySelector(focusableSelectors);
        if (focusTarget) {
          focusTarget.focus({ preventScroll: true });
        }
      });
      isOpen = true;
    }

    function toggleDrawer() {
      if (isOpen) {
        closeDrawer();
      } else {
        openDrawer();
      }
    }

    toggle.addEventListener('click', toggleDrawer);

    backdrop.addEventListener('click', () => closeDrawer());
    if (closeBtn) {
      closeBtn.addEventListener('click', () => closeDrawer());
    }

    drawer.querySelectorAll('[data-nav-action]').forEach((item) => {
      item.addEventListener('click', (event) => {
        event.preventDefault();
        const action = item.getAttribute('data-nav-action');
        const handler = actionHandlers[action];
        if (handler) {
          handler();
        }
        closeDrawer(false);
      });
    });

    drawer.querySelectorAll('[data-nav-close]').forEach((item) => {
      item.addEventListener('click', () => closeDrawer(false));
    });

    drawer.querySelectorAll('a[href]').forEach((link) => {
      link.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          closeDrawer();
        }
      });
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeDrawer();
      }
    });

    window.addEventListener('resize', () => {
      if (isOpen && window.innerWidth >= 992) {
        closeDrawer();
      }
    });
  }

  window.initGlobalNavigation = initGlobalNavigation;
})();
