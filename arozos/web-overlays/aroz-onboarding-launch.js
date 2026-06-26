/** Auto-open Welcome onboarding once per session when incomplete. */
(function () {
  var DISMISS_KEY = "joshu-onboarding-dismissed";
  var LAUNCHED_KEY = "joshu-onboarding-launched";

  function tryLaunch() {
    if (sessionStorage.getItem(DISMISS_KEY) || sessionStorage.getItem(LAUNCHED_KEY)) return;
    if (typeof fetch !== "function" || typeof openModule !== "function") return;

    fetch("/joshu/api/onboarding/status", { credentials: "same-origin" })
      .then(function (res) {
        return res.json();
      })
      .then(function (body) {
        if (body && body.completed === false) {
          sessionStorage.setItem(LAUNCHED_KEY, "1");
          openModule("Welcome");
        }
      })
      .catch(function () {
        /* Joshu API unavailable — skip */
      });
  }

  if (document.readyState === "complete") {
    setTimeout(tryLaunch, 1200);
  } else {
    window.addEventListener("load", function () {
      setTimeout(tryLaunch, 1200);
    });
  }
})();
