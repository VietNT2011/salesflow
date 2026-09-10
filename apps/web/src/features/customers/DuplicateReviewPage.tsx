import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { apiRequest, ApiClientError } from '../../api/client.js';

interface Workspace {
  id: string;
}
interface Review {
  id: string;
  reason: string;
  candidateCustomerIds: string[];
}

export function DuplicateReviewPage() {
  const [message, setMessage] = useState('');
  const queryClient = useQueryClient();
  const workspaces = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => apiRequest<{ data: Workspace[] }>('/workspaces'),
  });
  const workspace = workspaces.data?.data[0];
  const reviews = useQuery({
    queryKey: ['customer-duplicate-reviews', workspace?.id],
    enabled: Boolean(workspace),
    queryFn: () =>
      apiRequest<{ data: Review[] }>(`/workspaces/${workspace?.id}/customer-duplicate-reviews`),
  });

  async function merge(formData: FormData) {
    if (!workspace) return;
    setMessage('');
    try {
      await apiRequest(`/workspaces/${workspace.id}/customers/merge`, {
        method: 'POST',
        body: JSON.stringify({
          survivorCustomerId: formData.get('survivorCustomerId'),
          survivorVersion: Number(formData.get('survivorVersion')),
          mergedCustomerId: formData.get('mergedCustomerId'),
          mergedVersion: Number(formData.get('mergedVersion')),
          reason: formData.get('reason'),
        }),
      });
      setMessage('Đã hợp nhất hồ sơ và lưu merge log.');
      await queryClient.invalidateQueries({
        queryKey: ['customer-duplicate-reviews', workspace.id],
      });
    } catch (cause) {
      setMessage(cause instanceof ApiClientError ? cause.message : 'Không thể hợp nhất hồ sơ');
    }
  }

  return (
    <section className="customer-page">
      <Link to="/customers">← Danh sách khách hàng</Link>
      <p className="eyebrow">Identity resolution</p>
      <h1>Review trùng lặp.</h1>
      <div className="review-grid">
        <article>
          <h2>Hàng chờ</h2>
          {reviews.data?.data.map((review) => (
            <div className="review-item" key={review.id}>
              <strong>{review.reason}</strong>
              {review.candidateCustomerIds.map((id) => (
                <Link key={id} to={`/customers/${id}`}>
                  {id}
                </Link>
              ))}
            </div>
          ))}
          {!reviews.data?.data.length && <p>Không có identity cần review.</p>}
        </article>
        <form className="settings-form" action={merge}>
          <h2>Xác nhận merge</h2>
          <label>
            Customer giữ lại
            <input name="survivorCustomerId" required />
          </label>
          <label>
            Version giữ lại
            <input name="survivorVersion" type="number" min="1" required />
          </label>
          <label>
            Customer được gộp
            <input name="mergedCustomerId" required />
          </label>
          <label>
            Version được gộp
            <input name="mergedVersion" type="number" min="1" required />
          </label>
          <label>
            Lý do
            <textarea name="reason" required minLength={3} />
          </label>
          <button type="submit">Merge có audit</button>
          {message && (
            <p role="status" className="settings-message">
              {message}
            </p>
          )}
        </form>
      </div>
    </section>
  );
}
