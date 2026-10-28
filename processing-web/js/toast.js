/**
 * Minimal transient toast notifications (bottom-center).
 * Used for non-blocking failures the user should know about
 * (e.g. a map layer that could not be loaded).
 */

/** Show a short-lived toast message. */
export function showToast(message, { duration = 5000 } = {}) {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.setAttribute("aria-live", "polite");
    document.body.appendChild(container);
  }

  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  container.appendChild(el);

  // Enter on the next frame so the transition runs
  requestAnimationFrame(() => el.classList.add("show"));

  const dismiss = () => {
    el.classList.remove("show");
    el.addEventListener("transitionend", () => el.remove(), { once: true });
  };
  setTimeout(dismiss, duration);

  return el;
}
