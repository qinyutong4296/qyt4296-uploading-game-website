import { Navigate, Route, Routes } from "react-router-dom";
import { AdminAuthProvider } from "./AdminAuth";
import AdminGuard from "./AdminGuard";
import AdminLayout from "./AdminLayout";
import DashboardPage from "./pages/DashboardPage";
import GamesPage from "./pages/GamesPage";
import GameEditPage from "./pages/GameEditPage";
import MembersPage from "./pages/MembersPage";
import ScoresPage from "./pages/ScoresPage";
import SessionsPage from "./pages/SessionsPage";
import AuditPage from "./pages/AuditPage";

/**
 * 云端管理后台入口。挂载于 /admin/*。
 * 认证、数据、文件全部走 WorkBuddy 云服务,与本地 Express 后台相互独立。
 */
export default function CloudAdminApp() {
  return (
    <AdminAuthProvider>
      <AdminGuard>
        <Routes>
          <Route element={<AdminLayout />}>
            <Route index element={<DashboardPage />} />
            <Route path="games" element={<GamesPage />} />
            <Route path="games/new" element={<GameEditPage />} />
            <Route path="games/:id/edit" element={<GameEditPage />} />
            <Route path="members" element={<MembersPage />} />
            <Route path="scores" element={<ScoresPage />} />
            <Route path="sessions" element={<SessionsPage />} />
            <Route path="audit" element={<AuditPage />} />
            <Route path="*" element={<Navigate to="/admin" replace />} />
          </Route>
        </Routes>
      </AdminGuard>
    </AdminAuthProvider>
  );
}
