import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiClientError, apiRequest } from '../../api/client.js';

export interface CustomerTask {
  id: string;
  customerId: string;
  title: string;
  dueAt: string;
  status: string;
  version: number;
}

export function TaskPanel({
  workspaceId,
  customerId,
  mayEdit,
}: {
  workspaceId: string;
  customerId: string;
  mayEdit: boolean;
}) {
  const [message, setMessage] = useState('');
  const queryClient = useQueryClient();
  const queryKey = ['tasks', workspaceId, customerId] as const;
  const taskQuery = useQuery({
    queryKey,
    queryFn: () =>
      apiRequest<{ data: CustomerTask[] }>(
        `/workspaces/${workspaceId}/tasks?customerId=${customerId}`,
      ),
  });

  async function create(formData: FormData) {
    try {
      await apiRequest(`/workspaces/${workspaceId}/customers/${customerId}/tasks`, {
        method: 'POST',
        body: JSON.stringify({
          title: formData.get('title'),
          dueAt: new Date(String(formData.get('dueAt'))).toISOString(),
        }),
      });
      await queryClient.invalidateQueries({ queryKey });
      setMessage('Đã tạo việc chăm sóc.');
    } catch (cause) {
      setMessage(cause instanceof ApiClientError ? cause.message : 'Không thể tạo công việc');
    }
  }

  async function complete(task: CustomerTask) {
    try {
      await apiRequest(`/workspaces/${workspaceId}/tasks/${task.id}/complete`, {
        method: 'POST',
        body: JSON.stringify({ version: task.version }),
      });
      await queryClient.invalidateQueries({ queryKey });
    } catch (cause) {
      setMessage(cause instanceof ApiClientError ? cause.message : 'Không thể hoàn tất công việc');
    }
  }

  return (
    <div className="profile-grid">
      <article className="contact-list">
        {taskQuery.data?.data.map((task) => (
          <div key={task.id}>
            <strong>{task.title}</strong>
            <span>{new Date(task.dueAt).toLocaleString('vi-VN')}</span>
            <small>{task.status}</small>
            {mayEdit && task.status === 'OPEN' && (
              <button type="button" onClick={() => void complete(task)}>
                Hoàn tất
              </button>
            )}
          </div>
        ))}
        {!taskQuery.isLoading && !taskQuery.data?.data.length && <p>Chưa có công việc.</p>}
      </article>
      {mayEdit && (
        <form className="settings-form" action={create}>
          <h2>Tạo việc chăm sóc</h2>
          <label>
            Tiêu đề
            <input name="title" required />
          </label>
          <label>
            Hạn xử lý
            <input name="dueAt" type="datetime-local" required />
          </label>
          <button type="submit">Tạo công việc</button>
          {message && <p role="status">{message}</p>}
        </form>
      )}
    </div>
  );
}
