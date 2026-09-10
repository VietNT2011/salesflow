import { Navigate, RouterProvider, createMemoryRouter, createBrowserRouter } from 'react-router';
import { Layout } from './Layout.js';
import { AcceptInvitationPage } from '../features/auth/AcceptInvitationPage.js';
import { AuthPage } from '../features/auth/AuthPage.js';
import { WorkspacePage } from '../features/auth/WorkspacePage.js';
import { MemberSettingsPage } from '../features/auth/MemberSettingsPage.js';
import { CustomerListPage } from '../features/customers/CustomerListPage.js';
import { CustomerProfilePage } from '../features/customers/CustomerProfilePage.js';
import { DuplicateReviewPage } from '../features/customers/DuplicateReviewPage.js';

function Dashboard() {
  return (
    <section>
      <p className="eyebrow">Customer service workspace</p>
      <h1>
        Mọi cuộc hội thoại.
        <br />
        Một góc nhìn khách hàng.
      </h1>
      <p className="intro">
        Nền tảng SalesFlow đã sẵn sàng. Các luồng nghiệp vụ sẽ được mở theo từng feature.
      </p>
      <div className="cards">
        <article>
          <span>01</span>
          <h2>Customer 360</h2>
          <p>Hồ sơ trung tâm cho danh tính và lịch sử.</p>
        </article>
        <article>
          <span>02</span>
          <h2>Omnichannel</h2>
          <p>Webchat và Messenger trong một inbox.</p>
        </article>
        <article>
          <span>03</span>
          <h2>SLA & Automation</h2>
          <p>Chăm sóc chủ động dựa trên dữ liệu.</p>
        </article>
      </div>
    </section>
  );
}

function FeaturePlaceholder() {
  return (
    <section>
      <p className="eyebrow">Coming in F01–F08</p>
      <h1>Module đang được chuẩn bị</h1>
    </section>
  );
}

const routes = [
  { path: '/login', element: <AuthPage /> },
  { path: '/accept-invitation', element: <AcceptInvitationPage /> },
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'onboarding', element: <WorkspacePage /> },
      { path: 'customers', element: <CustomerListPage /> },
      { path: 'customers/review', element: <DuplicateReviewPage /> },
      { path: 'customers/:customerId', element: <CustomerProfilePage /> },
      { path: 'inbox', element: <FeaturePlaceholder /> },
      { path: 'tickets', element: <FeaturePlaceholder /> },
      { path: 'tasks', element: <FeaturePlaceholder /> },
      { path: 'settings', element: <MemberSettingsPage /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
];

export function App({ initialEntries }: { initialEntries?: string[] }) {
  const router = initialEntries
    ? createMemoryRouter(routes, { initialEntries })
    : createBrowserRouter(routes);
  return <RouterProvider router={router} />;
}
