import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ApiClientError, apiRequest } from '../../api/client.js';

interface Workspace {
  id: string;
  role: string;
}
interface Member {
  id: string;
  displayName: string;
  status: string;
}
interface Team {
  id: string;
  name: string;
}
interface Reply {
  id: string;
  direction: string;
  content: string;
  createdAt: string;
}
interface Ticket {
  id: string;
  ticketNumber: string;
  customerId: string;
  subject: string;
  description: string;
  status: string;
  priority: string;
  ownerMembershipId: string | null;
  teamId: string | null;
  category: string | null;
  firstRespondedAt: string | null;
  firstResponseDueAt: string;
  resolutionDueAt: string;
  resolutionSummary: string | null;
  reopenCount: number;
  version: number;
  replies: Reply[];
  sla: { firstResponseBreached: boolean; resolutionBreached: boolean };
}

export function TicketDetailPage() {
  const { ticketId = '' } = useParams();
  const [message, setMessage] = useState('');
  const queryClient = useQueryClient();
  const workspaces = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => apiRequest<{ data: Workspace[] }>('/workspaces'),
  });
  const workspace = workspaces.data?.data[0];
  const ticket = useQuery({
    queryKey: ['ticket', workspace?.id, ticketId],
    enabled: Boolean(workspace && ticketId),
    queryFn: () => apiRequest<{ data: Ticket }>(`/workspaces/${workspace?.id}/tickets/${ticketId}`),
  });
  const members = useQuery({
    queryKey: ['members', workspace?.id],
    enabled: Boolean(workspace),
    queryFn: () => apiRequest<{ data: Member[] }>(`/workspaces/${workspace?.id}/members`),
  });
  const teams = useQuery({
    queryKey: ['teams', workspace?.id],
    enabled: Boolean(workspace),
    queryFn: () => apiRequest<{ data: Team[] }>(`/workspaces/${workspace?.id}/teams`),
  });
  const detail = ticket.data?.data;
  const canManage = ['OWNER', 'ADMIN', 'CS_MANAGER'].includes(workspace?.role ?? '');
  const canAct = !['VIEWER', 'SALES'].includes(workspace?.role ?? '');

  async function mutate(path: string, body: object, success: string, method = 'POST') {
    if (!workspace) return;
    try {
      await apiRequest(`/workspaces/${workspace.id}/tickets/${ticketId}${path}`, {
        method,
        body: JSON.stringify(body),
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['ticket', workspace.id, ticketId] }),
        queryClient.invalidateQueries({ queryKey: ['tickets', workspace.id] }),
      ]);
      setMessage(success);
    } catch (cause) {
      setMessage(cause instanceof ApiClientError ? cause.message : 'Không thể cập nhật ticket');
    }
  }

  async function reply(formData: FormData) {
    if (!detail) return;
    await mutate(
      '/replies',
      { version: detail.version, direction: 'OUTBOUND', content: formData.get('content') },
      'Đã gửi phản hồi.',
    );
  }

  async function transition(formData: FormData) {
    if (!detail) return;
    await mutate(
      '/status',
      {
        version: detail.version,
        status: formData.get('status'),
        resolutionSummary: String(formData.get('resolutionSummary') ?? '').trim() || undefined,
        reason: String(formData.get('reason') ?? '').trim() || undefined,
      },
      'Đã chuyển trạng thái ticket.',
    );
  }

  async function assign(formData: FormData) {
    if (!detail) return;
    await mutate(
      '',
      {
        version: detail.version,
        ownerMembershipId: String(formData.get('ownerMembershipId') ?? '') || null,
        teamId: String(formData.get('teamId') ?? '') || null,
        priority: formData.get('priority'),
        category: String(formData.get('category') ?? '').trim() || null,
      },
      'Đã cập nhật phân công.',
      'PATCH',
    );
  }

  if (!detail || !workspace) {
    return (
      <section>
        <p className="eyebrow">Ticket detail</p>
        <h1>{ticket.isLoading ? 'Đang tải…' : 'Không tìm thấy ticket.'}</h1>
        <Link to="/tickets">Quay lại hàng đợi</Link>
      </section>
    );
  }

  const responseBreached = detail.sla.firstResponseBreached;
  const resolutionBreached = detail.sla.resolutionBreached;
  return (
    <section className="customer-profile">
      <Link to="/tickets">← Hàng đợi ticket</Link>
      <div className="profile-heading">
        <div>
          <p className="eyebrow">
            {detail.ticketNumber} · {detail.priority} · {detail.status}
          </p>
          <h1>{detail.subject}</h1>
          <Link to={`/customers/${detail.customerId}`}>Mở Customer 360</Link>
        </div>
        <div className="sla-stack">
          <span className={responseBreached ? 'sla-breached' : 'sla-ok'}>
            Phản hồi:{' '}
            {detail.firstRespondedAt
              ? 'đã đáp ứng'
              : new Date(detail.firstResponseDueAt).toLocaleString('vi-VN')}
          </span>
          <span className={resolutionBreached ? 'sla-breached' : 'sla-ok'}>
            Xử lý: {new Date(detail.resolutionDueAt).toLocaleString('vi-VN')}
          </span>
        </div>
      </div>
      <div className="ticket-detail-grid">
        <div>
          <article className="empty-tab">
            <h2>Nội dung</h2>
            <p>{detail.description}</p>
            {detail.resolutionSummary && (
              <p>
                <strong>Kết quả:</strong> {detail.resolutionSummary}
              </p>
            )}
          </article>
          <article className="empty-tab ticket-thread">
            <h2>Trao đổi</h2>
            {detail.replies.map((item) => (
              <div key={item.id} className={`ticket-reply ${item.direction.toLowerCase()}`}>
                <span>
                  {item.direction} · {new Date(item.createdAt).toLocaleString('vi-VN')}
                </span>
                <p>{item.content}</p>
              </div>
            ))}
            {!detail.replies.length && <p>Chưa có phản hồi.</p>}
          </article>
          {canAct && (
            <form className="settings-form" action={reply}>
              <h2>Phản hồi khách hàng</h2>
              <textarea name="content" rows={4} required />
              <button type="submit">Gửi phản hồi</button>
            </form>
          )}
        </div>
        <div>
          {canAct && (
            <form className="settings-form" action={transition}>
              <h2>Trạng thái</h2>
              <select name="status" defaultValue={detail.status}>
                <option>NEW</option>
                <option>OPEN</option>
                <option>PENDING_CUSTOMER</option>
                <option>RESOLVED</option>
                <option>CLOSED</option>
              </select>
              <textarea
                name="resolutionSummary"
                placeholder="Kết quả xử lý (bắt buộc khi resolved)"
              />
              <input name="reason" placeholder="Lý do reopen/manager override" />
              <button type="submit">Cập nhật trạng thái</button>
            </form>
          )}
          {canManage && (
            <form className="settings-form" action={assign}>
              <h2>Phân công</h2>
              <label>
                Agent
                <select name="ownerMembershipId" defaultValue={detail.ownerMembershipId ?? ''}>
                  <option value="">Chưa gán</option>
                  {members.data?.data
                    .filter((item) => item.status === 'ACTIVE')
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.displayName}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Team
                <select name="teamId" defaultValue={detail.teamId ?? ''}>
                  <option value="">Chưa gán</option>
                  {teams.data?.data.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Ưu tiên
                <select name="priority" defaultValue={detail.priority}>
                  <option>LOW</option>
                  <option>NORMAL</option>
                  <option>HIGH</option>
                  <option>URGENT</option>
                </select>
              </label>
              <label>
                Danh mục
                <input name="category" defaultValue={detail.category ?? ''} />
              </label>
              <button type="submit">Lưu phân công</button>
            </form>
          )}
          <p className="ticket-meta">Đã mở lại {detail.reopenCount} lần.</p>
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
