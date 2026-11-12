// Plan 232 fixture. Loaded from the overlay's own folder: block d only gets
// a colour if this file and badge.css both arrived and the page runs.
;(function () {
  var blink = document.getElementById('blink')
  var hole = document.getElementById('hole')
  var ticker = document.getElementById('ticker')
  var started = Date.now()

  function tick() {
    var seconds = Math.floor((Date.now() - started) / 1000)
    var yellow = seconds % 2 === 0
    blink.classList.toggle('blink-yellow', yellow)
    blink.classList.toggle('blink-blue', !yellow)
    ticker.textContent = 'Videorc HTML overlay · ' + seconds + ' s'
  }
  tick()
  setInterval(tick, 100)

  // The network is off for overlays (plan 232 D5). Each of these must fail:
  // if one ever gets an answer, block c stops being a hole and the smoke
  // fails. The port is the smoke's own listener, which must hear nothing.
  var probe = 'http://127.0.0.1:13977/html-overlay-network-probe'
  function reached() {
    hole.classList.add('network-reached')
  }
  try {
    fetch(probe, { mode: 'no-cors', cache: 'no-store' }).then(reached, function () {})
  } catch (error) {
    // Blocked before it started: what should happen.
  }
  var image = new Image()
  image.onload = reached
  image.src = probe + '.png'
  try {
    var socket = new WebSocket('ws://127.0.0.1:13977/html-overlay-network-probe')
    socket.onopen = reached
  } catch (error) {
    // Blocked before it started: what should happen.
  }
})()
