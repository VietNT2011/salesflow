import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { apiRequest, ApiClientError } from '../../api/client.js';

export function AcceptInvitationPage() {
  const [params] = useSearchParams();
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const token = params.get('token') ?? '';

  async function accept(formData: FormData) {
    setError('');
    try {
      const displayName = String(formData.get('displayName') ?? '').trim();
      const password = String(formData.get('password') ?? '');
      await apiRequest('/invitations/accept', {
        method: 'POST',
        body: JSON.stringify({
          token,
          ...(displayName ? { displayName } : {}),
          ...(password ? { password } : {}),
        }),
      });
      await navigate('/login');
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : 'Không thể nhận lời mời');
    }
  }

  return (
    <main className="centered-page">
      <section className="auth-card">
        <p className="eyebrow">Lời mời workspace</p>
        <h2>Tham gia đội ngũ</h2>
        <form action={accept}>
          <p>Nếu email chưa có tài khoản, hãy tạo thông tin đăng nhập bên dưới.</p>
          <label>
            Họ tên
            <input name="displayName" minLength={2} />
          </label>
          <label>
            Mật khẩu mới
            <input name="password" type="password" minLength={12} />
          </label>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <button type="submit" disabled={!token}>
            Chấp nhận lời mời
          </button>
        </form>
      </section>
    </main>
  );
}
