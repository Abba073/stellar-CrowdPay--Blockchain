// Returns form controls that have no programmatic label (placeholder does not count).
export function findUnlabeledControls(container) {
  return [...container.querySelectorAll('input:not([type="hidden"]), select, textarea')].filter(
    (el) =>
      !el.getAttribute('aria-label') &&
      !el.getAttribute('aria-labelledby') &&
      !el.closest('label') &&
      !(el.id && container.querySelector(`label[for="${el.id}"]`))
  );
}
