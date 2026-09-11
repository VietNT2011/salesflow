import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiClientError, apiRequest } from '../../api/client.js';

interface Interaction {
  id: string;
  type: string;
  origin: string;
  direction: string | null;
  summary: string;
  content: string | null;
  state: string;
  occurredAt: string;
  callDurationSeconds: number | null;
  callOutcome: string | null;
}

export function TimelinePanel({
  workspaceId,
  customerId,
  mayEdit,
}: {
  workspaceId: string;
  customerId: string;
  mayEdit: boolean;
}) {
  const [type, setType] = useState('NOTE');
  const [filter, setFilter] = useState('');
  const [message, setMessage] = useState('');
  const queryClient = useQueryClient();
  const timeline = useQuery({
    queryKey: ['timeline', workspaceId, customerId, filter],
    queryFn: () =>
      apiRequest<{ data: Interaction[] }>(
        `/workspaces/${workspaceId}/customers/${customerId}/interactions?limit=100${filter ? `&type=${filter}` : ''}`,
      ),
  });

  async function create(formData: FormData) {
    const call = type === 'CALL';
    try {
      await apiRequest(`/workspaces/${workspaceId}/customers/${customerId}/interactions`, {
        method: 'POST',
        body: JSON.stringify({
          type,
          origin: call ? 'TELEPHONY' : type === 'EMAIL' ? 'EMAIL' : 'MANUAL',
          direction: call || type === 'EMAIL' ? formData.get('direction') : undefined,
          summary: formData.get('summary'),
          content: String(formData.get('content') ?? '').trim() || undefined,
          callStartedAt: call ? new Date().toISOString() : undefined,
          callDurationSeconds: call ? Number(formData.get('duration')) : undefined,
          callOutcome: call ? formData.get('outcome') : undefined,
          recordingReference:
            call && String(formData.get('recordingReference') ?? '').trim()
              ? formData.get('recordingReference')
              : undefined,
        }),
      });
      await queryClient.invalidateQueries({ queryKey: ['timeline', workspaceId, customerId] });
      setMessage('Đã ghi hoạt động vào timeline.');
    } catch (cause) {
      setMessage(cause instanceof ApiClientError ? cause.message : 'Không thể ghi hoạt động');
    }
  }

  return (
    <div className="profile-grid">
      <article>
        <div className="customer-toolbar">
          <select
            aria-label="Lọc loại hoạt động"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="">Mọi hoạt động</option>
            {['NOTE', 'CALL', 'EMAIL', 'MEETING', 'ORDER_EVENT', 'TICKET_EVENT', 'MESSAGE'].map(
              (value) => (
                <option key={value}>{value}</option>
              ),
            )}
          </select>
        </div>
        <div className="contact-list">
          {timeline.data?.data.map((item) => (
            <div key={item.id}>
              <span>
                {item.type} · {item.origin} {item.direction ?? ''}
              </span>
              <strong>{item.summary}</strong>
              {item.content && <p>{item.content}</p>}
              {item.type === 'CALL' && (
                <small>
                  {item.callDurationSeconds}s · {item.callOutcome}
                </small>
              )}
              <small>
                {item.state} · {new Date(item.occurredAt).toLocaleString('vi-VN')}
              </small>
            </div>
          ))}
          {!timeline.isLoading && !timeline.data?.data.length && <p>Chưa có hoạt động.</p>}
        </div>
      </article>
      {mayEdit && (
        <form className="settings-form" action={create}>
          <h2>Ghi hoạt động</h2>
          <label>
            Loại
            <select value={type} onChange={(event) => setType(event.target.value)}>
              <option>NOTE</option>
              <option>CALL</option>
              <option>EMAIL</option>
              <option>MEETING</option>
            </select>
          </label>
          {(type === 'CALL' || type === 'EMAIL') && (
            <label>
              Hướng
              <select name="direction">
                <option>OUTBOUND</option>
                <option>INBOUND</option>
              </select>
            </label>
          )}
          <label>
            Tóm tắt
            <input name="summary" required />
          </label>
          <label>
            Nội dung
            <textarea name="content" rows={4} />
          </label>
          {type === 'CALL' && (
            <>
              <label>
                Thời lượng (giây)
                <input name="duration" type="number" min="0" required />
              </label>
              <label>
                Kết quả
                <input name="outcome" required />
              </label>
              <label>
                Recording reference bảo mật
                <input name="recordingReference" />
              </label>
            </>
          )}
          <button type="submit">Lưu hoạt động</button>
          {message && <p role="status">{message}</p>}
        </form>
      )}
    </div>
  );
}
