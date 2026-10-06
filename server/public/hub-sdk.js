(function () {
  var user = null;
  var save = null;
  var readyFns = [];
  var saveFns = [];

  window.addEventListener("message", function (e) {
    if (!e.data || e.data.type !== "hub:hello") return;
    user = e.data.user || null;
    save = e.data.save || null;
    readyFns.forEach(function (fn) { fn(user); });
    if (save) saveFns.forEach(function (fn) { fn(save); });
  });

  window.GameHub = {
    onReady: function (fn) {
      if (user) fn(user);
      else readyFns.push(fn);
    },
    submitScore: function (score) {
      parent.postMessage({ type: "hub:score", score: Number(score) || 0 }, "*");
    },
    save: function (data) {
      parent.postMessage({ type: "hub:save", data: data }, "*");
    },
    onSave: function (fn) {
      if (save) fn(save);
      else saveFns.push(fn);
    }
  };

  try {
    parent.postMessage({ type: "hub:need-hello" }, "*");
  } catch (err) {}
})();
