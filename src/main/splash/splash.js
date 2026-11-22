// Splash controller. Main drives it with executeJavaScript calls whose arguments are JSON-stringified constants only.
// All text goes through textContent (never innerHTML).
(function () {
  var steps = document.getElementById('steps');
  var current = null;
  function markDone(li) {
    if (!li) return;
    li.className = 'done';
  }
  window.__splash = {
    init: function (name, version, lang) {
      document.getElementById('name').textContent = String(name);
      document.getElementById('version').textContent = String(version);
      document.documentElement.lang = lang === 'es' ? 'es' : 'en';
    },
    step: function (key, label) {
      markDone(current);
      var li = document.createElement('li');
      li.className = 'active';
      li.setAttribute('data-step', String(key));
      var ic = document.createElement('span');
      ic.className = 'ic';
      var tx = document.createElement('span');
      tx.textContent = String(label);
      li.appendChild(ic);
      li.appendChild(tx);
      steps.appendChild(li);
      current = li;
    },
    finish: function () { markDone(current); current = null; },
  };
})();
