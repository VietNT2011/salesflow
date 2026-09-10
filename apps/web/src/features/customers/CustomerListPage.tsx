import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { apiRequest, ApiClientError } from '../../api/client.js';

interface Workspace {
  id: string;
  name: string;
  role: string;
}

interface Contact {
  id: string;
  type: string;
  value: string;
  isPrimary: boolean;
}

interface Customer {
  id: string;
  displayName: string | null;
  organizationName: string | null;
  type: string;
  lifecycle: string;
  version: number;
  contacts: Contact[];
}

interface DuplicateCandidate {
  id: string;
  displayName: string | null;
  organizationName: string | null;
  matches: string[];
}

export function CustomerListPage() {
  const [search, setSearch] = useState('');
  const [lifecycle, setLifecycle] = useState('');
  const [message, setMessage] = useState('');
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[]>([]);
  const [confirmedDuplicates, setConfirmedDuplicates] = useState(false);
  const queryClient = useQueryClient();
  const workspaces = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => apiRequest<{ data: Workspace[] }>('/workspaces'),
  });
  const workspace = workspaces.data?.data[0];
  const customers = useQuery({
    queryKey: ['customers', workspace?.id, search, lifecycle],
    enabled: Boolean(workspace),
    queryFn: () => {
      const query = new URLSearchParams({ limit: '50' });
      if (search) query.set('q', search);
      if (lifecycle) query.set('lifecycle', lifecycle);
      return apiRequest<{ data: Customer[]; meta: { nextCursor: string | null } }>(
        `/workspaces/${workspace?.id}/customers?${query}`,
      );
    },
  });

  async function createCustomer(formData: FormData) {
    if (!workspace) return;
    setMessage('');
    const contacts = [
      ...(String(formData.get('email') ?? '').trim()
        ? [
            {
              type: 'EMAIL',
              value: String(formData.get('email')),
              isPrimary: true,
            },
          ]
        : []),
      ...(String(formData.get('phone') ?? '').trim()
        ? [
            {
              type: 'PHONE',
              value: String(formData.get('phone')),
              country: 'VN',
              isPrimary: true,
            },
          ]
        : []),
    ];
    try {
      if (contacts.length && !confirmedDuplicates) {
        const preview = await apiRequest<{ data: DuplicateCandidate[] }>(
          `/workspaces/${workspace.id}/customers/duplicate-candidates`,
          { method: 'POST', body: JSON.stringify({ contacts }) },
        );
        if (preview.data.length) {
          setDuplicates(preview.data);
          setConfirmedDuplicates(true);
          setMessage(
            'Có hồ sơ trùng chính xác. Kiểm tra rồi bấm tạo lần nữa nếu vẫn muốn tiếp tục.',
          );
          return;
        }
      }
      const tagNames = String(formData.get('tags') ?? '')
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean);
      await apiRequest(`/workspaces/${workspace.id}/customers`, {
        method: 'POST',
        body: JSON.stringify({
          type: formData.get('type'),
          displayName: String(formData.get('displayName') ?? '').trim() || undefined,
          organizationName: String(formData.get('organizationName') ?? '').trim() || undefined,
          source: 'MANUAL',
          contacts,
          tagNames,
        }),
      });
      setDuplicates([]);
      setConfirmedDuplicates(false);
      setMessage('Đã tạo hồ sơ khách hàng.');
      await queryClient.invalidateQueries({ queryKey: ['customers', workspace.id] });
    } catch (cause) {
      setMessage(cause instanceof ApiClientError ? cause.message : 'Không thể tạo khách hàng');
    }
  }

  if (!workspace) {
    return (
      <section>
        <p className="eyebrow">Customer 360</p>
        <h1>Chưa có workspace.</h1>
        <Link to="/onboarding">Tạo workspace trước</Link>
      </section>
    );
  }

  return (
    <section className="customer-page">
      <div className="customer-heading">
        <div>
          <p className="eyebrow">{workspace.name} · Customer 360</p>
          <h1>Khách hàng.</h1>
        </div>
        {(workspace.role === 'ADMIN' || workspace.role === 'CS_MANAGER') && (
          <Link className="review-link" to="/customers/review">
            Hàng chờ trùng lặp
          </Link>
        )}
      </div>
      <div className="customer-toolbar">
        <input
          aria-label="Tìm khách hàng"
          placeholder="Tìm theo tên, email hoặc điện thoại"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select
          aria-label="Vòng đời"
          value={lifecycle}
          onChange={(event) => setLifecycle(event.target.value)}
        >
          <option value="">Mọi vòng đời</option>
          <option>PROSPECT</option>
          <option>CUSTOMER</option>
          <option>INACTIVE</option>
          <option>ARCHIVED</option>
        </select>
      </div>
      <div className="customer-grid">
        <div className="customer-list">
          {customers.data?.data.map((customer) => (
            <Link key={customer.id} to={`/customers/${customer.id}`}>
              <span className={`lifecycle lifecycle-${customer.lifecycle.toLowerCase()}`}>
                {customer.lifecycle}
              </span>
              <h2>{customer.displayName ?? customer.organizationName ?? 'Chưa đặt tên'}</h2>
              <p>{customer.organizationName}</p>
              <small>
                {customer.contacts.map((contact) => contact.value).join(' · ') || 'Chưa có liên hệ'}
              </small>
            </Link>
          ))}
          {!customers.isLoading && !customers.data?.data.length && (
            <p>Chưa có khách hàng phù hợp.</p>
          )}
        </div>
        {workspace.role !== 'VIEWER' && (
          <form className="customer-create" action={createCustomer}>
            <p className="eyebrow">Nhập tay</p>
            <h2>Tạo khách hàng</h2>
            <label>
              Loại
              <select name="type" defaultValue="PERSON">
                <option>PERSON</option>
                <option>ORGANIZATION</option>
              </select>
            </label>
            <label>
              Tên hiển thị
              <input name="displayName" />
            </label>
            <label>
              Tên công ty
              <input name="organizationName" />
            </label>
            <label>
              Email
              <input name="email" type="email" />
            </label>
            <label>
              Điện thoại
              <input name="phone" placeholder="0912345678" />
            </label>
            <label>
              Tags
              <input name="tags" placeholder="vip, website" />
            </label>
            {duplicates.length > 0 && (
              <div className="duplicate-warning">
                {duplicates.map((candidate) => (
                  <Link key={candidate.id} to={`/customers/${candidate.id}`}>
                    {candidate.displayName ?? candidate.organizationName ?? candidate.id}
                  </Link>
                ))}
              </div>
            )}
            {message && (
              <p role="status" className="settings-message">
                {message}
              </p>
            )}
            <button type="submit">
              {confirmedDuplicates ? 'Vẫn tạo hồ sơ' : 'Kiểm tra & tạo'}
            </button>
          </form>
        )}
      </div>
    </section>
  );
}
