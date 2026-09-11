import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { apiRequest, ApiClientError } from '../../api/client.js';

interface Workspace {
  id: string;
  role: string;
}

interface Contact {
  id: string;
  type: string;
  value: string;
  normalizedValue: string;
  isPrimary: boolean;
}

interface Customer {
  id: string;
  type: string;
  lifecycle: string;
  displayName: string | null;
  organizationName: string | null;
  source: string;
  version: number;
  contacts: Contact[];
  tags: { id: string; name: string }[];
  consents: { id: string; channel: string; status: string }[];
}

interface CustomerOrder {
  id: string;
  status: string;
  currency: string;
  totalMinor: number;
  placedAt: string;
}

interface OrderEvent {
  id: string;
  orderId: string;
  summary: string;
  metadata: { status?: string; totalMinor?: number };
  occurredAt: string;
}

const tabs = ['Overview', 'Timeline', 'Orders', 'Tickets', 'Conversations', 'Tasks'];

export function CustomerProfilePage() {
  const { customerId = '' } = useParams();
  const [activeTab, setActiveTab] = useState('Overview');
  const [message, setMessage] = useState('');
  const queryClient = useQueryClient();
  const workspaces = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => apiRequest<{ data: Workspace[] }>('/workspaces'),
  });
  const workspace = workspaces.data?.data[0];
  const customer = useQuery({
    queryKey: ['customer', workspace?.id, customerId],
    enabled: Boolean(workspace && customerId),
    queryFn: () =>
      apiRequest<{ data: Customer }>(`/workspaces/${workspace?.id}/customers/${customerId}`),
  });
  const profile = customer.data?.data;
  const customerOrders = useQuery({
    queryKey: ['orders', workspace?.id, customerId],
    enabled: Boolean(workspace && customerId && activeTab === 'Orders'),
    queryFn: () =>
      apiRequest<{ data: CustomerOrder[] }>(
        `/workspaces/${workspace?.id}/orders?customerId=${customerId}&limit=100`,
      ),
  });
  const orderEvents = useQuery({
    queryKey: ['order-events', workspace?.id, customerId],
    enabled: Boolean(workspace && customerId && activeTab === 'Timeline'),
    queryFn: () =>
      apiRequest<{ data: OrderEvent[] }>(
        `/workspaces/${workspace?.id}/customers/${customerId}/order-events`,
      ),
  });
  const mayEdit = workspace?.role !== 'VIEWER';
  const mayArchive = ['OWNER', 'ADMIN', 'CS_MANAGER'].includes(workspace?.role ?? '');

  async function run(action: () => Promise<unknown>, success: string) {
    setMessage('');
    try {
      await action();
      await queryClient.invalidateQueries({ queryKey: ['customer', workspace?.id, customerId] });
      setMessage(success);
    } catch (cause) {
      setMessage(cause instanceof ApiClientError ? cause.message : 'Không thể cập nhật khách hàng');
    }
  }

  async function update(formData: FormData) {
    if (!workspace || !profile) return;
    await run(
      () =>
        apiRequest(`/workspaces/${workspace.id}/customers/${profile.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            version: profile.version,
            displayName: String(formData.get('displayName') ?? '').trim() || null,
            organizationName: String(formData.get('organizationName') ?? '').trim() || null,
            lifecycle: formData.get('lifecycle'),
            tagNames: String(formData.get('tags') ?? '')
              .split(',')
              .map((tag) => tag.trim())
              .filter(Boolean),
          }),
        }),
      'Đã cập nhật hồ sơ.',
    );
  }

  async function addContact(formData: FormData) {
    if (!workspace || !profile) return;
    await run(
      () =>
        apiRequest(`/workspaces/${workspace.id}/customers/${profile.id}/contact-points`, {
          method: 'POST',
          body: JSON.stringify({
            version: profile.version,
            contact: {
              type: formData.get('type'),
              value: formData.get('value'),
              country: formData.get('type') === 'PHONE' ? 'VN' : undefined,
              isPrimary: formData.get('isPrimary') === 'on',
            },
          }),
        }),
      'Đã thêm điểm liên hệ.',
    );
  }

  async function toggleArchive() {
    if (!workspace || !profile) return;
    const archived = profile.lifecycle === 'ARCHIVED';
    await run(
      () =>
        apiRequest(
          `/workspaces/${workspace.id}/customers/${profile.id}/${archived ? 'restore' : 'archive'}`,
          { method: 'POST', body: JSON.stringify({ version: profile.version }) },
        ),
      archived ? 'Đã khôi phục hồ sơ.' : 'Đã lưu trữ hồ sơ.',
    );
  }

  if (!profile) {
    return (
      <section>
        <p className="eyebrow">Customer 360</p>
        <h1>{customer.isLoading ? 'Đang tải…' : 'Không tìm thấy khách hàng.'}</h1>
        <Link to="/customers">Quay lại danh sách</Link>
      </section>
    );
  }

  return (
    <section className="customer-profile">
      <Link to="/customers">← Danh sách khách hàng</Link>
      <div className="profile-heading">
        <div>
          <p className="eyebrow">
            {profile.type} · {profile.lifecycle}
          </p>
          <h1>{profile.displayName ?? profile.organizationName ?? 'Chưa đặt tên'}</h1>
          <p>
            {profile.organizationName} · nguồn {profile.source}
          </p>
        </div>
        {mayArchive && (
          <button type="button" onClick={() => void toggleArchive()}>
            {profile.lifecycle === 'ARCHIVED' ? 'Khôi phục' : 'Lưu trữ'}
          </button>
        )}
      </div>
      <nav className="profile-tabs" aria-label="Customer 360 tabs">
        {tabs.map((tab) => (
          <button
            key={tab}
            className={activeTab === tab ? 'active' : ''}
            type="button"
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
      </nav>
      {activeTab === 'Overview' ? (
        <div className="profile-grid">
          <article>
            <h2>Điểm liên hệ</h2>
            <div className="contact-list">
              {profile.contacts.map((contact) => (
                <div key={contact.id}>
                  <span>{contact.type}</span>
                  <strong>{contact.value}</strong>
                  {contact.isPrimary && <small>Primary</small>}
                </div>
              ))}
            </div>
            <h2>Tags</h2>
            <div className="team-list">
              {profile.tags.map((tag) => (
                <span key={tag.id}>{tag.name}</span>
              ))}
            </div>
            <h2>Consent</h2>
            <div className="team-list">
              {profile.consents.map((consent) => (
                <span key={consent.id}>
                  {consent.channel}: {consent.status}
                </span>
              ))}
            </div>
          </article>
          {mayEdit && (
            <div>
              <form className="settings-form" action={update}>
                <h2>Sửa hồ sơ</h2>
                <label>
                  Tên hiển thị
                  <input name="displayName" defaultValue={profile.displayName ?? ''} />
                </label>
                <label>
                  Công ty
                  <input name="organizationName" defaultValue={profile.organizationName ?? ''} />
                </label>
                <label>
                  Vòng đời
                  <select
                    name="lifecycle"
                    defaultValue={profile.lifecycle === 'ARCHIVED' ? 'INACTIVE' : profile.lifecycle}
                  >
                    <option>PROSPECT</option>
                    <option>CUSTOMER</option>
                    <option>INACTIVE</option>
                  </select>
                </label>
                <label>
                  Tags
                  <input
                    name="tags"
                    defaultValue={profile.tags.map((tag) => tag.name).join(', ')}
                  />
                </label>
                <button type="submit">Lưu thay đổi</button>
              </form>
              <form className="settings-form" action={addContact}>
                <h2>Thêm liên hệ</h2>
                <label>
                  Loại
                  <select name="type">
                    <option>EMAIL</option>
                    <option>PHONE</option>
                    <option>ADDRESS</option>
                  </select>
                </label>
                <label>
                  Giá trị
                  <input name="value" required />
                </label>
                <label className="checkbox-label">
                  <input name="isPrimary" type="checkbox" /> Đặt làm primary
                </label>
                <button type="submit">Thêm liên hệ</button>
              </form>
              {message && (
                <p role="status" className="settings-message">
                  {message}
                </p>
              )}
            </div>
          )}
        </div>
      ) : activeTab === 'Orders' ? (
        <article className="empty-tab">
          <p className="eyebrow">Orders</p>
          <div className="contact-list">
            {customerOrders.data?.data.map((order) => (
              <Link key={order.id} to={`/orders/${order.id}`}>
                <strong>{order.status}</strong>
                <span>
                  {order.totalMinor.toLocaleString('vi-VN')} {order.currency} minor units
                </span>
                <small>{new Date(order.placedAt).toLocaleString('vi-VN')}</small>
              </Link>
            ))}
            {!customerOrders.isLoading && !customerOrders.data?.data.length && (
              <p>Khách hàng chưa có đơn hàng.</p>
            )}
          </div>
        </article>
      ) : activeTab === 'Timeline' ? (
        <article className="empty-tab">
          <p className="eyebrow">Timeline · order events</p>
          <div className="contact-list">
            {orderEvents.data?.data.map((event) => (
              <Link key={event.id} to={`/orders/${event.orderId}`}>
                <strong>{event.summary}</strong>
                <span>{event.metadata.status}</span>
                <small>{new Date(event.occurredAt).toLocaleString('vi-VN')}</small>
              </Link>
            ))}
            {!orderEvents.isLoading && !orderEvents.data?.data.length && (
              <p>Chưa có sự kiện đơn hàng.</p>
            )}
          </div>
        </article>
      ) : (
        <article className="empty-tab">
          <p className="eyebrow">{activeTab}</p>
          <h2>Sẽ nối dữ liệu ở feature tương ứng.</h2>
        </article>
      )}
    </section>
  );
}
