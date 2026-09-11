import { NavLink, Outlet } from 'react-router';

const navigation = [
  ['/', 'Tổng quan'],
  ['/customers', 'Khách hàng'],
  ['/orders', 'Đơn hàng'],
  ['/inbox', 'Hộp thư'],
  ['/tickets', 'Ticket'],
  ['/tasks', 'Công việc'],
  ['/settings', 'Cài đặt'],
] as const;

export function Layout() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span>SF</span>
          <strong>SalesFlow</strong>
        </div>
        <nav aria-label="Điều hướng chính">
          {navigation.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === '/'}>
              {label}
            </NavLink>
          ))}
        </nav>
        <p className="phase">Timeline & tasks · F04</p>
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
