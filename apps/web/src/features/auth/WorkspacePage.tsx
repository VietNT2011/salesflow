import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest, ApiClientError } from '../../api/client.js';

interface Workspace {
  id: string;
  name: string;
  slug: string;
  role: string;
}

export function WorkspacePage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const workspaces = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => apiRequest<{ data: Workspace[] }>('/workspaces'),
  });

  async function create(formData: FormData) {
    setError('');
    try {
      await apiRequest('/workspaces', {
        method: 'POST',
        body: JSON.stringify({
          name: formData.get('name'),
          slug: formData.get('slug'),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      await queryClient.invalidateQueries({ queryKey: ['workspaces'] });
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : 'Không thể tạo workspace');
    }
  }

  return (
    <section>
      <p className="eyebrow">Workspace của bạn</p>
      <h1>Thiết lập nơi làm việc.</h1>
      {workspaces.data?.data.length ? (
        <div className="workspace-list">
          {workspaces.data.data.map((workspace) => (
            <article key={workspace.id}>
              <span>{workspace.role}</span>
              <h2>{workspace.name}</h2>
              <p>/{workspace.slug}</p>
            </article>
          ))}
        </div>
      ) : (
        <form className="workspace-form" action={create}>
          <label>
            Tên workspace
            <input name="name" required minLength={2} placeholder="Acme Support" />
          </label>
          <label>
            Đường dẫn
            <input
              name="slug"
              required
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              placeholder="acme-support"
            />
          </label>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <button type="submit">Tạo workspace</button>
        </form>
      )}
    </section>
  );
}
