import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ApiClientError, apiRequest } from '../../api/client.js';

interface Workspace {
  id: string;
  role: string;
}

interface OrderLine {
  id: string;
  skuSnapshot: string;
  nameSnapshot: string;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
}

interface Order {
  id: string;
  customerId: string;
  status: string;
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  version: number;
  lines: OrderLine[];
}

export function OrderDetailPage() {
  const { orderId = '' } = useParams();
  const [message, setMessage] = useState('');
  const queryClient = useQueryClient();
  const workspaces = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => apiRequest<{ data: Workspace[] }>('/workspaces'),
  });
  const workspace = workspaces.data?.data[0];
  const order = useQuery({
    queryKey: ['order', workspace?.id, orderId],
    enabled: Boolean(workspace && orderId),
    queryFn: () => apiRequest<{ data: Order }>(`/workspaces/${workspace?.id}/orders/${orderId}`),
  });
  const detail = order.data?.data;

  async function transition(formData: FormData) {
    if (!workspace || !detail) return;
    try {
      await apiRequest(`/workspaces/${workspace.id}/orders/${detail.id}/status`, {
        method: 'POST',
        body: JSON.stringify({
          version: detail.version,
          status: formData.get('status'),
          reason: String(formData.get('reason') ?? '').trim() || undefined,
        }),
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['order', workspace.id, orderId] }),
        queryClient.invalidateQueries({ queryKey: ['orders', workspace.id] }),
      ]);
      setMessage('Đã chuyển trạng thái đơn hàng.');
    } catch (cause) {
      setMessage(cause instanceof ApiClientError ? cause.message : 'Không thể chuyển trạng thái');
    }
  }

  if (!detail) {
    return (
      <section>
        <p className="eyebrow">Order detail</p>
        <h1>{order.isLoading ? 'Đang tải…' : 'Không tìm thấy đơn hàng.'}</h1>
      </section>
    );
  }

  const format = (minor: number) =>
    new Intl.NumberFormat('vi-VN', { style: 'currency', currency: detail.currency }).format(
      detail.currency === 'VND' ? minor : minor / 100,
    );
  return (
    <section className="customer-profile">
      <Link to="/orders">← Danh sách đơn hàng</Link>
      <div className="profile-heading">
        <div>
          <p className="eyebrow">{detail.status}</p>
          <h1>{format(detail.totalMinor)}</h1>
          <Link to={`/customers/${detail.customerId}`}>Mở Customer 360</Link>
        </div>
      </div>
      <article>
        <h2>Line-item snapshot</h2>
        <div className="contact-list">
          {detail.lines.map((line) => (
            <div key={line.id}>
              <span>{line.skuSnapshot}</span>
              <strong>{line.nameSnapshot}</strong>
              <small>
                {line.quantity} × {format(line.unitPriceMinor)} = {format(line.lineTotalMinor)}
              </small>
            </div>
          ))}
        </div>
        <p>
          Tạm tính {format(detail.subtotalMinor)} · giảm {format(detail.discountMinor)} · tổng{' '}
          <strong>{format(detail.totalMinor)}</strong>
        </p>
      </article>
      {workspace && workspace.role !== 'VIEWER' && workspace.role !== 'AGENT' && (
        <form className="settings-form" action={transition}>
          <h2>Chuyển trạng thái</h2>
          <select name="status">
            <option>CONFIRMED</option>
            <option>FULFILLED</option>
            <option>CANCELLED</option>
            <option>REFUNDED</option>
          </select>
          <input name="reason" placeholder="Lý do (bắt buộc khi hủy/hoàn tiền)" />
          <button type="submit">Cập nhật</button>
        </form>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
