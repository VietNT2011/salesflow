import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { ApiClientError, apiRequest } from '../../api/client.js';

interface Workspace {
  id: string;
  name: string;
}
interface Conversation {
  id: string;
  customerId: string | null;
  provider: string;
  status: string;
  unreadCount: number;
  lastMessageAt: string | null;
  version: number;
}
interface Message {
  id: string;
  direction: string;
  body: string;
  sentAt: string;
  status: string;
}
interface Detail extends Conversation {
  messages: Message[];
}

export function InboxPage() {
  const [selectedId, setSelectedId] = useState<string>();
  const [notice, setNotice] = useState('');
  const queryClient = useQueryClient();
  const workspaces = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => apiRequest<{ data: Workspace[] }>('/workspaces'),
  });
  const workspace = workspaces.data?.data[0];
  const conversations = useQuery({
    queryKey: ['conversations', workspace?.id],
    enabled: Boolean(workspace),
    queryFn: () =>
      apiRequest<{ data: Conversation[] }>(`/workspaces/${workspace?.id}/conversations`),
  });
  useEffect(() => {
    if (!selectedId && conversations.data?.data[0]) setSelectedId(conversations.data.data[0].id);
  }, [conversations.data, selectedId]);
  const detail = useQuery({
    queryKey: ['conversation', workspace?.id, selectedId],
    enabled: Boolean(workspace && selectedId),
    queryFn: () =>
      apiRequest<{ data: Detail }>(`/workspaces/${workspace?.id}/conversations/${selectedId}`),
  });

  async function reply(formData: FormData) {
    if (!workspace || !selectedId || !detail.data) return;
    try {
      await apiRequest(`/workspaces/${workspace.id}/conversations/${selectedId}/replies`, {
        method: 'POST',
        body: JSON.stringify({
          version: detail.data.data.version,
          message: formData.get('message'),
        }),
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['conversation', workspace.id, selectedId] }),
        queryClient.invalidateQueries({ queryKey: ['conversations', workspace.id] }),
      ]);
      setNotice('Đã gửi phản hồi.');
    } catch (cause) {
      setNotice(cause instanceof ApiClientError ? cause.message : 'Không thể gửi phản hồi');
    }
  }

  if (!workspace)
    return (
      <section>
        <p className="eyebrow">Omnichannel inbox</p>
        <h1>Chưa có workspace.</h1>
      </section>
    );
  return (
    <section className="inbox-page">
      <header className="inbox-heading">
        <div>
          <p className="eyebrow">{workspace.name} · website & webchat</p>
          <h1>Hộp thư chung.</h1>
        </div>
        <Link className="review-link" to="/settings/forms">
          Cấu hình form
        </Link>
      </header>
      <div className="inbox-grid">
        <aside className="conversation-list">
          {(conversations.data?.data ?? []).map((item) => (
            <button
              key={item.id}
              className={selectedId === item.id ? 'selected' : ''}
              onClick={() => setSelectedId(item.id)}
            >
              <strong>{item.provider}</strong>
              <span>
                {item.status} · {item.unreadCount} chưa đọc
              </span>
            </button>
          ))}
          {!conversations.data?.data.length && <p>Chưa có hội thoại.</p>}
        </aside>
        <main className="message-pane">
          {detail.data ? (
            <>
              <div className="message-toolbar">
                <span>
                  {detail.data.data.provider} · {detail.data.data.status}
                </span>
                {detail.data.data.customerId ? (
                  <Link to={`/customers/${detail.data.data.customerId}`}>Mở Customer 360</Link>
                ) : (
                  <strong>Cần duyệt danh tính</strong>
                )}
              </div>
              <div className="message-stream">
                {detail.data.data.messages.map((message) => (
                  <article
                    key={message.id}
                    className={`message-${message.direction.toLowerCase()}`}
                  >
                    <p>{message.body}</p>
                    <small>{new Date(message.sentAt).toLocaleString('vi-VN')}</small>
                  </article>
                ))}
              </div>
              <form action={reply} className="reply-box">
                <textarea name="message" required placeholder="Nhập phản hồi…" />
                <button>Gửi</button>
              </form>
              {notice && <p role="status">{notice}</p>}
            </>
          ) : (
            <p>Chọn một hội thoại để bắt đầu.</p>
          )}
        </main>
      </div>
    </section>
  );
}
