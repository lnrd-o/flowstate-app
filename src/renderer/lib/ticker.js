// Re-run `fn` every `ms` while `el` is on the page (countdowns). Stops by itself once the element has been removed.
export function tick(el, fn, ms = 30000) {
  let seen = false;
  let idle = 0;
  fn();
  const id = setInterval(() => {
    if (el.isConnected) { seen = true; idle = 0; fn(); return; }
    idle += 1;
    if (seen || idle > 4) clearInterval(id);
  }, ms);
  return () => clearInterval(id);
}
