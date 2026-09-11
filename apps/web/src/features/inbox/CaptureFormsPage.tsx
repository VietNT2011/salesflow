import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiClientError, apiRequest } from '../../api/client.js';

interface Workspace {
  id: string;
  name: string;
  role: string;
}
interface CaptureForm {
  id: string;
  publicId: string;
  name: string;
  status: string;
  version: number;
}

export function CaptureFormsPage() {
  const [notice, setNotice] = useState('');
  const queryClient = useQueryClient();
  const workspaces = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => apiRequest<{ data: Workspace[] }>('/workspaces'),
  });
  const workspace = workspaces.data?.data[0];
  const forms = useQuery({
    queryKey: ['capture-forms', workspace?.id],
    enabled: Boolean(workspace),
    queryFn: () =>
      apiRequest<{ data: CaptureForm[] }>(`/workspaces/${workspace?.id}/capture-forms`),
  });
  async function create(formData: FormData) {
    if (!workspace) return;
    try {
      const created = await apiRequest<{ data: CaptureForm }>(
        `/workspaces/${workspace.id}/capture-forms`,
        {
          method: 'POST',
          body: JSON.stringify({
            name: formData.get('name'),
            source: 'WEBSITE',
            consentText: formData.get('consentText') || undefined,
            allowedOrigins: String(formData.get('allowedOrigin') ?? '').trim()
              ? [formData.get('allowedOrigin')]
              : [],
            createTicket: formData.get('createTicket') === 'on',
            fields: [
              { key: 'name', label: 'Họ tên', required: true },
              { key: 'email', label: 'Email', required: true },
              { key: 'message', label: 'Nội dung', required: true },
            ],
          }),
        },
      );
      await apiRequest(`/workspaces/${workspace.id}/capture-forms/${created.data.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ version: created.data.version, status: 'PUBLISHED' }),
      });
      await queryClient.invalidateQueries({ queryKey: ['capture-forms', workspace.id] });
      setNotice('Đã tạo và publish form.');
    } catch (cause) {
      setNotice(cause instanceof ApiClientError ? cause.message : 'Không thể tạo form');
    }
  }
  if (!workspace)
    return (
      <section>
        <p className="eyebrow">Website capture</p>
        <h1>Chưa có workspace.</h1>
      </section>
    );
  return (
    <section className="customer-page">
      <p className="eyebrow">{workspace.name} · public capture</p>
      <h1>Form & webchat.</h1>
      <div className="customer-grid">
        <div className="customer-list">
          {(forms.data?.data ?? []).map((form) => (
            <article key={form.id}>
              <span className="lifecycle">{form.status}</span>
              <h2>{form.name}</h2>
              <a href={`/forms/${form.publicId}`}>Mở public form</a> ·{' '}
              <a href={`/chat/${form.publicId}`}>Mở webchat</a>
            </article>
          ))}
        </div>
        <form action={create} className="customer-create">
          <h2>Tạo capture form</h2>
          <label>
            Tên
            <input name="name" required />
          </label>
          <label>
            Origin được phép
            <input name="allowedOrigin" type="url" placeholder="https://example.com" />
          </label>
          <label>
            Nội dung consent
            <textarea name="consentText" />
          </label>
          <label>
            <input name="createTicket" type="checkbox" /> Tự tạo ticket
          </label>
          <button>Tạo và publish</button>
          {notice && <p role="status">{notice}</p>}
        </form>
      </div>
    </section>
  );
}
