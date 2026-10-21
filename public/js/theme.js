// Sayfa çizilmeden önce temayı uygular (yanıp sönmeyi engeller)
(function () {
  var t = 'dark';
  try { t = localStorage.getItem('klipo.theme') || 'dark'; } catch (e) {}
  var dark = t === 'dark' || (t === 'system' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  var m = document.getElementById('meta-theme');
  if (m) m.setAttribute('content', dark ? '#0a0a0f' : '#ffffff');
})();
