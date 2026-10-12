import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  createBrowserRouter,
  Navigate,
  Outlet,
  RouterProvider,
  useLocation,
  type RouteObject,
} from "react-router";
import { Layout } from "./components/Layout";
import { ErrorNotice, ToastProvider } from "./components/ui";
import { ApiError, setUnauthenticatedHandler } from "./lib/api";
import { useMe } from "./lib/queries";
import { AdminPage } from "./pages/Admin";
import { DashboardPage } from "./pages/Dashboard";
import { LoginPage } from "./pages/Login";
import { MeetingDetailPage } from "./pages/MeetingDetail";
import { MeetingsPage } from "./pages/Meetings";
import { OnboardingPage } from "./pages/Onboarding";
import { NotFoundPage, PrivacyPage } from "./pages/Privacy";
import { SettingsPage } from "./pages/Settings";

/** Guards private routes: unauthenticated users go to sign-in; new users go to onboarding. */
function RequireAuth() {
  const me = useMe();
  const location = useLocation();
  if (me.isLoading)
    return (
      <p className="muted" style={{ padding: "2rem" }}>
        Loading…
      </p>
    );
  if (me.isError) {
    return (
      <div style={{ padding: "2rem" }}>
        <ErrorNotice error={me.error} onRetry={() => void me.refetch()} />
      </div>
    );
  }
  if (!me.data) return <Navigate to="/login" replace />;
  if (
    !me.data.recordingNoticeAcknowledgedAt &&
    location.pathname === "/" &&
    !sessionStorageGet("onboarding-skipped")
  ) {
    return <Navigate to="/onboarding" replace />;
  }
  return <Layout me={me.data} />;
}

function sessionStorageGet(k: string): string | null {
  try {
    return sessionStorage.getItem(k);
  } catch {
    return null;
  }
}

function PublicOnly() {
  const me = useMe();
  if (me.data) return <Navigate to="/" replace />;
  return <Outlet />;
}

export const routes: RouteObject[] = [
  { path: "/privacy", element: <PrivacyPage /> },
  { element: <PublicOnly />, children: [{ path: "/login", element: <LoginPage /> }] },
  {
    element: <RequireAuth />,
    children: [
      { path: "/", element: <DashboardPage /> },
      { path: "/onboarding", element: <OnboardingPage /> },
      { path: "/meetings", element: <MeetingsPage /> },
      { path: "/meetings/:meetingId", element: <MeetingDetailPage /> },
      { path: "/settings", element: <SettingsPage /> },
      { path: "/admin", element: <AdminPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (count, err) =>
          !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
        refetchOnWindowFocus: true,
      },
    },
  });
}

const queryClient = makeQueryClient();
const router = createBrowserRouter(routes);

export function App() {
  useEffect(() => {
    // Session expired / revoked anywhere: refresh identity, which routes to sign-in.
    setUnauthenticatedHandler(() => {
      if (!window.location.pathname.startsWith("/login"))
        void queryClient.invalidateQueries({ queryKey: ["me"] });
    });
    return () => setUnauthenticatedHandler(null);
  }, []);
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  );
}
