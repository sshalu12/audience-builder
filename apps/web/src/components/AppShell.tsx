import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export function AppShell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  function onLogout() {
    logout();
    navigate("/login");
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <Link to="/conversations" className="brand">
          Audience Builder
        </Link>
        <nav>
          <NavLink to="/conversations">Conversations</NavLink>
          {user?.role === "ADMIN" && <NavLink to="/admin">Admin</NavLink>}
        </nav>
        <div className="topbar-user">
          <span>{user?.email}</span>
          <span className="role-pill">{user?.role}</span>
          <button onClick={onLogout} className="button secondary small">
            Logout
          </button>
        </div>
      </header>
      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}
