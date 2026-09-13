// Ambient types for this app. `PageState` is the shallow-routing payload the
// walkthrough carries so browser Back returns to the previous step instead of
// leaving the site.
declare global {
  namespace App {
    interface PageState {
      step?: number;
    }
  }
}

export {};
