// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import { App } from './App.js';

describe('web shell', () => {
  it('renders the dashboard and navigation', () => {
    render(<App initialEntries={['/']} />);
    expect(screen.getByRole('heading', { name: /Mọi cuộc hội thoại/i })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Điều hướng chính' })).toBeInTheDocument();
  });

  it('routes to feature placeholders without implementing business UI', () => {
    render(<App initialEntries={['/customers']} />);
    expect(screen.getByRole('heading', { name: 'Module đang được chuẩn bị' })).toBeInTheDocument();
  });
});
