// Moved out of index.html's inline <script> so it still runs under a CSP that only allows
// script-src 'self' (an inline block with no nonce/hash would otherwise be blocked outright).
// alert() previously blocked the entire UI on any unexpected error — logging to the console
// is enough for debugging without interrupting whatever the user was doing.
window.onerror = function (message, source, lineno, colno, error) {
  console.error("Uncaught error:", message, error);
};
window.addEventListener('unhandledrejection', function (event) {
  console.error("Unhandled promise rejection:", event.reason);
});
