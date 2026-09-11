// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App.js';

function renderApp(path: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <App initialEntries={[path]} />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe('web shell', () => {
  it('renders the dashboard and navigation', () => {
    renderApp('/');
    expect(screen.getByRole('heading', { name: /Mọi cuộc hội thoại/i })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Điều hướng chính' })).toBeInTheDocument();
  });

  it('routes to the Customer 360 feature', () => {
    renderApp('/customers');
    expect(screen.getByRole('heading', { name: 'Chưa có workspace.' })).toBeInTheDocument();
  });

  it('routes to the CRM order feature', () => {
    renderApp('/orders');
    expect(screen.getByRole('heading', { name: 'Chưa có workspace.' })).toBeInTheDocument();
  });

  it('routes to the task dashboard', () => {
    renderApp('/tasks');
    expect(screen.getByRole('heading', { name: 'Chưa có workspace.' })).toBeInTheDocument();
  });

  it('routes to the support ticket queue', () => {
    renderApp('/tickets');
    expect(screen.getByRole('heading', { name: 'Chưa có workspace.' })).toBeInTheDocument();
  });

  it('renders the F01 sign-in screen', () => {
    renderApp('/login');
    expect(screen.getByRole('heading', { name: 'Đăng nhập SalesFlow' })).toBeInTheDocument();
  });
});
