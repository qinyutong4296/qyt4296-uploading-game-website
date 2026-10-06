import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth/AuthContext";
import LoginPage from "./auth/LoginPage";
import RegisterPage from "./auth/RegisterPage";
import ProtectedRoute from "./auth/ProtectedRoute";
import LobbyPage from "./pages/LobbyPage";
import GamePage from "./pages/GamePage";
import ProfilePage from "./pages/ProfilePage";
import UploadPage from "./pages/UploadPage";
import RanksPage from "./pages/RanksPage";
import BoardPage from "./pages/BoardPage";
import AppShell from "./layout/AppShell";
import AdminShell from "./admin/AdminShell";
import AdminDashboard from "./admin/AdminDashboard";
import AdminGamesPage from "./admin/AdminGamesPage";
import AdminSessionsPage from "./admin/AdminSessionsPage";

function HomeRedirect() {
  const { user, ready } = useAuth();
  if (!ready) return <div className="muted" style={{ padding: 40 }}>加载中…</div>;
  return <Navigate to={user ? "/lobby" : "/login"} replace />;
}

function Guard({ children }: { children: React.ReactNode }) {
  return <ProtectedRoute>{children}</ProtectedRoute>;
}

function AdminGuard({ children }: { children: React.ReactNode }) {
  const { user, ready } = useAuth();
  if (!ready) return <div className="muted" style={{ padding: 40 }}>加载中…</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (!user.isAdmin) return <Navigate to="/lobby" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      {/* 本地管理后台(本机账号体系 + 本机 SQLite 数据) */}
      <Route
        path="/admin"
        element={
          <AdminGuard>
            <AdminShell />
          </AdminGuard>
        }
      >
        <Route index element={<AdminDashboard />} />
        <Route path="games" element={<AdminGamesPage />} />
        <Route path="sessions" element={<AdminSessionsPage />} />
      </Route>

      <Route
        path="*"
        element={
          <AppShell>
            <Routes>
              <Route path="/" element={<HomeRedirect />} />
              <Route path="/login" element={<LoginPage />} />
              <Route path="/register" element={<RegisterPage />} />
              <Route path="/lobby" element={<Guard><LobbyPage /></Guard>} />
              <Route path="/workshop" element={<Guard><LobbyPage mode="workshop" /></Guard>} />
              <Route path="/ranks" element={<Guard><RanksPage /></Guard>} />
              <Route path="/board" element={<Guard><BoardPage /></Guard>} />
              <Route path="/play/:gameId" element={<Guard><GamePage /></Guard>} />
              <Route path="/upload" element={<Guard><UploadPage /></Guard>} />
              <Route path="/profile" element={<Guard><ProfilePage /></Guard>} />
              <Route path="*" element={<HomeRedirect />} />
            </Routes>
          </AppShell>
        }
      />
    </Routes>
  );
}
