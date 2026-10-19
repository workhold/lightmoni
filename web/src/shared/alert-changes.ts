const alertChangedEvent = 'lightmoni:alert-changed';

export function publishAlertChange() {
  window.dispatchEvent(new CustomEvent(alertChangedEvent));
}

export function subscribeAlertChanges(refresh: () => void) {
  window.addEventListener(alertChangedEvent, refresh);
  return () => window.removeEventListener(alertChangedEvent, refresh);
}
