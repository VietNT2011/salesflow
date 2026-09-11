import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { ApiClientError, apiRequest } from '../../api/client.js';

interface Workspace {
  id: string;
  name: string;
  role: string;
}

interface Customer {
  id: string;
  displayName: string | null;
  organizationName: string | null;
}

interface Ticket {
  id: string;
  ticketNumber: string;
  customerId: string;
  subject: string;
  status: string;
  priority: string;
  firstResponseDueAt: string;
  resolutionDueAt: string;
}

interface SlaPolicy {
  id: string;
  priority: string;
  channel: string;
  firstResponseMinutes: number;
  resolutionMinutes: number;
  version: number;
}

const priorities = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;

function deadlineLabel(deadline: string): string {
  const due = new Date(deadline);
  const overdue = due.getTime() < Date.now();
  return `${overdue ? 'Quá hạn' : 'Hạn'} ${due.toLocaleString('vi-VN')}`;
}

export function TicketListPage() {
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const [message, setMessage] = useState('');
  const queryClient = useQueryClient();
  const workspaces = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => apiRequest<{ data: Workspace[] }>('/workspaces'),
  });
  const workspace = workspaces.data?.data[0];
  const customers = useQuery({
    queryKey: ['customers', workspace?.id, 'ticket-picker'],
    enabled: Boolean(workspace),
    queryFn: () =>
      apiRequest<{ data: Customer[] }>(`/workspaces/${workspace?.id}/customers?limit=100`),
  });
  const query = new URLSearchParams({ limit: '100' });
  if (status) query.set('status', status);
  if (priority) query.set('priority', priority);
  const tickets = useQuery({
    queryKey: ['tickets', workspace?.id, status, priority],
    enabled: Boolean(workspace),
    queryFn: () => apiRequest<{ data: Ticket[] }>(`/workspaces/${workspace?.id}/tickets?${query}`),
  });
  const canConfigure = workspace?.role === 'OWNER' || workspace?.role === 'ADMIN';
  const policies = useQuery({
    queryKey: ['sla-policies', workspace?.id],
    enabled: Boolean(workspace && canConfigure),
    queryFn: () => apiRequest<{ data: SlaPolicy[] }>(`/workspaces/${workspace?.id}/sla-policies`),
  });

  async function createTicket(formData: FormData) {
    if (!workspace) return;
    try {
      await apiRequest(`/workspaces/${workspace.id}/tickets`, {
        method: 'POST',
        body: JSON.stringify({
          customerId: formData.get('customerId'),
          subject: formData.get('subject'),
          description: formData.get('description'),
          priority: formData.get('priority'),
          category: String(formData.get('category') ?? '').trim() || undefined,
          sourceChannel: 'MANUAL',
        }),
      });
      await queryClient.invalidateQueries({ queryKey: ['tickets', workspace.id] });
      setMessage('Đã tạo ticket và bắt đầu tính SLA.');
    } catch (cause) {
      setMessage(cause instanceof ApiClientError ? cause.message : 'Không thể tạo ticket');
    }
  }

  async function savePolicy(formData: FormData) {
    if (!workspace) return;
    const selected = policies.data?.data.find(
      (policy) => policy.priority === formData.get('priority') && policy.channel === 'ANY',
    );
    try {
      await apiRequest(`/workspaces/${workspace.id}/sla-policies`, {
        method: 'PUT',
        body: JSON.stringify({
          priority: formData.get('priority'),
          channel: 'ANY',
          firstResponseMinutes: Number(formData.get('firstResponseMinutes')),
          resolutionMinutes: Number(formData.get('resolutionMinutes')),
          businessHours: { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' },
          version: selected?.version,
        }),
      });
      await queryClient.invalidateQueries({ queryKey: ['sla-policies', workspace.id] });
      setMessage('Đã lưu chính sách SLA.');
    } catch (cause) {
      setMessage(cause instanceof ApiClientError ? cause.message : 'Không thể lưu SLA');
    }
  }

  if (!workspace) {
    return (
      <section>
        <p className="eyebrow">Support tickets</p>
        <h1>Chưa có workspace.</h1>
      </section>
    );
  }

  return (
    <section className="customer-page">
      <div className="customer-heading">
        <div>
          <p className="eyebrow">{workspace.name} · ticket & SLA</p>
          <h1>Hàng đợi CSKH.</h1>
        </div>
      </div>
      <div className="customer-toolbar">
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value)}
          aria-label="Trạng thái ticket"
        >
          <option value="">Mọi trạng thái</option>
          <option>NEW</option>
          <option>OPEN</option>
          <option>PENDING_CUSTOMER</option>
          <option>RESOLVED</option>
          <option>CLOSED</option>
        </select>
        <select
          value={priority}
          onChange={(event) => setPriority(event.target.value)}
          aria-label="Mức ưu tiên"
        >
          <option value="">Mọi mức ưu tiên</option>
          {priorities.map((item) => (
            <option key={item}>{item}</option>
          ))}
        </select>
      </div>
      <div className="customer-grid">
        <div className="customer-list">
          {tickets.data?.data.map((ticket) => (
            <Link key={ticket.id} to={`/tickets/${ticket.id}`}>
              <span className={`ticket-priority priority-${ticket.priority.toLowerCase()}`}>
                {ticket.priority} · {ticket.status}
              </span>
              <h2>
                {ticket.ticketNumber} · {ticket.subject}
              </h2>
              <p>
                {customers.data?.data.find((item) => item.id === ticket.customerId)?.displayName ??
                  'Khách hàng'}
              </p>
              <small>{deadlineLabel(ticket.resolutionDueAt)}</small>
            </Link>
          ))}
          {!tickets.isLoading && !tickets.data?.data.length && <p>Không có ticket phù hợp.</p>}
        </div>
        <div>
          {workspace.role !== 'VIEWER' && workspace.role !== 'SALES' && (
            <form className="settings-form" action={createTicket}>
              <h2>Tạo ticket</h2>
              <label>
                Khách hàng
                <select name="customerId" required>
                  <option value="">Chọn khách hàng</option>
                  {customers.data?.data.map((customer) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.displayName ?? customer.organizationName ?? customer.id}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Tiêu đề
                <input name="subject" required />
              </label>
              <label>
                Mô tả
                <textarea name="description" rows={4} required />
              </label>
              <label>
                Ưu tiên
                <select name="priority" defaultValue="NORMAL">
                  {priorities.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </label>
              <label>
                Danh mục
                <input name="category" />
              </label>
              <button type="submit">Tạo ticket</button>
            </form>
          )}
          {canConfigure && (
            <form className="settings-form" action={savePolicy}>
              <h2>SLA giờ làm việc</h2>
              <small>Thứ Hai–Sáu, 09:00–17:00 theo timezone workspace.</small>
              <label>
                Ưu tiên
                <select name="priority" defaultValue="NORMAL">
                  {priorities.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </label>
              <label>
                Phản hồi đầu (phút)
                <input
                  name="firstResponseMinutes"
                  type="number"
                  min="1"
                  defaultValue="60"
                  required
                />
              </label>
              <label>
                Xử lý (phút)
                <input name="resolutionMinutes" type="number" min="1" defaultValue="480" required />
              </label>
              <button type="submit">Lưu SLA</button>
            </form>
          )}
          {message && (
            <p role="status" className="settings-message">
              {message}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
