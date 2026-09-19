// Placeholder shell for the admin SPA (M4): proves base '/admin/', the
// build layout, and the static-asset serving path end to end. M5 rebuilds
// the real UI here with a router and Tailwind; nothing about the serving
// arrangement changes then.
const app = document.getElementById("app");
if (app) {
  app.innerHTML =
    "<h1>Lesserv</h1><p>Admin placeholder — the real UI lands in M5.</p>";
}
