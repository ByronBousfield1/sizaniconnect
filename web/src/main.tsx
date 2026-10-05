import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Loading } from './components/ui';
import { AuthProvider, homeFor, useAuth } from './lib/auth';
import type { Role } from './lib/types';
import { AuditPage, SitesPage, UsersPage } from './pages/Admin';
import { ForgotPasswordPage, LoginPage, ResetPasswordPage } from './pages/Auth';
import { DeskPage } from './pages/Desk';
import { DonationsPage } from './pages/Donations';
import { DonorPortalPage, ReceiptPage } from './pages/Donor';
import { EventDetailPage, EventsPage } from './pages/Events';
import { HouseholdDetailPage, HouseholdNewPage, HouseholdsPage } from './pages/Households';
import { OverviewPage } from './pages/Overview';
import { ReportsPage } from './pages/Reports';
import { ShiftsPage } from './pages/Shifts';
import { StockPage } from './pages/Stock';
import './styles.css';

/** Hides screens a role cannot use. The API enforces the same rules; this is courtesy, not security. */
function Guard({ roles, children }: { roles?: Role[]; children: ReactNode }) {
  const { user, ready } = useAuth();
  const location = useLocation();
  if (!ready) return <Loading label="Signing you in" />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (roles && !roles.includes(user.role)) return <Navigate to={homeFor(user.role)} replace />;
  return <>{children}</>;
}

function Home() {
  const { user, ready } = useAuth();
  if (!ready) return <Loading label="Signing you in" />;
  return <Navigate to={user ? homeFor(user.role) : '/login'} replace />;
}

function NotFound() {
  return (
    <>
      <h1>Page not found</h1>
      <p>
        That address does not exist. <Link to="/">Go to your start page</Link>.
      </p>
    </>
  );
}

const STAFF: Role[] = ['Admin', 'OperationsManager', 'SiteCoordinator'];
const DESK: Role[] = ['SiteCoordinator', 'OperationsManager', 'Volunteer'];

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/" element={<Home />} />
      <Route
        element={
          <Guard>
            <Layout />
          </Guard>
        }
      >
        <Route path="/overview" element={<Guard roles={STAFF}><OverviewPage /></Guard>} />
        <Route path="/desk" element={<Guard roles={DESK}><DeskPage /></Guard>} />
        <Route path="/households" element={<Guard roles={STAFF}><HouseholdsPage /></Guard>} />
        <Route path="/households/new" element={<Guard roles={['SiteCoordinator', 'OperationsManager']}><HouseholdNewPage /></Guard>} />
        <Route path="/households/:id" element={<Guard roles={STAFF}><HouseholdDetailPage /></Guard>} />
        <Route path="/events" element={<Guard roles={STAFF}><EventsPage /></Guard>} />
        <Route path="/events/:id" element={<Guard roles={[...STAFF, 'Volunteer']}><EventDetailPage /></Guard>} />
        <Route path="/shifts" element={<Guard roles={['Volunteer', 'SiteCoordinator']}><ShiftsPage /></Guard>} />
        <Route path="/stock" element={<Guard roles={STAFF}><StockPage /></Guard>} />
        <Route path="/donations" element={<Guard roles={['OperationsManager', 'Admin']}><DonationsPage /></Guard>} />
        <Route path="/donations/:id/receipt" element={<Guard roles={['OperationsManager', 'Admin', 'Donor']}><ReceiptPage /></Guard>} />
        <Route path="/reports" element={<Guard roles={['OperationsManager', 'Admin']}><ReportsPage /></Guard>} />
        <Route path="/donor" element={<Guard roles={['Donor']}><DonorPortalPage /></Guard>} />
        <Route path="/admin/users" element={<Guard roles={['Admin']}><UsersPage /></Guard>} />
        <Route path="/admin/sites" element={<Guard roles={['Admin']}><SitesPage /></Guard>} />
        <Route path="/admin/audit" element={<Guard roles={['Admin']}><AuditPage /></Guard>} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <AuthProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AuthProvider>
    </StrictMode>,
  );
}
