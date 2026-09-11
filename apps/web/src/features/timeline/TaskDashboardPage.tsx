import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { ApiClientError, apiRequest } from '../../api/client.js';
import type { CustomerTask } from './TaskPanel.js';

interface Workspace {
  id: string;
  name: string;
}

export function TaskDashboardPage() {
  const [scope, setScope] = useState('TODAY');
  const [message, setMessage] = useState('');
  const queryClient = useQueryClient();
  const workspaces = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => apiRequest<{ data: Workspace[] }>('/workspaces'),
  });
  const workspace = workspaces.data?.data[0];
  const taskQuery = useQuery({
    queryKey: ['task-dashboard', workspace?.id, scope],
    enabled: Boolean(workspace),
    queryFn: () =>
      apiRequest<{ data: CustomerTask[] }>(
        `/workspaces/${workspace?.id}/tasks?scope=${scope}&status=OPEN`,
      ),
  });

  async function complete(task: CustomerTask) {
    if (!workspace) return;
    try {
      await apiRequest(`/workspaces/${workspace.id}/tasks/${task.id}/complete`, {
        method: 'POST',
        body: JSON.stringify({ version: task.version }),
      });
      await queryClient.invalidateQueries({ queryKey: ['task-dashboard', workspace.id] });
    } catch (cause) {
      setMessage(cause instanceof ApiClientError ? cause.message : 'Không thể hoàn tất công việc');
    }
  }

  if (!workspace) {
    return (
      <section>
        <p className="eyebrow">Việc chăm sóc</p>
        <h1>Chưa có workspace.</h1>
      </section>
    );
  }
  return (
    <section className="customer-page">
      <p className="eyebrow">{workspace.name} · Agent dashboard</p>
      <h1>Việc chăm sóc.</h1>
      <div className="customer-toolbar">
        <button type="button" onClick={() => setScope('TODAY')}>
          Hôm nay
        </button>
        <button type="button" onClick={() => setScope('OVERDUE')}>
          Quá hạn
        </button>
        <button type="button" onClick={() => setScope('ALL')}>
          Tất cả
        </button>
      </div>
      <div className="customer-list">
        {taskQuery.data?.data.map((task) => (
          <div key={task.id}>
            <Link to={`/customers/${task.customerId}`}>
              <h2>{task.title}</h2>
              <small>{new Date(task.dueAt).toLocaleString('vi-VN')}</small>
            </Link>
            <button type="button" onClick={() => void complete(task)}>
              Hoàn tất
            </button>
          </div>
        ))}
        {!taskQuery.isLoading && !taskQuery.data?.data.length && <p>Không có công việc phù hợp.</p>}
      </div>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
