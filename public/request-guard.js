(function () {
  function createLatestRequestGuard() {
    let currentId = 0;
    let currentController = null;

    return {
      next() {
        currentId += 1;
        if (currentController) currentController.abort();

        const id = currentId;
        currentController = new AbortController();

        return {
          signal: currentController.signal,
          isCurrent() {
            return id === currentId;
          },
        };
      },
    };
  }

  globalThis.createLatestRequestGuard = createLatestRequestGuard;
})();
