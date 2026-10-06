// Runs before every UI test file.
import "@testing-library/jest-dom/vitest";

// jsdom has no matchMedia, and the app asks about prefers-reduced-motion and
// the dark theme on the way up (it would throw before a test ran).
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

// jsdom has no scrollTo either (App.tsx scrolls to the top on navigation).
if (!window.scrollTo) {
  window.scrollTo = (() => {}) as typeof window.scrollTo;
}
