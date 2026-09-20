/**
 * The application shell: header, top navigation, and the complete route
 * table.
 *
 * WHY every route lives in this one file: the URL is the admin's state.
 * Each page is a refreshable address (the M5 done-when names
 * /admin/nodes/tokyo01/config), so the table below is the whole map of
 * the app and there is no navigation path hidden inside a component.
 */
import { Navigate, NavLink, Route, Routes } from "react-router";

import FleetPage from "./pages/FleetPage";
import NodeConfigPage from "./pages/NodeConfigPage";
import NodeKeysPage from "./pages/NodeKeysPage";
import NodeLayout from "./pages/NodeLayout";
import NodeProfilesPage from "./pages/NodeProfilesPage";
import NodeUsersPage from "./pages/NodeUsersPage";
import NotFoundPage from "./pages/NotFoundPage";
import UserEditPage from "./pages/UserEditPage";
import UsersPage from "./pages/UsersPage";

export default function App() {
  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6">
      <Header />
      <main className="mt-5">
        <Routes>
          <Route path="/" element={<Navigate to="/nodes" replace />} />
          <Route path="/nodes" element={<FleetPage />} />
          <Route path="/nodes/:nodeId" element={<NodeLayout />}>
            <Route index element={<Navigate to="config" replace />} />
            <Route path="config" element={<NodeConfigPage />} />
            <Route path="keys" element={<NodeKeysPage />} />
            <Route path="users" element={<NodeUsersPage />} />
            <Route path="profiles" element={<NodeProfilesPage />} />
          </Route>
          <Route path="/users" element={<UsersPage />} />
          <Route path="/users/new" element={<UserEditPage />} />
          <Route path="/users/:username" element={<UserEditPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
    </div>
  );
}

/** The top bar: brand plus the two fleet-level destinations. */
function Header() {
  return (
    <header className="flex items-center gap-6 rounded-2xl border border-apple-border bg-apple-card px-5 py-3 shadow-sm">
      <span className="text-lg font-bold tracking-tight">Lesserv</span>
      <NavLink to="/nodes" className={navClass}>
        Nodes
      </NavLink>
      <NavLink to="/users" className={navClass}>
        Users
      </NavLink>
    </header>
  );
}

/** Active/inactive styling for the top-level navigation links. */
function navClass({ isActive }: { isActive: boolean }) {
  return isActive
    ? "text-sm font-semibold text-apple-blue"
    : "text-sm font-medium text-apple-muted hover:text-apple-text";
}
