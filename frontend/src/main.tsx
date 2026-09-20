/**
 * The SPA entry point.
 *
 * WHY basename="/admin": Vite's base is '/admin/' and Workers serves the
 * built assets from that prefix, so the router must strip the same prefix
 * before matching routes. The two values are one decision living in two
 * files (vite.config.ts and here) and must move together.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";

import App from "./App";
import "./index.css";

const container = document.getElementById("app");
if (!container) {
  throw new Error("index.html is missing the #app container");
}

createRoot(container).render(
  <StrictMode>
    <BrowserRouter basename="/admin">
      <App />
    </BrowserRouter>
  </StrictMode>,
);
